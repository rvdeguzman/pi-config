# Archived OMP ask extension

Archived on 2026-07-26. This was the local port of Oh My Pi's model-callable
`ask` tool. It is kept here with its regression tests for reference, but files
under `pi/archive/` are not auto-loaded by Pi.

The active workflow now uses Mitsuhiko's:

- `/discuss` prompt for short-round planning interviews
- `/answer` or `Ctrl+.` to turn questions from the last assistant response into
  an interactive answer form

To restore the old tool, move `extensions/ask.ts` back to `pi/extensions/`.
The archived tests retain their original layout relative to the extension.
