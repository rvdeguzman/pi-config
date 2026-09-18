# pi-typesafe 0.5.0 review

Historical pre-refactor assessment; existing-code line references below refer to that snapshot. The follow-up implementation and current operational behavior are documented in [TYPESAFE-CLIENT.md](TYPESAFE-CLIENT.md).

## Outcome

Installed and pinned `npm:pi-typesafe@0.5.0` in global `settings.json` using Pi's package manager, with npm lifecycle scripts disabled. The registry tarball's SHA-512 integrity was verified before source review. Installation added three packages and npm reported zero vulnerabilities; this is not a security guarantee.

**Recommend a small, guarded client-layer refactor, not replacing the routing system.** No routing implementation, policy, threshold, or opt-in behavior was changed during this review.

Run `/reload` (or start a new Pi session) to load the package, then `/typesafe status`. The existing environment key is supported; no credential was copied or printed. The package's agent tool remains disabled unless explicitly enabled with `/typesafe enable` (or `PI_TYPESAFE_ENABLED=1`). Installation does not migrate our routers to the package.

## Reuse vs retain

Reuse the public `pi-typesafe` library for:

- `createTypeSafe`, `choice`, and `ask`/`evaluate`: typed requests, schema admission, sanitized error categories, no automatic retries.
- Shared environment-or-login-store credential resolution and auth status. Our current command checks and routing calls only support `TYPESAFE_API_KEY`; merely installing the package does not make `/typesafe login` work with them.
- Usage/spend visibility and deliberately configured per-client budgets, subject to the ledger caveat below.
- Optionally, `pi-typesafe/calibrate` for replaying labelled routing cases. Our 0.8 confidence / 0.7 selected-probability thresholds are preferences, not validated success guarantees. Its binary calibration utilities would need an explicit definition of routing success.

Retain locally:

- `/delegate-auto` and `/auto` as independent opt-ins; `/typesafe enable|disable` only controls the package's general-purpose tool.
- Dispatch/profile gating followed by a joint model/effort decision. Dependent stages must remain sequential; batching does not make one question see another answer.
- Live profile/model/tool/scope eligibility, write authorization, supported effort checks, context-window safeguards, and pre-launch/pre-switch revalidation.
- Herdr runners, explicit `&profile` bypass, child exclusions, plan-mode gates, cancellation generations, and fail-closed `parent`/`keep` outcomes.
- Narrow disclosure of task/prompt data, sanitized evidence, and routing-specific response validation.

Do **not** replace `herdr_delegate` with an LLM workflow that calls `typesafe_evaluate` and then chooses a runner itself. That would move enforceable orchestration checks back into model instructions.

## Compatibility findings

References under `npm/node_modules/` describe the exact installed versions, not an upstream main branch.

| Area | Finding and migration requirement |
| --- | --- |
| Response validation | `pi-typesafe/dist/client.js:22` checks answer labels/ranges but does not require probabilities to sum to one or the chosen option to be maximal. Offline probes confirmed both malformed cases are accepted. Keep `lib/jev-routing.ts:115`'s stricter `parseChoice` after package validation. The package additionally requires model and token-usage fields; existing HTTP mocks must add those. |
| Deadline | `pi-typesafe/dist/ask.js:13` merges an abort signal but does not race uncooperative work. Our `withAbort` (`lib/jev-routing.ts:155`) bounds the caller even if a transport ignores abort. Preserve one 2.5-second total deadline across both delegation stages, not a new timeout for each request. A 10-ms package deadline with an injected 100-ms uncooperative fetch did not return until that fetch completed. |
| Transport | SDK 0.6.0 buffers the response without a size cap and does not set `redirect: "error"` (`@typesafe-ai/sdk/dist/index.mjs:469,641`). Our transport rejects redirects and caps responses at 128,000 bytes. Inject a bounded, redirect-rejecting fetch adapter before replacing it; do not lose these guards just to delete HTTP code. The package does correctly fix the base URL, disable SDK logging, and disable retries (`client.js:95–102`). |
| Request limits | `pi-typesafe/dist/schema.js:5,28` allows 64 KiB JSON and 64 Choice labels, versus our up-to-254 labels and 24,000-character task/prompt guard. Current three-model policies fit the label limit. Validate full serialized UTF-8 payloads and expanded label counts, keeping oversized routes in the parent/current model. Do not split a single choice competition across independent batches. |
| Budget lifetime | The default is 20 HTTP attempts **per client instance**, including failures (`client.js:83,138`). One delegated route can consume two attempts. Make budgets explicit and reuse clients with a defined session/configuration lifecycle; creating a client per route defeats the session limit, while silently adopting 20 changes long-run behavior. |
| Shared daily ledger | `pi-typesafe/dist/usage.js:114–150` reads the ledger once per instance, then writes cached totals without merging or locking. Two independently opened ledgers each recording one attempt persisted **one**, not two. This also affects separate clients in one process, including the package tool versus custom routers. Daily caps are not reliable global hard spending limits across our multiple Pi processes. A shared in-process ledger helps only within that process; cross-process correctness needs upstream work or a synchronized ledger adapter. Token/USD caps also check already-recorded spend, not a reservation for the next request. |
| Module resolution | Pi installs the package under `~/.pi/agent/npm/node_modules/`; local files under `extensions/lib/` cannot resolve it as a bare dependency merely because the package extension loads. Declare a pinned dependency for a local extension package, following Pi's dependency example, rather than importing private `dist/` files or hardcoding the machine's global install path. |

## Proposed follow-up boundary

1. Add a declared, pinned dependency and a shared `lib/typesafe-client.ts` adapter for the two routers. Use public exports only.
2. Centralize credential resolution and sanitized availability/errors there. Update the command preflight checks too, so stored-login support is real rather than cosmetic. Define when cached clients are invalidated after credential/model-policy changes.
3. Preserve strict choice validation, bounded response/redirect handling, the outer hard deadline, and independent cancellation. Expose usage without treating the 0.5.0 daily ledger as a cross-process spending guarantee.
4. Replace just the duplicated HTTP blocks in `lib/jev-routing.ts` and `lib/auto-model-routing.ts`. Keep decisions, prompts, policy parsing, execution checks, and existing tool contracts intact.
5. Extend tests for stored credentials, HTTP error categories, budgets, 64-label/byte limits, deadlines, malformed distributions, and unchanged no-launch/no-switch behavior. Define routing budget policy explicitly rather than inheriting package defaults accidentally.

If this adapter ends up retaining most of the existing transport, adopt shared credentials first and defer transport migration until upstream supports the missing guards. Installing the package does not by itself justify a larger rewrite.

## Verification performed

- `pi list` confirms the pinned global package; Pi version is 0.85.1, its Node runtime is 22.23.2.
- `make -C extensions/tests test`: **85 passed**.
- `make -C /tmp/pi-typesafe-review test`: **9 passed**. Temporary characterization probes loaded the installed extension through Pi's extension loader, exercised status and the disabled-tool guard, evaluated a synthetic request with mocked HTTP, and reproduced the compatibility differences above. These characterize 0.5.0, not tests claiming those behaviors are desirable.
- Package verification used synthetic credentials, an isolated temporary agent directory, and blocked real network fetches. No live package evaluation, general-tool enablement, credential migration, or classifier-quality benchmark was performed.

## Sources

- [Package listing](https://pi.dev/packages/pi-typesafe)
- [Reviewed upstream API documentation](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/docs/api.md)
- Installed package: `~/.pi/agent/npm/node_modules/pi-typesafe/` (0.5.0); SDK: `@typesafe-ai/sdk` (0.6.0).
- Existing contracts: [HERDR-ROUTING.md](HERDR-ROUTING.md), and historical `AUTO-MODEL.md` (removed upstream with auto-model routing).
