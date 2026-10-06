# App icon

The glyph is the app's logo: a pen whose tip meets a rising mint chart
line, drawn on a violet diagonal gradient. It lives in `public/logo.svg`
(single source of truth) and every raster file is rendered from it at
build time on an external machine, then committed:

- `brand/icon.png` — 512×512, full-bleed (square corners), the Homeroom
  homescreen tile (declared in `dapp.json` → `icon.image`). The tile
  crops and rounds it itself.
- `public/favicon.ico` — 16/32/48, rounded tile on transparency.
- `public/icon-192.png`, `public/icon-512.png` — rounded tile on
  transparency, referenced by `public/site.webmanifest`.
- `public/apple-touch-icon.png` — 180×180, full-bleed (iOS rounds it
  itself; transparency would render black).

To redraw: edit `public/logo.svg` (violet gradient `#8b5cf6 → #6d28d9`,
mint `#6ee7b7` chart line, white pen), then re-render the rasters the
same way and recommit them.
