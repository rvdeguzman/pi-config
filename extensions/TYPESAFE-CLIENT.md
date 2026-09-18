# Shared TypeSafe routing client

`lib/typesafe-client.ts` is the guarded client implementation used by Jev delegation. Main-session auto-model routing was removed upstream and is not restored by this refactor. It uses **public `pi-typesafe@0.5.0` exports**, not private package files. `extensions/package.json` and its lockfile declare/pin the dependency separately from the package installed globally for `/typesafe` commands.

The refactor changes the client layer, not the authorization or routing workflow. Policies, thresholds, allowed profiles/models/efforts, scope checks, explicit-agent bypass, child restrictions, plan-mode guards, revalidation, and runner contracts remain local and unchanged. The package's stricter request limits now also apply.

## Setup and deployment

From the desired checkout:

```sh
make -C extensions/tests install-deps
make -C extensions/tests test
```

These targets use Pi's sibling Node/npm and install with lifecycle scripts disabled. The local dependency resolves naturally from `extensions/lib/`; there is no absolute global npm path or runtime import fallback. Pi continues supplying its host APIs to extensions.

**A worktree is not automatically deployed.** To activate later, integrate the branch into the live configuration checkout, run `install-deps` there, then `/reload` or restart Pi. Merely testing the worktree does not change the running session's extensions. Install dependencies before reloading, or dependent extensions will fail to load.

## Credentials and opt-in

- `TYPESAFE_API_KEY` takes precedence; otherwise use the owner-only key saved by `/typesafe login` under the agent directory's `pi-typesafe/auth.json`.
- `/typesafe login` comes from the separately installed package extension. The delegation router also works with just an environment key and the declared library dependency.
- Command preflights and actual requests use the same resolution logic. Missing or insecure stored credentials keep the task in the parent, without HTTP.
- Each request re-resolves the key. Stored-key deletion prevents subsequent submissions when there is no environment key; replacement/environment changes rebuild the cached client. In-flight submissions are not retroactively revoked by logout. Use `/delegate-auto off` to cancel the router's in-flight decision.
- A configured credential is not a verified connection. `/delegate-auto status` shows its session usage and last sanitized client failure. Authentication rejection is distinguished from generic failure, but does not permanently disable recovery after a key change.
- `/typesafe enable|disable` controls only `typesafe_evaluate`; it does not control the delegation router. Its opt-in is unchanged.

## Client lifetime and accounting

Each extension runtime owns a lazy adapter/client cache; the **implementation** is shared, not a cross-process singleton. A model override is sent in each request. Key, timeout, and daily-cap environment changes invalidate the package client while preserving that router's session counters. Session start/reload/replacement/shutdown resets the cache and local counters; off/on or tree navigation does not reset accounting. Reset aborts outstanding requests and ignores late local results.

Prior routing had no session attempt cap. The adapter explicitly avoids the package's general-tool default of 20 attempts by supplying `Number.MAX_SAFE_INTEGER`; it does not silently stop routing after ten two-stage delegations. An internal `maxRequests` option is available for explicit caller budgets and tests, counts submitted attempts including failures, and remains enforced across client rotations. No new routing-budget policy setting is introduced by this refactor.

The package's `PI_TYPESAFE_MAX_REQUESTS_PER_DAY`, `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY`, and `PI_TYPESAFE_MAX_USD_PER_DAY` remain honored. **They are not reliable hard global caps in 0.5.0:** separate package clients/processes cache and overwrite ledger totals without locking/merging, and persistence is best-effort. Token/spend caps check recorded consumption, not reserved worst-case cost of the next request. Local per-router usage is useful visibility; neither it nor `/typesafe status` represents a guaranteed account-wide total. The adapter reuses one ledger within its own runtime, but does not claim to fix upstream multi-client/process accounting.

The package persists token/attempt counters and safe auth-state metadata in `pi-typesafe/` under the configured agent directory. It does not persist request state there. Its estimated rate is $0.042 per million input tokens, not a live billing quote.

## Guards retained around the SDK

- Exactly `https://api.typesafe.ai/v1/systemone`, no redirect following, SDK logging off, no retries.
- Streamed success responses capped at **128,000 bytes before SDK buffering**. HTTP error bodies/headers are discarded; status remains available for safe errors. Body cancellation cannot stall a timeout.
- One hard total deadline across the dependent delegation stages. Abort races bound even non-cooperating fetch/read operations; late responses are cancelled/ignored.
- Package schema checks plus local validation of probability sums, selected maxima, known labels, finite ranges and confidence. Only validated answer fields are retained as evidence, never arbitrary upstream metadata.
- Package admission requires model/usage fields in responses, at most **64 Choice labels**, and **64 KiB serialized UTF-8 request JSON**. The existing 24,000-character task/context guard still applies; no ranking is split across independent requests to evade the choice limit.
- Invalid output, authentication errors, request/budget limits and network failures still return `parent`. Launch errors after dispatch remain tool errors rather than falsely claiming no child started.

## Verification

`make -C extensions/tests test` covers the original routing/runner regressions plus stored login, key precedence/rotation/logout, insecure credentials, offline package-backed requests, coherent distributions, response/UTF-8/label limits, no retries/redirects, stalled streams, cancellation, explicit budget persistence, and Pi extension loading. All tests run against disposable credentials/usage directories with real HTTP blocked by default. No live classification or classifier-quality benchmark is part of this suite.
