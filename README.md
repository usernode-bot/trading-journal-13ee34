# Trading journal

A trading journal for Homeroom users. Each person records their own trades
(forex, saham, kripto) and the app computes risk, R and RR for them, then
flags each trade against two discipline rules: risk at most 1% of capital and
a planned RR of at least 1:2. UI copy is in Bahasa Indonesia.

## How it works

- `server.js`: Express server. `/api/trades` (GET, POST) and
  `/api/trades/:id` (PUT, DELETE) are scoped to the signed-in user. The
  `trades` table is created/extended idempotently on boot and marked
  `staging:private` (personal financial data).
- `public/index.html`: the whole UI (list, desktop table, entry form). All
  derived numbers (risk $, risk %, R, planned/actual RR, discipline badge)
  are computed client-side in `calc()` from the stored fields.
- On a staging preview, `/?demo=1` shows three read-only demo trades so the
  list and badges can be reviewed on an empty database.
- Styling: Tailwind, precompiled by `npm run build` during image creation.
