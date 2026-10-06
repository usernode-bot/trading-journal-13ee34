const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// CSV imports send up to 1000 trades in one body, more than the default
// 100 kB. Registered first so the global parser below skips this body.
app.use('/api/trades/import', express.json({ limit: '2mb' }));
app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ---- Language preference ----------------------------------------------------
// Codes are the same set public/i18n.js ships; the frontend falls back to its
// default when a stored code is unknown (e.g. after a language removal).
const LANG_CODES = [
  'id', 'en', 'es', 'fr', 'de', 'pt', 'ru', 'zh-CN', 'zh-TW', 'ja',
  'ko', 'ar', 'hi', 'tr', 'it', 'nl', 'pl', 'th', 'vi', 'ms',
];

app.get('/api/prefs', (req, res) => {
  pool.query('SELECT language FROM user_prefs WHERE user_id = $1', [req.user.id])
    .then(({ rows }) => res.json({ language: rows[0]?.language || 'id' }))
    .catch(() => res.status(500).json({ error: 'Gagal memuat preferensi' }));
});

app.put('/api/prefs', (req, res) => {
  const language = req.body && req.body.language;
  if (!LANG_CODES.includes(language)) return res.status(400).json({ error: 'Kode bahasa tidak valid' });
  pool.query(
    `INSERT INTO user_prefs (user_id, language) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET language = $2, updated_at = NOW()`,
    [req.user.id, language]
  )
    .then(() => res.json({ language }))
    .catch(() => res.status(500).json({ error: 'Gagal menyimpan preferensi' }));
});

// ---- Profil -----------------------------------------------------------------
// The platform only tells the app who a user is (id + username). Everything
// else on the profile page — display name, email, WhatsApp, avatar — is the
// user's own content, stored here per user and edited via PUT. Personal
// information, so the table is private. Derived numbers (stats, member
// since) are computed, never stored.
const DEMO_PROFILE = {
  username: 'staging-demo-user',
  display_name: 'Staging demo: Profil',
  email: 'demo@staging.local',
  whatsapp: null,
  avatar_url: null,
  avatar_id: null,
  member_since: '2026-01-05',
  demo: true,
};

function cleanProfile(body) {
  const b = body || {};
  const p = {};
  const name = typeof b.display_name === 'string' ? b.display_name.trim().slice(0, 60) : '';
  p.display_name = name || null;
  const email = typeof b.email === 'string' ? b.email.trim().slice(0, 120) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email tidak valid');
  p.email = email || null;
  const wa = typeof b.whatsapp === 'string' ? b.whatsapp.replace(/[\s.\-()]/g, '') : '';
  if (!wa) p.whatsapp = null;
  else {
    const m = /^(\+?62|0)(8\d{7,12})$/.exec(wa);
    if (!m) throw new Error('Nomor WhatsApp tidak valid');
    p.whatsapp = '+62' + m[2];
  }
  p.avatar_url = cleanShotUrl(b.avatar_url);
  p.avatar_id = typeof b.avatar_id === 'string' && b.avatar_id.length <= 64
    ? b.avatar_id.trim() || null : null;
  return p;
}

app.get('/api/profile', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') return res.json({ profile: DEMO_PROFILE, demo: true });
  try {
    const [saved, firsts] = await Promise.all([
      pool.query(
        'SELECT display_name, email, whatsapp, avatar_url, avatar_id, created_at FROM user_profiles WHERE user_id = $1',
        [req.user.id]
      ),
      pool.query(
        `SELECT (SELECT MIN(created_at) FROM trades WHERE user_id = $1) AS first_trade,
                (SELECT MIN(created_at) FROM accounts WHERE user_id = $1) AS first_account`,
        [req.user.id]
      ),
    ]);
    const row = saved.rows[0];
    const first = firsts.rows[0] || {};
    // "Sejak" is the earliest real activity: first trade or account, falling
    // back to when the profile was first saved. Never an upsert on GET.
    const candidates = [first.first_trade, first.first_account, row && row.created_at]
      .filter(Boolean)
      .map(d => d.getTime());
    res.json({
      profile: {
        username: req.user.username,
        display_name: row ? row.display_name : null,
        email: row ? row.email : null,
        whatsapp: row ? row.whatsapp : null,
        avatar_url: row ? row.avatar_url : null,
        avatar_id: row ? row.avatar_id : null,
        member_since: candidates.length
          ? new Date(Math.min(...candidates)).toISOString().slice(0, 10)
          : null,
      },
    });
  } catch (err) {
    console.error('load profile failed', err);
    res.status(500).json({ error: 'Gagal memuat profil' });
  }
});

app.put('/api/profile', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') return res.json({ profile: DEMO_PROFILE, demo: true });
  let p;
  try { p = cleanProfile(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    await pool.query(
      `INSERT INTO user_profiles (user_id, username, display_name, email, whatsapp, avatar_url, avatar_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         username = $2, display_name = $3, email = $4, whatsapp = $5,
         avatar_url = $6, avatar_id = $7, updated_at = NOW()`,
      [req.user.id, req.user.username, p.display_name, p.email, p.whatsapp, p.avatar_url, p.avatar_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('save profile failed', err);
    res.status(500).json({ error: 'Gagal menyimpan profil' });
  }
});

// ---- Berita pasar -------------------------------------------------------------
// Shared, admin-curated market news (economic calendar items and headlines)
// that can move the prices of the listed symbols. Public content: every
// signed-in user reads it, only the app's admins (dapp.json `admins`) write.
// Derived numbers (related trades, journal markers) are computed in the
// frontend from these rows plus the user's trades — never stored here.
const NEWS_EDITORS = new Set(['ocank14']);
const NEWS_CATEGORIES = ['ekonomi', 'forex', 'saham', 'kripto'];
const NEWS_SENTIMENTS = ['bullish', 'bearish', 'netral'];
const NEWS_IMPORTANCE = ['tinggi', 'sedang', 'rendah'];

const NEWS_COLUMNS = `id, title, summary, category, symbols, sentiment, importance,
  to_char(event_date, 'YYYY-MM-DD') AS event_date, to_char(event_time, 'HH24:MI') AS event_time,
  source_url, created_by, created_at`;

function cleanNews(body) {
  const b = body || {};
  const n = {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) throw new Error('Judul wajib diisi');
  n.title = title.slice(0, 200);
  n.summary = typeof b.summary === 'string' && b.summary.trim() ? b.summary.trim().slice(0, 2000) : null;
  if (!NEWS_CATEGORIES.includes(b.category)) throw new Error('Kategori tidak valid');
  n.category = b.category;
  if (!NEWS_SENTIMENTS.includes(b.sentiment)) throw new Error('Sentimen tidak valid');
  n.sentiment = b.sentiment;
  if (!NEWS_IMPORTANCE.includes(b.importance)) throw new Error('Tingkat kepentingan tidak valid');
  n.importance = b.importance;
  if (!Array.isArray(b.symbols)) throw new Error('Simbol tidak valid');
  const symbols = [...new Set(b.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  if (symbols.some(s => s.length > 20)) throw new Error('Simbol tidak valid');
  if (symbols.length > 10) throw new Error('Maksimal 10 simbol');
  n.symbols = symbols;
  if (typeof b.event_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.event_date)) {
    throw new Error('Tanggal wajib diisi');
  }
  n.event_date = b.event_date;
  const time = b.event_time;
  if (time === null || time === undefined || time === '') n.event_time = null;
  else if (typeof time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(time)) n.event_time = time;
  else throw new Error('Jam tidak valid');
  const url = typeof b.source_url === 'string' ? b.source_url.trim() : '';
  if (url && !/^https?:\/\//.test(url)) throw new Error('URL sumber tidak valid');
  n.source_url = url ? url.slice(0, 500) : null;
  return n;
}

app.get('/api/news', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${NEWS_COLUMNS} FROM news_items
       ORDER BY event_date DESC, event_time DESC NULLS LAST, id DESC LIMIT 100`
    );
    res.json({ news: rows, canEdit: NEWS_EDITORS.has(req.user.username) });
  } catch (err) {
    console.error('list news failed', err);
    res.status(500).json({ error: 'Gagal memuat berita' });
  }
});

app.post('/api/news', async (req, res) => {
  if (!NEWS_EDITORS.has(req.user.username)) return res.status(403).json({ error: 'Tidak diizinkan' });
  let n;
  try { n = cleanNews(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const { rows } = await pool.query(
      `INSERT INTO news_items (title, summary, category, symbols, sentiment, importance, event_date, event_time, source_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${NEWS_COLUMNS}`,
      [n.title, n.summary, n.category, n.symbols, n.sentiment, n.importance, n.event_date, n.event_time, n.source_url, req.user.username]
    );
    res.status(201).json({ news: rows[0] });
  } catch (err) {
    console.error('create news failed', err);
    res.status(500).json({ error: 'Gagal menyimpan berita' });
  }
});

app.delete('/api/news/:id', async (req, res) => {
  if (!NEWS_EDITORS.has(req.user.username)) return res.status(403).json({ error: 'Tidak diizinkan' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Berita tidak ditemukan' });
  try {
    const { rowCount } = await pool.query('DELETE FROM news_items WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Berita tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete news failed', err);
    res.status(500).json({ error: 'Gagal menghapus berita' });
  }
});

// ---- Trades -----------------------------------------------------------------
// Every field except date and instrument is optional, so a quick entry can be
// completed later. Derived numbers (risk %, R, RR, discipline) are computed in
// the frontend from these stored values, never stored themselves.
const CATEGORIES = ['forex', 'saham', 'kripto'];
const POSITIONS = ['buy', 'sell'];
const EMOTIONS = ['tenang', 'fomo', 'takut', 'serakah', 'balas_dendam', 'ragu', 'bosan'];
const MISTAKES = ['entry_terlalu_cepat', 'sl_digeser', 'tp_dipotong', 'overtrade', 'melanggar_risiko', 'tanpa_setup'];
// Pre-trade checklist steps, same values as the form's checkboxes.
const CHECKLIST = ['setup', 'risk', 'rr', 'sl', 'day'];
const NUMERIC_FIELDS = ['entry_price', 'stop_loss', 'take_profit', 'exit_price', 'lot_size', 'capital', 'risk_amount', 'result_amount'];
const TEXT_FIELDS = { instrument: 40, setup: 200, timeframe: 20, entry_reason: 2000, lesson: 2000 };

const TRADE_COLUMNS = `id, to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
  to_char(entry_time, 'HH24:MI') AS entry_time, to_char(exit_time, 'HH24:MI') AS exit_time,
  instrument, category, position, entry_price, stop_loss, take_profit, exit_price,
  lot_size, capital, risk_amount, setup, timeframe, entry_reason, emotion,
  followed_plan, mistakes, checklist, lesson, result_amount, account_id, screenshot_url, screenshot_id,
  created_at`;

function cleanNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) >= 1e12) throw new Error('Angka tidak valid');
  return n;
}

function cleanId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Screenshot uploads live in the platform's file storage; the trade carries
// only the returned URL (never image bytes). Accept https/http and the
// platform's own relative /app-files/ shape, capped in length.
function cleanShotUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 512 || /\s/.test(s)) return null;
  return /^(https?:\/\/|\/)/.test(s) ? s : null;
}

function cleanTrade(body) {
  const b = body || {};
  const t = {};
  if (typeof b.trade_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.trade_date)) {
    throw new Error('Tanggal wajib diisi');
  }
  t.trade_date = b.trade_date;
  for (const key of ['entry_time', 'exit_time']) {
    const v = b[key];
    if (v === null || v === undefined || v === '') t[key] = null;
    else if (typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v)) t[key] = v;
    else throw new Error('Jam tidak valid');
  }
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    const v = typeof b[key] === 'string' ? b[key].trim().slice(0, max) : '';
    t[key] = v || null;
  }
  if (!t.instrument) throw new Error('Instrumen wajib diisi');
  t.instrument = t.instrument.toUpperCase();
  t.category = CATEGORIES.includes(b.category) ? b.category : null;
  t.position = POSITIONS.includes(b.position) ? b.position : null;
  t.emotion = EMOTIONS.includes(b.emotion) ? b.emotion : null;
  t.followed_plan = typeof b.followed_plan === 'boolean' ? b.followed_plan : null;
  t.mistakes = Array.isArray(b.mistakes) ? MISTAKES.filter(m => b.mistakes.includes(m)) : [];
  t.checklist = Array.isArray(b.checklist) ? CHECKLIST.filter(c => b.checklist.includes(c)) : [];
  for (const key of NUMERIC_FIELDS) t[key] = cleanNumber(b[key]);
  // A trade can point at one of the user's own accounts; the handlers verify
  // ownership against the accounts table before anything is written.
  t.account_id = cleanId(b.account_id);
  t.screenshot_url = cleanShotUrl(b.screenshot_url);
  t.screenshot_id = typeof b.screenshot_id === 'string' && b.screenshot_id.length <= 64
    ? b.screenshot_id.trim() || null : null;
  return t;
}

const WRITE_FIELDS = ['trade_date', 'entry_time', 'exit_time', 'instrument', 'category', 'position',
  ...NUMERIC_FIELDS, 'setup', 'timeframe', 'entry_reason', 'emotion', 'followed_plan', 'mistakes', 'checklist', 'lesson',
  'account_id', 'screenshot_url', 'screenshot_id'];

// Read-only demo trades for staging previews (?demo=1). Never written to the
// database and never attributed to the visitor. The last row is dated "today"
// at load time so features keyed on the current day (the daily-loss alert,
// today's calendar cell) are visible in a preview.
const demoToday = new Date().toISOString().slice(0, 10);
const DEMO_TRADES = [
  { id: -1, trade_date: '2026-09-29', entry_time: '14:05', exit_time: '16:40', instrument: 'EURUSD', category: 'forex', position: 'buy',
    entry_price: '1.0850', stop_loss: '1.0830', take_profit: '1.0900', exit_price: '1.0900', lot_size: '0.1', capital: '2500',
    risk_amount: null, setup: 'Staging demo: breakout', timeframe: 'H1', entry_reason: 'Staging demo trade, retest support', emotion: 'tenang',
    followed_plan: true, mistakes: [], lesson: 'Staging demo: sabar menunggu retest', result_amount: '50', account_id: -1, demo: true },
  { id: -2, trade_date: '2026-09-30', entry_time: '09:15', exit_time: '09:50', instrument: 'BBCA', category: 'saham', position: 'buy',
    entry_price: '9500', stop_loss: '9300', take_profit: '9800', exit_price: '9350', lot_size: '10', capital: '15000',
    risk_amount: '200', setup: 'Staging demo: pullback', timeframe: 'M15', entry_reason: 'Staging demo trade', emotion: 'fomo',
    followed_plan: false, mistakes: ['entry_terlalu_cepat', 'melanggar_risiko'], lesson: 'Staging demo: jangan kejar harga', result_amount: '-150', account_id: -2, demo: true },
  { id: -3, trade_date: '2026-10-01', entry_time: '20:00', exit_time: null, instrument: 'BTCUSDT', category: 'kripto', position: 'sell',
    entry_price: '62000', stop_loss: null, take_profit: '60000', exit_price: null, lot_size: '0.01', capital: '2000',
    risk_amount: null, setup: null, timeframe: 'H4', entry_reason: null, emotion: 'ragu',
    followed_plan: null, mistakes: ['tanpa_setup'], lesson: null, result_amount: null, account_id: null, demo: true },
  { id: -4, trade_date: demoToday, entry_time: '21:10', exit_time: '21:40', instrument: 'XAUUSD', category: 'forex', position: 'sell',
    entry_price: '2650', stop_loss: '2655', take_profit: '2630', exit_price: '2660', lot_size: '0.1', capital: '2500',
    risk_amount: null, setup: 'Staging demo: fade berita', timeframe: 'M5', entry_reason: 'Staging demo trade lewat batas rugi', emotion: 'balas_dendam',
    followed_plan: false, mistakes: ['melanggar_risiko'], lesson: 'Staging demo: berhenti setelah batas rugi harian',
    result_amount: '-60', account_id: -1, demo: true },
];

// Read-only demo accounts for staging previews (?demo=1), matched to the demo
// trades above. Never written to the database and never attributed to the
// visitor.
const DEMO_ACCOUNTS = [
  { id: -1, name: 'Staging demo: Akun forex', starting_balance: '2500', daily_loss_limit: '50',
    market_limits: { forex: 1, kripto: 2 }, demo: true },
  { id: -2, name: 'Staging demo: Akun saham', starting_balance: '15000', daily_loss_limit: '300',
    market_limits: {}, demo: true },
];

app.get('/api/trades', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') return res.json({ trades: DEMO_TRADES, demo: true });
  try {
    const { rows } = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1
       ORDER BY trade_date DESC, entry_time DESC NULLS LAST, id DESC LIMIT 500`,
      [req.user.id]
    );
    res.json({ trades: rows });
  } catch (err) {
    console.error('list trades failed', err);
    res.status(500).json({ error: 'Gagal memuat trade' });
  }
});

function insertSql(extra) {
  const cols = ['user_id', 'username', ...WRITE_FIELDS, ...extra];
  return `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`;
}

app.post('/api/trades', async (req, res) => {
  let t;
  try { t = cleanTrade(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    t.account_id = await ownAccountId(req.user.id, t.account_id);
    const vals = [req.user.id, req.user.username, ...WRITE_FIELDS.map(f => t[f])];
    const { rows } = await pool.query(`${insertSql([])} RETURNING ${TRADE_COLUMNS}`, vals);
    res.status(201).json({ trade: rows[0] });
  } catch (err) {
    console.error('create trade failed', err);
    res.status(500).json({ error: 'Gagal menyimpan trade' });
  }
});

// ---- CSV import ---------------------------------------------------------------
// The browser parses the CSV and maps columns; this route revalidates every
// row with cleanTrade() and classifies it as new, duplicate or invalid. A
// duplicate has the same broker ticket as a stored trade, or the same
// fingerprint (date, instrument, position, entry time, entry price, lot), or
// repeats an earlier row of the same file. dryRun only classifies.
const IMPORT_MAX_ROWS = 1000;

function sameNum(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a == null && b == null;
  return Number(a) === Number(b);
}

function fingerprint(t) {
  if (t.entry_price === null || t.entry_price === undefined) return null;
  const time = t.entry_time ? String(t.entry_time).slice(0, 5) : null;
  if (time === null && (t.lot_size === null || t.lot_size === undefined)) return null;
  return [t.trade_date, t.instrument, t.position || '', time || '',
    Number(t.entry_price), t.lot_size === null || t.lot_size === undefined ? '' : Number(t.lot_size)].join('|');
}

async function classifyImport(client, userId, input) {
  const rows = input.map(raw => {
    try {
      const t = cleanTrade(raw);
      const ref = raw && typeof raw.broker_ref === 'string' ? raw.broker_ref.trim().slice(0, 100) : '';
      t.broker_ref = ref || null;
      return { t, status: 'new', reason: null };
    } catch (err) {
      return { t: null, status: 'invalid', reason: err.message };
    }
  });
  const valid = rows.filter(r => r.t);
  if (!valid.length) return rows;
  const refs = [...new Set(valid.map(r => r.t.broker_ref).filter(Boolean))];
  const dates = valid.map(r => r.t.trade_date).sort();
  const [byRef, byRange] = await Promise.all([
    refs.length
      ? client.query('SELECT broker_ref FROM trades WHERE user_id = $1 AND broker_ref = ANY($2)', [userId, refs])
      : { rows: [] },
    client.query(
      `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, to_char(entry_time, 'HH24:MI') AS entry_time,
         instrument, position, entry_price, lot_size
       FROM trades WHERE user_id = $1 AND trade_date BETWEEN $2 AND $3`,
      [userId, dates[0], dates[dates.length - 1]]
    ),
  ]);
  const knownRefs = new Set(byRef.rows.map(r => r.broker_ref));
  const knownPrints = new Set(byRange.rows.map(fingerprint).filter(Boolean));
  const fileRefs = new Set();
  const filePrints = new Set();
  for (const r of valid) {
    const ref = r.t.broker_ref;
    const fp = fingerprint(r.t);
    if ((ref && knownRefs.has(ref)) || (fp && knownPrints.has(fp))) {
      r.status = 'duplicate'; r.reason = 'Sudah ada di jurnal';
    } else if ((ref && fileRefs.has(ref)) || (fp && filePrints.has(fp))) {
      r.status = 'duplicate'; r.reason = 'Duplikat di file';
    }
    if (ref) fileRefs.add(ref);
    if (fp) filePrints.add(fp);
  }
  return rows;
}

function countStatuses(rows) {
  const counts = { new: 0, duplicate: 0, invalid: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

app.post('/api/trades/import', async (req, res) => {
  const input = req.body && req.body.rows;
  if (!Array.isArray(input) || !input.length) return res.status(400).json({ error: 'Tidak ada baris untuk diimpor' });
  if (input.length > IMPORT_MAX_ROWS) return res.status(400).json({ error: 'Maksimal ' + IMPORT_MAX_ROWS + ' trade per impor' });
  if (req.body.dryRun === true) {
    try {
      const rows = await classifyImport(pool, req.user.id, input);
      return res.json({ rows: rows.map(r => ({ status: r.status, reason: r.reason })), counts: countStatuses(rows) });
    } catch (err) {
      console.error('import preview failed', err);
      return res.status(500).json({ error: 'Gagal memeriksa file' });
    }
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const rows = await classifyImport(client, req.user.id, input);
    const sql = insertSql(['broker_ref']) + ' ON CONFLICT (user_id, broker_ref) WHERE broker_ref IS NOT NULL DO NOTHING';
    let imported = 0;
    for (const r of rows) {
      if (r.status !== 'new') continue;
      const { rowCount } = await client.query(sql,
        [req.user.id, req.user.username, ...WRITE_FIELDS.map(f => r.t[f]), r.t.broker_ref]);
      if (rowCount) imported++;
      else r.status = 'duplicate';
    }
    await client.query('COMMIT');
    const counts = countStatuses(rows);
    res.json({ imported, duplicate: counts.duplicate, invalid: counts.invalid });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('import trades failed', err);
    res.status(500).json({ error: 'Gagal mengimpor trade' });
  } finally {
    if (client) client.release();
  }
});

app.put('/api/trades/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Trade tidak ditemukan' });
  let t;
  try { t = cleanTrade(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    t.account_id = await ownAccountId(req.user.id, t.account_id);
    const sets = WRITE_FIELDS.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE trades SET ${sets}, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING ${TRADE_COLUMNS}`,
      [id, req.user.id, ...WRITE_FIELDS.map(f => t[f])]
    );
    if (!rows.length) return res.status(404).json({ error: 'Trade tidak ditemukan' });
    res.json({ trade: rows[0] });
  } catch (err) {
    console.error('update trade failed', err);
    res.status(500).json({ error: 'Gagal menyimpan trade' });
  }
});

app.delete('/api/trades/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Trade tidak ditemukan' });
  try {
    const { rowCount } = await pool.query('DELETE FROM trades WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Trade tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete trade failed', err);
    res.status(500).json({ error: 'Gagal menghapus trade' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Accounts and risk limits -----------------------------------------------
// Each user can keep several trading accounts, each with a starting balance,
// an optional daily loss limit and optional per-market risk limits (% of
// capital per trade). Rows carry capital figures, so the table is private.
// Returns the id when it belongs to the user, else null (a trade never
// depends on another user's account row).
async function ownAccountId(userId, id) {
  if (id === null || id === undefined) return null;
  const { rows } = await pool.query('SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows.length ? id : null;
}

function cleanMarketLimits(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const c of CATEGORIES) {
      const n = Number(v[c]);
      if (Number.isFinite(n) && n > 0 && n <= 100) out[c] = n;
    }
  }
  return out;
}

function cleanAccount(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
  if (!name) throw new Error('Nama akun wajib diisi');
  return {
    name,
    starting_balance: cleanNumber(b.starting_balance),
    daily_loss_limit: cleanNumber(b.daily_loss_limit),
    market_limits: cleanMarketLimits(b.market_limits),
  };
}

app.get('/api/accounts', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') return res.json({ accounts: DEMO_ACCOUNTS, demo: true });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, starting_balance, daily_loss_limit, market_limits, created_at
       FROM accounts WHERE user_id = $1 ORDER BY id`,
      [req.user.id]
    );
    res.json({ accounts: rows });
  } catch (err) {
    console.error('list accounts failed', err);
    res.status(500).json({ error: 'Gagal memuat akun' });
  }
});

app.post('/api/accounts', async (req, res) => {
  let a;
  try { a = cleanAccount(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, starting_balance, daily_loss_limit, market_limits)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, starting_balance, daily_loss_limit, market_limits, created_at`,
      [req.user.id, a.name, a.starting_balance, a.daily_loss_limit, a.market_limits]
    );
    res.status(201).json({ account: rows[0] });
  } catch (err) {
    console.error('create account failed', err);
    res.status(500).json({ error: 'Gagal menyimpan akun' });
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Akun tidak ditemukan' });
  let a;
  try { a = cleanAccount(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const { rows } = await pool.query(
      `UPDATE accounts SET name = $3, starting_balance = $4, daily_loss_limit = $5, market_limits = $6
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, starting_balance, daily_loss_limit, market_limits, created_at`,
      [id, req.user.id, a.name, a.starting_balance, a.daily_loss_limit, a.market_limits]
    );
    if (!rows.length) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    res.json({ account: rows[0] });
  } catch (err) {
    console.error('update account failed', err);
    res.status(500).json({ error: 'Gagal menyimpan akun' });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Akun tidak ditemukan' });
  try {
    const { rowCount } = await pool.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Akun tidak ditemukan' });
    // Trades keep existing; they just lose the account link.
    await pool.query('UPDATE trades SET account_id = NULL WHERE user_id = $1 AND account_id = $2', [req.user.id, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete account failed', err);
    res.status(500).json({ error: 'Gagal menghapus akun' });
  }
});

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/trading-journal-13ee34/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/trading-journal-13ee34/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DRAIN_MS = 3000;
let shuttingDown = false;
let server;

async function start() {
  // Personal trading records (capital, P&L): private, so staging previews
  // get the schema without anyone's rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      trade_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS entry_time TIME,
      ADD COLUMN IF NOT EXISTS exit_time TIME,
      ADD COLUMN IF NOT EXISTS instrument VARCHAR(40),
      ADD COLUMN IF NOT EXISTS category VARCHAR(20),
      ADD COLUMN IF NOT EXISTS position VARCHAR(10),
      ADD COLUMN IF NOT EXISTS entry_price NUMERIC,
      ADD COLUMN IF NOT EXISTS stop_loss NUMERIC,
      ADD COLUMN IF NOT EXISTS take_profit NUMERIC,
      ADD COLUMN IF NOT EXISTS exit_price NUMERIC,
      ADD COLUMN IF NOT EXISTS lot_size NUMERIC,
      ADD COLUMN IF NOT EXISTS capital NUMERIC,
      ADD COLUMN IF NOT EXISTS risk_amount NUMERIC,
      ADD COLUMN IF NOT EXISTS setup VARCHAR(200),
      ADD COLUMN IF NOT EXISTS timeframe VARCHAR(20),
      ADD COLUMN IF NOT EXISTS entry_reason TEXT,
      ADD COLUMN IF NOT EXISTS emotion VARCHAR(20),
      ADD COLUMN IF NOT EXISTS followed_plan BOOLEAN,
      ADD COLUMN IF NOT EXISTS mistakes TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS checklist TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS lesson TEXT,
      ADD COLUMN IF NOT EXISTS result_amount NUMERIC,
      ADD COLUMN IF NOT EXISTS broker_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS account_id INTEGER,
      ADD COLUMN IF NOT EXISTS screenshot_url TEXT,
      ADD COLUMN IF NOT EXISTS screenshot_id VARCHAR(64)
  `);
  // broker_ref is the broker's ticket for imported trades; one ticket is
  // imported at most once per user.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS trades_user_broker_ref_idx
    ON trades (user_id, broker_ref) WHERE broker_ref IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_user_date_idx ON trades (user_id, trade_date DESC)`);
  await pool.query(`COMMENT ON TABLE trades IS 'staging:private'`);

  // Multiple accounts per user, each with a starting balance, an optional
  // daily loss limit and optional per-market risk limits (JSONB, a
  // category -> % of capital map). Holds capital figures: private.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name VARCHAR(100) NOT NULL,
      starting_balance NUMERIC,
      daily_loss_limit NUMERIC,
      market_limits JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id, id)`);
  await pool.query(`COMMENT ON TABLE accounts IS 'staging:private'`);

  // Per-user UI language. Public by default (only a preference code, no
  // personal content), so staging previews can seed a demo row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER PRIMARY KEY,
      language VARCHAR(10) NOT NULL DEFAULT 'id',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // One profile row per user: display name, contact details and the avatar
  // (stored by URL in the platform's file storage, never bytes). Carries
  // personal information, so staging previews get the schema without rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      display_name VARCHAR(60),
      email VARCHAR(120),
      whatsapp VARCHAR(20),
      avatar_url TEXT,
      avatar_id VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE user_profiles IS 'staging:private'`);

  // Shared market news (admin-curated). Public: content is the same for
  // every user and carries no personal data, so staging copies the rows and
  // preview seeds below just top it up.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_items (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      summary TEXT,
      category VARCHAR(20),
      symbols TEXT[] NOT NULL DEFAULT '{}',
      sentiment VARCHAR(10),
      importance VARCHAR(10),
      event_date DATE NOT NULL DEFAULT CURRENT_DATE,
      event_time TIME,
      source_url TEXT,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS news_items_event_date_idx ON news_items (event_date DESC)`);

  if (IS_STAGING) {
    // Demo news for staging previews: obviously fake, fixed ids, idempotent.
    // Row 900003 matches the demo BBCA trade (2026-09-30) so the journal's
    // news marker is visible without extra seeding.
    await pool.query(`
      INSERT INTO news_items (id, title, summary, category, symbols, sentiment, importance, event_date, event_time, source_url, created_by)
      VALUES
        (900001, 'Staging demo: NFP AS melebihi perkiraan', 'Staging demo: rilis ketenagakerjaan AS di atas perkiraan pasar, dolar menguat.', 'ekonomi', '{EURUSD,XAUUSD}', 'bearish', 'tinggi', '2026-09-29', '20:30', NULL, 'staging-demo-user'),
        (900002, 'Staging demo: The Fed tahan suku bunga', 'Staging demo: bank sentris AS menahan suku bunga pada level saat ini.', 'ekonomi', '{EURUSD}', 'bullish', 'sedang', '2026-09-30', '02:00', NULL, 'staging-demo-user'),
        (900003, 'Staging demo: BBCA laba kuartal naik', 'Staging demo: laba kuartalan BBCA naik dibanding tahun lalu.', 'saham', '{BBCA}', 'bullish', 'tinggi', '2026-09-30', NULL, NULL, 'staging-demo-user'),
        (900004, 'Staging demo: bitcoin koreksi pasca rilis CPI', 'Staging demo: harga bitcoin turun setelah rilis inflasi AS lebih tinggi dari perkiraan.', 'kripto', '{BTCUSDT}', 'bearish', 'sedang', '2026-10-01', NULL, NULL, 'staging-demo-user')
      ON CONFLICT (id) DO NOTHING
    `);
  }

  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
