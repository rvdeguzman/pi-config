# Header logo tooling

Generators and previewers for the banner in
[`pi/extensions/gruvbox-dashboard.ts`](../../extensions/gruvbox-dashboard.ts).

The extension itself only holds the finished art as string literals, so it stays
dependency-free and fast to load. These scripts are how that art is produced and
inspected. Plain `.mjs`, no build step, no dependencies:

```sh
node pi/tools/logo/brand-render.mjs           # sample sizes of the Brand
node pi/tools/logo/brand-render.mjs 40 0.07   # <cols> <strokeWidth>
node pi/tools/logo/logo-preview.mjs           # every /logo entry, gruvbox gradient
node pi/tools/logo/header-preview.mjs         # full header layout at 4 widths (fetches a live quote)
node pi/tools/logo/color-modes.mjs            # truecolor vs ANSI vs plain, in situ
```

They live outside `pi/extensions/` on purpose: pi auto-discovers
`~/.pi/agent/extensions/*.ts` and `*/index.ts`, and helper scripts have no
business sitting in a scanned directory.

## brand-render.mjs

Rasterizes the Berserk Brand of Sacrifice at any size. Geometry is traced from
the reference art (869x1456) as 11 tapered line segments in normalized coords —
two long diagonals crossing in an X, horn-spikes off the upper elbows, the lower
edges closing a diamond, and a central spike with a crown on top.

Fills a `W x (H*2)` pixel grid with 3x3 supersampling, then packs each pixel-row
pair into one cell as `▀ ▄ █ ' '`. Terminal cells are ~1:2, so half-block pixels
come out square. Exports `renderBrand()`, `brandStrokes()` and `double()`.

Two things to know before regenerating:

- **The mark is 0.60 w:h.** Aspect-correct output is tall — 40 cols costs 34
  rows. The art in the extension is deliberately squashed vertically to stay
  header-sized (20x9, and 30x15 for tall terminals).
- **`double()` is omp's splash trick** (every glyph doubled horizontally, every
  row vertically). It's lossless for all-`█` marks like π, but it smears the
  `▀`/`▄` tapers of a diagonal mark into stair-steps — hence the resampled
  `brand-large` rather than a doubled `brand`.

Copy the output into `LOGOS` in the extension; `logo-preview.mjs` reads that
object straight back out of the `.ts` source to verify what landed.
