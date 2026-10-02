# Trading journal

A trading journal for Homeroom users. Each person records their own trades
(forex, saham, kripto) and the app computes risk, R and RR for them, then
flags each trade against three discipline rules: risk at most 1% of capital,
a planned RR of at least 1:2, and the trade followed the plan. Around the
journal sit a broker comparison page, a VIP signal signup (simulated) and a
VIP-gated signal list. UI copy is in Bahasa Indonesia.

## How it works

- `server.js`: Express server. `/api/trades` (GET, POST) and
  `/api/trades/:id` (PUT, DELETE) are scoped to the signed-in user. The
  `trades` table is created/extended idempotently on boot and marked
  `staging:private` (personal financial data).
- `public/index.html`: the whole UI. A bottom navigation bar (hash routes
  `#/jurnal`, `#/broker`, `#/sinyal`, `#/vip`) and a fixed disclaimer footer
  sit on every screen. All derived numbers (risk $, risk %, R, planned/actual
  RR, discipline badge) are computed client-side in `calc()` from the stored
  fields; `summarize()` adds the recap (win rate, total P/L, average planned
  RR, max drawdown, per-category table) and the equity curve, drawn as an
  inline SVG once two trades have a result.
- Jurnal tab extras: a lot & risk calculator (nothing is saved) and
  `Ekspor CSV`, which shows the journal as CSV text with a `Salin CSV`
  button (downloads do not work in the published page). Its headers match
  the import synonyms so the file can be imported back.
- CSV import (`Impor CSV`): the browser parses the broker's CSV, maps its
  columns onto trade fields from common header names (the user can fix the
  mapping; it is remembered per header set in localStorage) and shows a
  preview. `POST /api/trades/import` revalidates every row with
  `cleanTrade()` and classifies it as new, duplicate or invalid
  (`dryRun: true` for the preview, otherwise it inserts the new rows in one
  transaction). The broker's ticket is stored in `broker_ref`, unique per
  user. `public/contoh-impor.csv` is a sample file in MetaTrader's shape.
- Broker, VIP and Sinyal tabs are driven by the constants at the top of the
  script: `BROKERS` (Exness with its affiliate link, two placeholder
  comparators), `CONTACT` (admin email/WhatsApp/Telegram), `PLANS` and
  `SIGNALS` (five example signals). The selected broker and VIP status live
  only in memory; the payment step is a placeholder with a "simulate
  success" button. `// TODO backend:` comments mark where signup, payment
  and signal delivery should connect to a server.
- On a staging preview, `/?demo=1` shows three read-only demo trades so the
  list, badges, recap and equity chart can be reviewed on an empty database.
- Styling: Tailwind, precompiled by `npm run build` during image creation.
  Colours are RGB tokens in `styles/tailwind-input.css` (`:root` light,
  `.dark` dark) mapped to semantic classes (`bg-canvas`, `text-ink`,
  `text-buy`, `text-sell`, `bg-accent`, ...) in `tailwind.config.js`; the
  theme follows the platform (`usernode.theme`) or the OS. Font is Sora with
  a system-ui fallback.
