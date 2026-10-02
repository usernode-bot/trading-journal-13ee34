# Trading journal — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and
the `presses` table bootstrap in `server.js`) — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the `presses` table as appropriate,
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Trading journal

A personal trading journal: each user logs their own trades (forex, saham,
kripto) and sees auto-calculated risk %, R and RR plus a discipline badge
(❌ when risk > 1% of capital or planned RR < 1:2). UI copy is Bahasa Indonesia.

## App-specific conventions

- `trades` is `staging:private`; every query is scoped to `req.user.id`.
- Derived numbers are never stored; `calc()` in `public/index.html` is the
  single place they are computed. When risk $ is empty it is estimated as
  |Entry - SL| x lot x contract size (forex 100000, saham 100, kripto 1).
- Every trade field except date and instrument is optional.
- Discipline has three rules: risk at most 1% of capital, planned RR at
  least 1:2, and `followed_plan` not `false` (unset does not count).
- Colours are tokens (`--c-*` RGB triplets in `styles/tailwind-input.css`,
  light in `:root`, dark in `.dark`) exposed as semantic Tailwind classes
  (`bg-canvas`, `bg-surface`, `border-line`, `text-ink`, `text-muted`,
  `bg-accent`, `text-buy`, `text-sell`, `text-warn`). Never write a raw
  palette class (`zinc-*`, `violet-*`): it would not follow the theme.
  Green is Buy/profit, red-orange is Sell/loss, teal is the accent.
- Screens are hash tabs (`#/jurnal`, `#/broker`, `#/sinyal`, `#/vip`) behind
  a fixed bottom nav; `--chrome-h` (measured) pads `<main>` so content is
  never under it.
- `BROKERS`, `CONTACT`, `PLANS` and `SIGNALS` at the top of the script are
  the only place broker, contact, plan and example-signal data live. Keep
  Exness's affiliate link with `rel="noopener sponsored"` and its affiliate
  label; never claim a broker is "terbaik" or "pasti aman", and never claim
  "pasti profit" or "akurasi 100%".
- Selected broker and VIP status are in-memory only (no localStorage), and
  payment is simulated. The `// TODO backend:` comments mark where signup,
  payment verification and signal delivery should move server-side.
- The disclaimer footer must stay on every screen.
- `broker_ref` holds the broker ticket of an imported trade. It is not in
  `WRITE_FIELDS`, so editing a trade never changes it. Import duplicates are
  found by ticket, or by the fingerprint date + instrument + position +
  entry time + entry price + lot (only when entry price and entry time or
  lot are present).
