# Opt-in Jev delegation

Jev decides **whether to dispatch**, **which profile**, and **which execution model + reasoning effort** for one parent-authored task. The existing Herdr runners still launch and monitor the child. No new workflow engine, recursive delegation, or automatic fire-and-forget path is introduced.

## Enable

1. Provide `TYPESAFE_API_KEY` in the environment used to start Pi. Do not paste a key into chat or put it in the routing policy. Restart Pi if its existing process does not have the variable.
2. Load the extension with `/reload` (or start a new Pi process).
3. Run `/delegate-auto on` once to enable routing and remember the choice globally.

`/delegate-auto status` reports the mode, settings path, and policy path. `/delegate-auto on|off` saves the choice globally in `~/.pi/agent/jev-delegation.json` (`{"version":1,"enabled":true}`). New sessions, reload/resume, and tree navigation read this file; its choice overrides historical session entries. Already-running sessions keep their current mode until reload or tree navigation. Without the file, legacy branch state is restored (otherwise off); malformed/unreadable settings disable delegation with a warning. `/delegate-auto off` also cancels in-flight routed calls. Already-dispatched async children retain their normal monitor lifecycle. Children do not register the command or routing tool.

**Privacy:** opting in sends the supplied task brief, optional context, profile capability descriptions, and routing policy to `https://api.typesafe.ai/v1/systemone`. The extension does not automatically send your transcript, system prompt, repository contents, or credentials from Pi's auth store. The parent must not include secrets in task/context. Routing evidence is retained in ordinary tool-result details; HTTP bodies and credential headers are not logged by the router.

## Parent-facing tool

```ts
herdr_delegate({
  task: "Trace authentication initialization across the repository. Return exact file citations and unresolved questions.",
  context: "Read-only. Parent is independently investigating the transport layer. No file changes are needed.",
  delivery: "async", // default; use blocking only for a required dependency
})
```

The parent still identifies task boundaries, supplies complete instructions and expected output, and controls the number/order of calls. Jev does **not** automatically decompose every user prompt or start agents from raw input. The enabled mode adds guidance to use this tool for candidate subtasks before choosing a direct dispatch path.

- Omit `agent` to let Jev choose an eligible profile.
- Set `agent: "scout"` (for example) to pin the profile for a planned task; Jev still gates dispatch and chooses its model/effort pair.
- `allowWrites` defaults to `false`. Set it to `true` **only for user-authorized implementation**. This permits, but does not force, write-capable profiles. It is not an OS sandbox or independent proof of authorization.
- `delivery: "blocking"` excludes `worker`, matching the existing blocking runner.
- `cwd` defaults to the current project and follows the existing runner's directory/trust checks.
- `context`, when present, is sent to both Jev and the child. No parent transcript is implicitly copied.

A retained task returns `details.action: "parent"`, a reason, and **no child is launched**. The parent handles it itself instead of bypassing the decision through another tool. This includes low confidence, routing errors, missing credentials, unavailable candidates, invalid decisions, and cancellation before launch. The no-bypass behavior is parent guidance, not a restriction on the direct tools needed for explicit user requests.

A dispatched task returns `details.action: "delegate"`, routing evidence (including `details.routing.model` and `details.routing.thinking`), and the original runner result under `details.child`. The visible result also reports the chosen model and effort. Async results arrive through the existing steer message. Blocking results return inline. Actual launch/child errors are still tool errors: they must not be mistaken for a no-launch decision or blindly retried, because a child may have started.

**Explicit `&scout`, `&researcher`, and `&worker` requests remain direct `herdr_async` calls.** They bypass Jev and keep the profile's configured model/thinking/tools. The three direct dispatch tools remain unchanged for manual use.

## Decisions and constraints

1. Build eligible candidates from live profiles, registered child-compatible tools, routing policy, available authenticated models, and `ctx.scopedModels`.
2. Ask Jev whether delegation is worthwhile. In the same request, ask which profile would fit **if** delegation is worthwhile. These questions are independent; code gates on dispatch first. A pinned/single eligible profile needs no profile question.
3. Only after a confident positive gate/profile decision, choose a **model/effort pair** from the selected profile's models and each model's supported efforts. This replaces the previous model-selection question, not an additional API stage. One model with several efforts still needs this request; exactly one eligible pair does not. Excessive expanded choice sets stay in the parent instead of making an oversized API request.
4. Validate the response and re-read policy, profiles, tools, model capabilities, and scope before launch. Changes invalidate the pending route instead of silently choosing another model or clamping effort.
5. Pass the validated pair to a private in-process runner entry point, using the existing child `--model` and `--thinking` flags. No public model/tool/thinking override arguments are added to the direct tools.

Model candidates are the intersection of each profile's routing-policy allowlist and Pi's available models, restricted by the live scoped list when configured. An empty `ctx.scopedModels` means Pi has no scope configured; it does not remove the policy allowlist. No eligible intersection means stay in the parent.

For auto-routed tasks, Jev can choose **every effort Pi reports as supported** through `getSupportedThinkingLevels(model)`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` where available. Non-reasoning models offer only `off`; unsupported levels and holes in a model's thinking map are excluded. No effort allowlist needs to be added to the policy.

An explicit scoped thinking pin restricts that model to the pinned level. If the pin is unsupported, the model is ineligible; it is not silently clamped. Otherwise, the profile's fixed `thinking` and the parent's current effort do **not** constrain auto-routing. Those defaults remain unchanged for direct tools and explicit `&profile` requests.

Jev chooses the pair jointly, with instructions to prefer the lowest effort adequate for correctness and reserve extra-high/maximum effort for tasks that justify the additional compute/latency. The selected pair must remain eligible at launch. Routing never changes profile files, Pi defaults, or the parent's model/effort.

Without write authorization, tools must all be in the conservative read-only set (`read`, `grep`, `find`, `ls`, and the three Exa search/fetch tools). Unknown/SDK-only tools exclude the profile. This means the current researcher profile is unavailable unless its Exa tools are registered. All four delegation tools are stripped from children. Plan mode disables and blocks every delegation entry point, including queued `herdr_async` and `herdr_delegate` calls.

Children still share their selected checkout; routing is not worktree isolation. The parent must coordinate file ownership and disclose overlapping writes/dependencies in the task context.

## Policy

Edit `~/.pi/agent/extensions/herdr-routing.json`. It is loaded on each routed call; only this global user-authored file is used, never project-local routing configuration.

- `profiles`: descriptions and explicit model allowlists. An unknown/unconfigured profile is not auto-routed. Add new profiles here as well as under `agents/`.
- Model `description`: a routing rubric, not just a display name.
- `objective`: your routing preferences.
- `model`: Jev classifier model, initially `jev-latest`.
- `timeoutMs`: one total deadline across both API stages (initially 2500 ms), with no automatic retries.
- `minConfidence`: initially 0.8.
- `minProbability`: initially 0.7 for the selected option. Both thresholds must pass at every decision stage.

The supplied Luna/Sol/Astra rubrics are **initial preferences, not benchmarked capability guarantees**. Tune them and the thresholds against actual completion quality, rework, and latency. Jev confidence describes its distribution, not a measured probability that a child will succeed. `jev-latest` can change upstream; pin a supported Jev version if reproducibility is needed.

The sidecar is an explicit opt-in model-routing allowlist. Existing `agents/*.md` `model` strings/arrays keep their direct-dispatch meaning. Ordered provider-failure fallback in the direct blocking runner is not repurposed as routing. A routed call uses its one approved model; it does not silently advance to unapproved fallback models.

## Verification

Run `make -C extensions/tests test`. The Makefile uses Pi's sibling Node executable and resolves its installed extension dependencies without installing packages into this config checkout. `NODE`, `NODE_TYPE_FLAGS`, and `PI_TEST_ENTRY` can be overridden for other installations. On macOS, a pending Xcode license can prevent `/usr/bin/make` from starting; select an already-installed Command Line Tools developer directory if appropriate.

Tests cover fail-closed classification, bounded network calls, malformed distributions, authorization/scope filtering, all supported efforts, unsupported/pinned effort rejection, persisted opt-in state, cancellation/revalidation races, explicit-request bypass, child tool stripping, plan-mode gates, and model/effort propagation through both runner launch paths with mocked Jev/Herdr. They do not validate live Jev credentials or classifier quality.

Sources: [HTTP API](https://docs.typesafe.ai/api), [confidence semantics](https://docs.typesafe.ai/confidence), [independent questions/state](https://docs.typesafe.ai/concepts/state).
