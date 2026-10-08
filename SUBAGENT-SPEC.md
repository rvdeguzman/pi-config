# Subagents with Agent Profiles

## Status

Approved design specification, revision 4: portable launch backends (Herdr or tmux) behind one runner, backend-neutral tool names, worktree isolation, reload survival, and run-directory retention. Revision 4 renamed `herdr_subagent`/`herdr_async` to `subagent`/`subagent_async` (no aliases) and added the tmux backend; see [EULER-SPEC.md](EULER-SPEC.md). Revision 3 removed the fire-and-forget `herdr_worker`, `herdr_send` follow-ups, and `herdr_interrupt`.

## Goal

Keep an observable subagent runner, hosted in a Herdr tab or a tmux window, with child runtime configuration in small named agent profiles, and provide both blocking and asynchronous execution paths.

The responsibility split is:

- The caller/parent chooses the agent profile for a blocking `subagent` or asynchronous `subagent_async` call.
- The caller/parent writes the complete delegated task.
- The agent profile selects the model, thinking level, and tools.
- The caller/parent decides how many children to launch and whether those calls are parallel or sequential.
- `subagent` waits for a result.
- `subagent_async` returns launch coordinates immediately, monitors in the background, and steers the final result back automatically.
- Profiles marked `worktree: true` run each child on its own Git branch in an isolated worktree (Herdr-managed under Herdr, a plain Git worktree under tmux).
- The launch backend is chosen per run (`auto` by default), never by profiles.

There is no workflow engine and no profile-level concurrency policy.

## Agent profiles

Profiles live in Markdown files under:

```text
~/.pi/agent/agents/*.md
```

A profile consists only of YAML frontmatter. Its Markdown body is not used as a system prompt. The parent must put all behavioral instructions, context, constraints, and expected output into the delegated task.

Example:

```yaml
---
name: scout
model: openai-codex/gpt-5.6-luna
thinking: low
tools: [read, grep, find, ls]
---
```

```yaml
---
name: worker
model:
  - openai/gpt-6.1-sol
  - anthropic/claude-opus-5-5
thinking: high
worktree: true
---
```

### Frontmatter schema

```ts
type AgentProfile = {
  name: string;
  model?: string | string[];
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  worktree?: boolean;
};
```

No other profile fields are supported. In particular, profiles do not define prompts, descriptions, extensions, durations, background behavior, workflows, or concurrency. `worktree` selects checkout isolation only; it grants or removes no capabilities.

### Model resolution

`model` may be either one model or an ordered fallback list:

```yaml
model: openai-codex/gpt-5.6-sol
```

```yaml
model:
  - openai-codex/gpt-5.6-sol
  - openai-codex/gpt-5.6-luna
```

Rules:

- A string selects that model.
- An array tries candidates in order.
- A missing model inherits the caller's active model.
- Fallback occurs for any final failed attempt, including provider, task, tool, startup, and unexpected child-exit errors. Wait for the child's final settled result after Pi exhausts its internal retries; the runner adds no same-model retries.
- Every fallback attempt uses the run's persisted backend.
- Fallback applies to blocking and async runs.
- Explicit aborts and user cancellation do not advance to another model. Invalid profile/tool configuration and backend preflight failures are rejected before launching any attempt.
- `thinking` applies to every candidate and is clamped by the selected model's capabilities.
- A missing `thinking` value inherits the caller's current thinking level.

### Tool resolution

- `tools` is the child's complete active-tool allowlist.
- The reserved entry `extensions` expands to every extension-registered tool the caller has loaded with `direct` or `model-only` exposure (Pi built-in and SDK tools are excluded), e.g. `tools: [read, grep, find, ls, extensions]`. A real tool named `extensions` takes precedence over the token.
- A missing `tools` value inherits the caller's active tools, excluding the delegation tools to prevent recursive delegation.
- Both delegation tools (`subagent`, `subagent_async`) are removed from every child tool allowlist, even if a profile names them explicitly.
- Unknown tool names are configuration errors and must be reported before launching the child.
- Tool restrictions are capability reduction inside Pi, not an operating-system sandbox.

Read-only profiles should not include `bash`: a prompt cannot prevent a shell tool from mutating the checkout.

## Tool API

The blocking model-facing tool remains one-child-per-call:

```ts
subagent({
  agent: string;
  task: string;
  cwd?: string;
})
```

The asynchronous tool has the same profile/task shape, returns immediately, and later delivers a custom steer message with the bounded result:

```ts
subagent_async({
  agent: string;
  task: string;
  cwd?: string;
})
```

Async runs are session-scoped: quitting or switching sessions cancels them and closes their targets. A `/reload` does not: launched children keep running, run records stay on disk, and the reloaded extension re-attaches through each run's own backend. Delivery is at most once: `delivered` is persisted before the steer, so a crash between the two drops a result rather than repeating it. An async run still starting at `/reload` is cancelled and closed. Async runs use ordered model fallback like blocking runs.

None of the tools accepts model, thinking, tools, parallel count, chain, or workflow parameters. Those concerns belong to the selected profile or the caller. The `worker` profile is async-only.

Example:

```ts
subagent({
  agent: "scout",
  task: "Map the authentication initialization flow. Cite exact files and explain unresolved gaps.",
})
```

The extension exposes the available profile names in the tool description so the caller can select one. An unknown profile is a hard error that lists the available names.

## Concurrency

The caller controls concurrency by issuing the desired number of ordinary `subagent` or `subagent_async` calls.

- Sibling calls emitted by the parent may execute concurrently through Pi's normal parallel tool execution.
- Sequential blocking subagent calls remain sequential when the parent waits for one result before issuing the next.
- Async calls return immediately and independently steer each final result into the parent session.
- Profiles do not contain `max_parallel` or any equivalent field.
- The current extension-wide serial queue must be removed.
- The implementation may retain a fixed defensive process ceiling only as a safety guard; it must not choose how many agents the caller should spawn.

Each reported call has independent cancellation, result data, backend target, and lifecycle state. Session shutdown closes unfinished blocking and async children owned by that parent session.

## `&agent` references and autocomplete

Humans can explicitly reference a profile in the editor:

```text
&scout map the authentication flow
&researcher find the current upstream API behavior
&worker implement the approved change and run the focused tests
```

An `&name` reference is an instruction to the parent to use that agent profile asynchronously through `subagent_async`. This includes `&worker`. It does not bypass the parent or launch a child directly: the parent still writes the complete task, adding relevant context and constraints from the conversation.

Every reference requests a fresh async child invocation. It does not address or steer an already-running child. `subagent` remains available for parent-selected blocking dependencies.

### Autocomplete behavior

Install an autocomplete provider through `ctx.ui.addAutocompleteProvider()`:

- Trigger on `&` only; do not interfere with Pi's `@` file completion.
- Match a token at the start of input or after whitespace.
- Match profile names by case-insensitive prefix.
- Read suggestions from the same profile registry used by both delegation tools.
- Display labels as `&<name>`.
- Insert the literal `&<name>` followed by one space.
- Delegate to the previously installed autocomplete provider whenever the cursor is not in an agent-reference token or no profile matches.
- Refresh the profile list without requiring Pi to restart; `/reload` and newly opened sessions must see profile file changes.

Examples:

```text
&sc<Tab>       -> &scout 
please &wor   -> please &worker 
```

Unknown `&name` text is left unchanged. The extension does not silently substitute another profile.

### Parent prompt guidance

When profiles are available, add concise guidance to the parent system prompt as its own structured section (`agent_profiles`), not a full prompt replacement:

- Treat a valid `&name` reference as the user's explicit request to delegate asynchronously through that profile.
- Route every valid reference through `subagent_async`, including `&worker`.
- Compose a complete, self-contained task for each child rather than forwarding an underspecified fragment blindly.
- Use `subagent` only for a parent-selected blocking dependency.
- Do not add model, thinking, or tool overrides; the profile owns those settings.
- The number and ordering of child calls remain the parent's decision unless the user explicitly requests particular references or parallelism.
- Merging a finished child branch into the current local branch is part of integration; pushing is not.

The section also says when to delegate, naming only profiles that exist (`scout*`, `researcher*`, `reviewer*`, worktree profiles). The rules come from an audit of real sessions: exploration and web research filled most of the parent's context, taste corrections dominated user messages, and unrequested verification fan-out was the main friction.

- Gather context first: exploring unfamiliar code goes to a scout, web or docs research to a researcher.
- Taste-sensitive or tightly coupled work stays in the parent. Worktree profiles get well-specified work only; read-only surveys never go to them.
- Parallel children own disjoint files. The parent first commits the shared contract (types, interfaces, stubs, registry or config entries), since children branch from committed HEAD; each task names owned files and shared files not to edit. Slices that cannot be made disjoint run in sequence. Branches are integrated one at a time with the project's check after each merge.
- One reviewer per integrated change, over the diff, flagging tests that would not catch a plausible bug and waits without a time limit.
- Verification stays proportional to risk: sample by category; no unrequested screenshot sweeps, process fan-outs, or extra reviewers.

## Execution backends

`/subagent-backend [auto|herdr|tmux]` reports or persists the setting in ignored `~/.pi/agent/subagents.json`; `PI_SUBAGENT_BACKEND` overrides it per process. `auto` (default) resolves once per run: Herdr when the parent runs in a Herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`) and the CLI answers, else tmux when installed, else an actionable error before any side effect. Explicit choices fail closed. Each run record stores `backend` plus an opaque `handle`; probes, fallback attempts, reattachment, and cleanup use them, so a setting change only affects new runs. Records without `backend` are Herdr records.

The backend interface is deliberately small (`extensions/lib/subagent-backends.ts`): `preflight`, `launch(request, onCreated)`, `probe`, `tail`, `close`, `commands`, and an optional `createCheckout`. `onCreated` fires as soon as the target exists so the runner persists the handle before startup finishes.

### Herdr

Requires Herdr 0.9+ (`agent start`, `agent prompt --wait --until`, `pane process-info`, `worktree create`).

1. `herdr tab create --no-focus --env …` creates a background tab whose shell carries the child-mode environment (result path and exit-on-finish). Outside a Herdr pane, `workspace create` is used instead.
2. `herdr agent start <name> --kind pi --pane <pane> -- <pi args>` launches Pi. Herdr returns only once it recognizes a ready Pi agent, so there is no type-into-shell race. While it waits, the parent polls `pane process-info`; if the shell regains the foreground, Pi exited during startup and the attempt fails within seconds instead of at Herdr's 45 s timeout.
3. `herdr agent prompt <pane> <task> --wait --until working --until blocked` submits the task and confirms the turn started.

`agent get` reports liveness and blocked state; probes treat a pane now hosting a differently named agent as gone.

### tmux

- Inside tmux, children open as background windows in the parent's session; otherwise in a detached `pi-subagents` session, created on demand and found again by a session tag (hooks may rename it).
- The window runs Pi from argv through a constant `sh` wrapper that unsets every inherited `HERDR_*` variable, so Herdr integrations stay inactive. No task text passes through a shell or argv.
- The child reads the task from the private `task.md` (`PI_HERDR_SUBAGENT_TASK`), submits it, and writes `result.json.started`; launch waits for that marker, and a pane that dies first is a startup failure.
- Windows are tagged with the run id and keep dead panes (`remain-on-exit`) for diagnostics; probes and closes act only on a window carrying this run's tag.
- Reported commands name the exact socket and window, e.g. `tmux -S <socket> attach-session -t @7 \; select-window -t @7`, `capture-pane -p -t %9 -S -200`, `kill-window -t @7`.
- tmux cannot see Pi's blocked state; status shows as running and the result says so. The result file and pane liveness decide completion.

## Completion

The child writes an atomic result file on `agent_settled`; that file is the only completion truth. The parent watches the run directory with `fs.watch` (plus a 1 s fallback stat) and probes the backend every 2 s for liveness (and Herdr's blocked state). A child that disappears without a result fails after a short grace period, with the pane tail as context. Blocking calls also read the pane every 2 s for their live preview; async monitors do not.

## Worktree isolation

When the profile sets `worktree: true` and the working directory is inside a Git repository with at least one commit:

1. A checkout on branch `pi/<profile>-<run8>` is created from the source repository's committed `HEAD`. Herdr: `herdr worktree create` opens it as a workspace; the child tab is created there and the workspace's root tab is closed once the child tab exists. tmux: `git worktree add` under `~/.pi/agent/subagent-worktrees/` (never pruned automatically). The child's cwd keeps the caller's relative subdirectory.
2. A short note is appended to the task: the checkout path, branch, and base commit; that uncommitted parent changes are absent; and that the child must commit on the branch and must not merge, rebase, push, or switch branches; and that siblings may run in parallel, so it edits only its assigned files and uses run-unique ports and temp paths.
3. After the run, the parent inspects the checkout (commits since base, diffstat, uncommitted changes):
   - Uncommitted changes: the checkout and its target are retained and reported.
   - Clean with commits: the target closes, the checkout is removed with `git worktree remove` (never forced), and the branch is kept and reported with an integration hint.
   - Clean without commits: the checkout and branch are removed.
4. A launch failure or abort applies the same release rules. The extension never commits, merges, or deletes a branch that has commits. Integration is the parent's job.

Outside a Git repository, the run proceeds in place and the result says so. Parallel isolated runs are allowed because each one gets a unique branch.

## Per tool

- `subagent`: launch, monitor, settle, and return the bounded result. Progress updates include the attach and capture commands. Any final failure other than cancellation moves to the next model candidate in a fresh target on the same backend, without adding same-model retries.
- `subagent_async`: return the run id and attach/capture commands once the first child is running. A session-scoped monitor tracks it in the parent widget, auto-closes the target, and injects a visible `subagent-async-result` custom message with `deliverAs: "steer"` and `triggerTurn: true`.

## Unintegrated work

`/subagent-branches` lists finished work that has not reached a repository's HEAD: every `refs/heads/pi/*` branch, in repositories known from run records, with commits that `git cherry` reports as missing (so merged and cherry-picked work is excluded), plus checkouts retained with uncommitted changes. Runs still queued or running are skipped. At startup the same check runs for the current repository and posts a one-line notice when anything is found. Repositories whose run records have all been pruned are no longer checked.

## Run records and retention

Each run writes `run.json` next to its `task.md`, session directory, and result file under `~/.pi/agent/herdr-subagents/<parent session>/<run>/` (directory name kept for existing records). The record is saved as soon as the run owns a worktree or a launch target, before startup completes. Records drive re-attachment after `/reload` or a crash; a record left `queued` with a handle (or a blocking record left `running`) means its owner died mid-flight, and the next session start closes that target (only if it can still prove ownership) and releases its worktree. On startup, run directories older than `PI_HERDR_SUBAGENT_RETENTION_DAYS` (default 14; `0` disables) are pruned in the background, except the current session's. `/subagent-prune [days]` prunes on demand.

Blocking children remain visible and attachable while running, then shut down and auto-close after the parent collects their result. Set `PI_HERDR_SUBAGENT_EXIT_ON_FINISH=0` on the parent to retain completed blocking targets for inspection. A blocking subagent fallback attempt belongs to the same logical tool call and must not produce multiple successful results.

## Trust and isolation

- A child working inside the trusted caller project may inherit project approval.
- A child outside that tree starts without project approval.
- Trust follows the caller's source directory, so a worktree of a trusted project is trusted.
- Reported child mode registers only its result reporter and does not register delegation tools.
- Both delegation tool names are excluded from all child `--tools` allowlists.
- Profile file contents are configuration; Markdown bodies are ignored.
- Shell commands must continue to use argument-safe construction and private run files.
- tmux children never inherit `HERDR_*` variables.
- Returned output remains capped at Pi's standard 50 KB / 2,000-line tool limit; the complete child session stays on disk.

## Expected files

```text
extensions/subagent.ts                   runner, child mode, and tool registration
extensions/lib/subagent-backends.ts      Herdr and tmux backends, backend selection
extensions/lib/subagent-profiles.ts      profile discovery, parsing, and validation
extensions/lib/agent-ref-autocomplete.ts & reference completion
extensions/tests/                        runner (fake Herdr), real-tmux, profile, and autocomplete tests
agents/*.md                              user-authored profile files
```

The exact module split may change, but profile parsing and autocomplete must share one registry implementation.

## Validation

Add focused tests for:

- String and array model parsing.
- Ordered fallback on provider, task, tool, unclassified, startup, and unexpected child-exit failures.
- Fallback waits for the final result; no added same-model retries, no fallback on abort, and no attempts beyond the configured model list.
- Inherited model and thinking behavior.
- Tool allowlist validation and removal of both delegation tools.
- Immediate `subagent_async` dispatch followed by one automatic steer delivery when its result appears.
- Async failure delivery, tab cleanup, tool stripping, and parent-shutdown cancellation.
- Async model fallback, and fast startup-failure fallback.
- `/reload` detaching and re-attaching async runs with a single delivery, on Herdr and tmux.
- Auto, explicit, and unavailable backend selection; a backend change after launch leaving existing runs on their backend.
- tmux argv/task-file delivery, `HERDR_*` scrubbing, closing only the run's own window, and worktree release rules.
- Worktree creation and branch reporting; retention of dirty checkouts; removal of no-commit branches; in-place fallback outside Git.
- Age-based pruning of run directories.
- Unknown and malformed profiles.
- Multiple sibling calls running concurrently.
- Independent cancellation and shutdown cleanup for multiple children.
- `&` matching at start-of-input and after whitespace.
- Case-insensitive prefix filtering.
- Literal insertion with one trailing space.
- Delegation to the wrapped autocomplete provider outside `&` tokens.
- Autocomplete and execution resolving profiles from the same registry.

## Acceptance criteria

- The parent invokes a named blocking or asynchronous profile and supplies only the complete task and optional working directory.
- Profiles contain only `name`, `model`, `thinking`, `tools`, and `worktree` frontmatter.
- Ordered model fallback works for every final failed attempt except cancellation, in blocking and async calls; Pi's internal retries are unchanged and the runner adds no same-model retries.
- Isolated profiles never write to the parent checkout, and their commits are reported as a branch for the parent to integrate.
- Async runs survive `/reload`.
- The parent can launch as many sibling calls as it chooses without an extension-wide serial queue.
- Each child remains visible and inspectable in Herdr or tmux while running; completed blocking and async targets auto-close.
- Async completion and failure are delivered at most once (never duplicated) as steer messages without polling by the model.
- Typing `&` offers current profile names and inserts a literal `&name ` reference.
- A valid reference routes through `subagent_async`, including `&worker`, while leaving task composition to the parent.
- No workflow, chain, automatic role prompt, profile concurrency, or nested-subagent system is introduced.
