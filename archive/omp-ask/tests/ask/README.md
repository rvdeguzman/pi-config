# ask extension tests

Regression coverage for [`pi/extensions/ask.ts`](../../extensions/ask.ts), the
structured-question tool (radio / checkbox rows, per-option notes, tabbed
multi-question dialog, timeout auto-select).

```sh
./run.sh                  # all four suites
bun run notes.test.ts     # one suite, full output
```

`run.sh` calls [`pi/tests/lib/link-pi-modules.sh`](../../../../tests/lib/link-pi-modules.sh), which links
`pi/node_modules` (gitignored) at the globally installed pi so `bun` can resolve
`@earendil-works/*` from inside `ask.ts`. Nothing is vendored — the suites always
run against whatever pi version is installed.

## Suites

| Suite                | Checks | Covers                                                            |
| -------------------- | -----: | ----------------------------------------------------------------- |
| `ask.test.ts`        |     38 | Non-TUI fallback path, schema validation, result/detail shapes    |
| `notes.test.ts`      |     20 | `n` note lifecycle and every invalidation rule                    |
| `navigation.test.ts` |     51 | Tabs, Submit gating, cursor/number keys, narrow-width rendering   |
| `timeout.test.ts`    |     51 | Countdown, auto-select, settings precedence, malformed config     |

## How they work

There is no TUI here. [`pi/tests/lib/harness.ts`](../../../../tests/lib/harness.ts) fakes `ctx.ui.custom()`, grabs the live
component, and types raw terminal escape sequences (`\x1b[A`, `\r`, …) straight
into `handleInput()`, asserting on ANSI-stripped `render()` output.

Two properties matter:

- **`driveDialog` is watchdogged.** If a test drives the component but it never
  calls `done()`, the harness fails that case after ~2s instead of hanging. Any
  suite that hangs is a harness bug, not a slow test.
- **Suites are fast by construction** — the whole run is a few seconds. The only
  real waits are in `timeout.test.ts`, which sets `ask.timeout` to 1 second.

## Known fragility

`ask.ts` reads its settings by reading `settings.json` off disk directly, and
the *global* file (`~/.pi/agent/settings.json`) is real, not mocked. Adding an
`ask` block there with a non-zero `timeout` will break the suites that assume
timeouts are off by default. Project-scoped settings are exercised through temp
dirs under `/tmp` and are safe.
