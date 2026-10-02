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

// ---- Trades -----------------------------------------------------------------
// Every field except date and instrument is optional, so a quick entry can be
// completed later. Derived numbers (risk %, R, RR, discipline) are computed in
// the frontend from these stored values, never stored themselves.
const CATEGORIES = ['forex', 'saham', 'kripto'];
const POSITIONS = ['buy', 'sell'];
const EMOTIONS = ['tenang', 'fomo', 'takut', 'serakah', 'balas_dendam', 'ragu', 'bosan'];
const MISTAKES = ['entry_terlalu_cepat', 'sl_digeser', 'tp_dipotong', 'overtrade', 'melanggar_risiko', 'tanpa_setup'];
const NUMERIC_FIELDS = ['entry_price', 'stop_loss', 'take_profit', 'exit_price', 'lot_size', 'capital', 'risk_amount', 'result_amount'];
const TEXT_FIELDS = { instrument: 40, setup: 200, timeframe: 20, entry_reason: 2000, lesson: 2000 };

const TRADE_COLUMNS = `id, to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
  to_char(entry_time, 'HH24:MI') AS entry_time, to_char(exit_time, 'HH24:MI') AS exit_time,
  instrument, category, position, entry_price, stop_loss, take_profit, exit_price,
  lot_size, capital, risk_amount, setup, timeframe, entry_reason, emotion,
  followed_plan, mistakes, lesson, result_amount, created_at`;

function cleanNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) >= 1e12) throw new Error('Angka tidak valid');
  return n;
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
  for (const key of NUMERIC_FIELDS) t[key] = cleanNumber(b[key]);
  return t;
}

const WRITE_FIELDS = ['trade_date', 'entry_time', 'exit_time', 'instrument', 'category', 'position',
  ...NUMERIC_FIELDS, 'setup', 'timeframe', 'entry_reason', 'emotion', 'followed_plan', 'mistakes', 'lesson'];

// Read-only demo trades for staging previews (?demo=1). Never written to the
// database and never attributed to the visitor.
const DEMO_TRADES = [
  { id: -1, trade_date: '2026-09-29', entry_time: '14:05', exit_time: '16:40', instrument: 'EURUSD', category: 'forex', position: 'buy',
    entry_price: '1.0850', stop_loss: '1.0830', take_profit: '1.0900', exit_price: '1.0900', lot_size: '0.1', capital: '2500',
    risk_amount: null, setup: 'Staging demo: breakout', timeframe: 'H1', entry_reason: 'Staging demo trade, retest support', emotion: 'tenang',
    followed_plan: true, mistakes: [], lesson: 'Staging demo: sabar menunggu retest', result_amount: '50', demo: true },
  { id: -2, trade_date: '2026-09-30', entry_time: '09:15', exit_time: '09:50', instrument: 'BBCA', category: 'saham', position: 'buy',
    entry_price: '9500', stop_loss: '9300', take_profit: '9800', exit_price: '9350', lot_size: '10', capital: '15000',
    risk_amount: '200', setup: 'Staging demo: pullback', timeframe: 'M15', entry_reason: 'Staging demo trade', emotion: 'fomo',
    followed_plan: false, mistakes: ['entry_terlalu_cepat', 'melanggar_risiko'], lesson: 'Staging demo: jangan kejar harga', result_amount: '-150', demo: true },
  { id: -3, trade_date: '2026-10-01', entry_time: '20:00', exit_time: null, instrument: 'BTCUSDT', category: 'kripto', position: 'sell',
    entry_price: '62000', stop_loss: null, take_profit: '60000', exit_price: null, lot_size: '0.01', capital: '2000',
    risk_amount: null, setup: null, timeframe: 'H4', entry_reason: null, emotion: 'ragu',
    followed_plan: null, mistakes: ['tanpa_setup'], lesson: null, result_amount: null, demo: true },
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

app.post('/api/trades', async (req, res) => {
  let t;
  try { t = cleanTrade(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const cols = ['user_id', 'username', ...WRITE_FIELDS];
    const vals = [req.user.id, req.user.username, ...WRITE_FIELDS.map(f => t[f])];
    const { rows } = await pool.query(
      `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
       RETURNING ${TRADE_COLUMNS}`,
      vals
    );
    res.status(201).json({ trade: rows[0] });
  } catch (err) {
    console.error('create trade failed', err);
    res.status(500).json({ error: 'Gagal menyimpan trade' });
  }
});

app.put('/api/trades/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Trade tidak ditemukan' });
  let t;
  try { t = cleanTrade(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
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
      ADD COLUMN IF NOT EXISTS lesson TEXT,
      ADD COLUMN IF NOT EXISTS result_amount NUMERIC
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_user_date_idx ON trades (user_id, trade_date DESC)`);
  await pool.query(`COMMENT ON TABLE trades IS 'staging:private'`);

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
