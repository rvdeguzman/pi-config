# Jev auto model prototype

Routes **main-session execution**, not child agents. Jev chooses an allowed model + reasoning effort; Pi continues with the existing conversation and unchanged tools. Separate from `/delegate-auto` and its policy.

## Try it

1. Start Pi with `TYPESAFE_API_KEY` in its environment.
2. `/reload`
3. `/auto on`
4. Submit an ordinary text prompt while Pi is idle.

The footer shows the selected model/effort and classifier latency, or that the current model was retained. `/auto status` shows the last result and policy path. `/auto off` leaves the current model selected but stops future routing.

Opt-in is **runtime-local**: reload, session replacement, tree navigation, and manual model selection disable auto. Children do not register this extension's command or hooks. New sessions and global model defaults are not modified.

## Policy and safeguards

Edit `~/.pi/agent/extensions/auto-model.json`. The initial Luna / Sol / Astra rubrics optimize for balanced correctness and speed, not minimum cost at all costs. These are unbenchmarked preferences, not claims about relative model performance.

- One Jev request per eligible idle input selects a compatible model/effort pair or `keep`.
- Candidate models must be allowed by this policy, available in Pi, and in the current scoped model list when configured.
- Supported reasoning levels come from Pi; scoped effort pins are respected. No unsupported levels are silently substituted.
- A context-size heuristic excludes insufficient windows (estimated current tokens + prompt estimate + 8,192 headroom); unknown usage forbids shrinking the current window. This is not an exact tokenizer or a replacement for Pi's compaction.
- Default classifier deadline: 2.5 seconds, no retries. Confidence must be at least 0.8 and selected probability at least 0.7. These are classifier scores, not measured success probabilities.
- Missing credentials, oversized prompts, low confidence, malformed output, transport errors, and no eligible candidates keep the current execution.
- Policy, scope, model availability, and supported effort are rechecked before application. Off/shutdown/tree changes invalidate in-flight classification.
- Model provider failures after routing use normal Pi behavior; there is no hidden fallback model chain.

## Privacy and prototype limits

Enabling auto sends **the input text received by this hook**, the routing objective, and model/effort descriptions to `https://api.typesafe.ai/v1/systemone`. Do not include secrets in prompts while enabled. Earlier input extensions may already have transformed text. Auto does not itself read/send files, system prompts, transcript history, or image bytes. The selected execution model receives the normal Pi conversation as usual.

Only idle user inputs (interactive or RPC) are classified. Mid-run steering, queued follow-ups, extension-generated messages, slash/skill/template inputs, and image prompts retain the current model without classification. The model remains selected across tool calls. Context-dependent follow-ups should produce `keep` because Jev sees no transcript. Image history is not inspected by the classifier; the supplied model pool is image-capable.

Use **`/auto last`** to inspect the last completed classification on the current session branch, including after reload/resume. `auto-model-routing-response` session entries record the classifier, timestamp, thresholds, latency, select/keep outcome and Jev's validated `choice`, `confidence`, and full `probabilities` distribution. The `labels` map resolves each `route_N` to its model and reasoning effort; `keep` means retain the current execution. These are classification records, not proof that a proposed model was applied. Successful application separately records `auto-model-decision`.

Timeouts, preflight skips, and malformed/error responses record a sanitized reason with `response: null`. Inputs bypassed by the hook and classifications invalidated by shutdown/off are not recorded. No duplicate prompt, credentials, arbitrary server metadata, or raw error bodies are stored. Jev returns structured scores, not a textual explanation or chain of thought. Classification can be cancelled, but Pi's asynchronous model-authentication/switch operation itself has no cancellation API once entered. Routing time shown excludes policy reads and model switching.

## Verification

Run `make -C extensions/tests test` from `~/.pi/agent`. Tests use mocked Jev and Pi APIs; they do not verify live credentials, model quality, or real-provider latency.
