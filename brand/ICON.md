# App icon

One glyph, redrawn from this spec (request #15): three ascending bar-chart
bars (small, medium, tall) on a thin baseline, with an upward zigzag trend
line above them and a round dot at each of its corners; a black pencil
tilted 45° in the top-right, tip aimed at the chart, with a thin white
divider between the body and the eraser.

- Colours: black `#0F0F0F` on white `#FFFFFF`, hairline outline `#E4E4E7`.
  No gradients, no shadows, no other colours, no text.
- Shape: rounded square, 1024×1024, corner radius 224; transparent outside
  the rounded corners.
- Files: `icon.svg` is the source drawing; `icon.png` is the 1024×1024
  render declared in `dapp.json` (`icon.image`). `public/logo.svg` is the
  same drawing served in-app (header logo + favicon).
- To redraw: edit `icon.svg`, then rasterize at 1024 (for example with
  resvg) into `icon.png` and copy the SVG to `public/logo.svg`.
