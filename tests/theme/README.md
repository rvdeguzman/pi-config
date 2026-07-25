# theme extension tests

Regression coverage for [`pi/extensions/theme.ts`](../../extensions/theme.ts), the
`/theme` command and its live-preview picker.

```sh
./run.sh                  # both suites
bun run picker.test.ts    # one suite, full output
```

`run.sh` calls [`../lib/link-pi-modules.sh`](../lib/link-pi-modules.sh), which links
`pi/node_modules` (gitignored) at the globally installed pi so `bun` can resolve
`@earendil-works/*` from inside `theme.ts`. Nothing is vendored.

## Suites

| Suite             | Checks | Covers                                                                |
| ----------------- | -----: | --------------------------------------------------------------------- |
| `theme.test.ts`   |     63 | Name resolution, sources, `next`/`prev`, completions, fallbacks, shortcut config |
| `picker.test.ts`  |     35 | Live preview, keep vs revert, filtering, wrapping, broken theme files  |

## How they work

There is no TUI and no real theme registry.

- `harness.ts` loads `theme.ts` against a fake `ExtensionAPI`, captures the
  registered command/shortcut/`session_start` handler, and swaps in a fake theme
  registry so `setTheme()` just records the name (or fails, for `broken` themes).
- `picker.test.ts` reuses `driveDialog` from [`../lib/harness.ts`](../lib/harness.ts):
  it grabs the live component out of the faked `ui.custom()`, types raw escape
  sequences into `handleInput()`, and snapshots ANSI-stripped `render()` output
  after every key. The `apply` callback is injected, so the trail of previewed
  themes is directly assertable.

`driveDialog` is watchdogged: a picker that never calls `done()` fails its case
after ~2s instead of hanging.

## Known fragility

`readThemeSettings()` reads `settings.json` off disk, and the *global* file
(`~/.pi/agent/settings.json`) is real, not mocked. Adding a `themeCommand` block
there will break the shortcut-default check. Project-scoped settings are
exercised through temp dirs and are safe.
