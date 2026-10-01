# Herdr Subagents with Agent Profiles

## Status

Approved design specification, revision 3: Herdr-native launch, worktree isolation, reload survival, and run-directory retention. Revision 3 removed the fire-and-forget `herdr_worker`, `herdr_send` follow-ups, and `herdr_interrupt`. This replaces the previous asynchronous RPC/fleet design.

## Goal

Keep the observable Herdr-backed subagent runner, with child runtime configuration in small named agent profiles, and provide both blocking and asynchronous execution paths.

The responsibility split is:

- The caller/parent chooses the agent profile for a blocking `herdr_subagent` or asynchronous `herdr_async` call.
- The caller/parent writes the complete delegated task.
- The agent profile selects the model, thinking level, and tools.
- The caller/parent decides how many children to launch and whether those calls are parallel or sequential.
- `herdr_subagent` waits for a result.
- `herdr_async` returns launch coordinates immediately, monitors in the background, and steers the final result back automatically.
- Profiles marked `worktree: true` run each child on its own Git branch in a Herdr-managed worktree.

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
model: anthropic/claude-opus-5.5
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
- Fallback occurs only for retryable provider failures such as rate limiting, temporary unavailability, authentication/provider startup failure, or a model being unavailable. A child Pi that exits before Herdr sees it ready counts as a startup failure.
- Fallback applies to blocking and async runs.
- Task errors, tool failures, invalid configuration, explicit aborts, and user cancellation do not advance to another model.
- `thinking` applies to every candidate and is clamped by the selected model's capabilities.
- A missing `thinking` value inherits the caller's current thinking level.

### Tool resolution

- `tools` is the child's complete active-tool allowlist.
- The reserved entry `extensions` expands to every extension-registered tool the caller has loaded with `direct` or `model-only` exposure (Pi built-in and SDK tools are excluded), e.g. `tools: [read, grep, find, ls, extensions]`. A real tool named `extensions` takes precedence over the token.
- A missing `tools` value inherits the caller's active tools, excluding the delegation tools to prevent recursive delegation.
- Both delegation tools (`herdr_subagent`, `herdr_async`) are removed from every child tool allowlist, even if a profile names them explicitly.
- Unknown tool names are configuration errors and must be reported before launching the child.
- Tool restrictions are capability reduction inside Pi, not an operating-system sandbox.

Read-only profiles should not include `bash`: a prompt cannot prevent a shell tool from mutating the checkout.

## Tool API

The blocking model-facing tool remains one-child-per-call:

```ts
herdr_subagent({
  agent: string;
  task: string;
  cwd?: string;
})
```

The asynchronous tool has the same profile/task shape, returns immediately, and later delivers a custom steer message with the bounded result:

```ts
herdr_async({
  agent: string;
  task: string;
  cwd?: string;
})
```

Async runs are session-scoped: quitting or switching sessions cancels them and closes their tabs. A `/reload` does not: children keep running, run records stay on disk, and the reloaded extension re-attaches and delivers each pending result exactly once. Async runs use ordered model fallback like blocking runs.

None of the tools accepts model, thinking, tools, parallel count, chain, or workflow parameters. Those concerns belong to the selected profile or the caller. The `worker` profile is async-only.

Example:

```ts
herdr_subagent({
  agent: "scout",
  task: "Map the authentication initialization flow. Cite exact files and explain unresolved gaps.",
})
```

The extension exposes the available profile names in the tool description so the caller can select one. An unknown profile is a hard error that lists the available names.

## Concurrency

The caller controls concurrency by issuing the desired number of ordinary `herdr_subagent` or `herdr_async` calls.

- Sibling calls emitted by the parent may execute concurrently through Pi's normal parallel tool execution.
- Sequential blocking subagent calls remain sequential when the parent waits for one result before issuing the next.
- Async calls return immediately and independently steer each final result into the parent session.
- Profiles do not contain `max_parallel` or any equivalent field.
- The current extension-wide serial queue must be removed.
- The implementation may retain a fixed defensive process ceiling only as a safety guard; it must not choose how many agents the caller should spawn.

Each reported call has independent cancellation, result data, Herdr identifiers, and lifecycle state. Session shutdown closes unfinished blocking and async children owned by that parent session.

## `&agent` references and autocomplete

Humans can explicitly reference a profile in the editor:

```text
&scout map the authentication flow
&researcher find the current upstream API behavior
&worker implement the approved change and run the focused tests
```

An `&name` reference is an instruction to the parent to use that agent profile asynchronously through `herdr_async`. This includes `&worker`. It does not bypass the parent or launch a child directly: the parent still writes the complete task, adding relevant context and constraints from the conversation.

Every reference requests a fresh async child invocation. It does not address or steer an already-running child. `herdr_subagent` remains available for parent-selected blocking dependencies.

### Autocomplete behavior

Install an autocomplete provider through `ctx.ui.addAutocompleteProvider()`:

- Trigger on `&` only; do not interfere with Pi's `@` file completion.
- Match a token at the start of input or after whitespace.
- Match profile names by case-insensitive prefix.
- Read suggestions from the same profile registry used by both Herdr delegation tools.
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

When profiles are available, add concise guidance to the parent system prompt:

- Treat a valid `&name` reference as the user's explicit request to delegate asynchronously through that profile.
- Route every valid reference through `herdr_async`, including `&worker`.
- Compose a complete, self-contained task for each child rather than forwarding an underspecified fragment blindly.
- Use `herdr_subagent` only for a parent-selected blocking dependency.
- Do not add model, thinking, or tool overrides; the profile owns those settings.
- The number and ordering of child calls remain the parent's decision unless the user explicitly requests particular references or parallelism.

## Herdr execution

Requires Herdr 0.9+ (`agent start`, `agent prompt --wait --until`, `pane process-info`, `worktree create`).

### Launch protocol

1. `herdr tab create --no-focus --env …` creates a background tab whose shell carries the child-mode environment (result path and exit-on-finish). Outside Herdr, `workspace create` is used instead.
2. `herdr agent start <name> --kind pi --pane <pane> -- <pi args>` launches Pi. Herdr returns only once it recognizes a ready Pi agent, so there is no type-into-shell race. While it waits, the parent polls `pane process-info`; if the shell regains the foreground, Pi exited during startup and the attempt fails within seconds instead of at Herdr's 45 s timeout.
3. `herdr agent prompt <pane> <task> --wait --until working --until blocked` submits the task and confirms the turn started.

### Completion

The child writes an atomic result file on `agent_settled`; that file is the only completion truth. The parent watches the run directory with `fs.watch` (plus a 1 s fallback stat) and probes Herdr (`agent get`) every 2 s for blocked state and liveness. An agent that disappears without a result fails after a short grace period, with the pane tail as context. Blocking calls also read the pane every 2 s for their live preview; async monitors do not.

### Worktree isolation

When the profile sets `worktree: true` and the working directory is inside a Git repository with at least one commit:

1. `herdr worktree create` creates branch `pi/<profile>-<run8>` from the source repository's committed `HEAD` and opens it as a workspace. The child tab is created there and the workspace's root tab is closed. The child's cwd keeps the caller's relative subdirectory.
2. A short note is appended to the task: the checkout path, branch, and base commit; that uncommitted parent changes are absent; and that the child must commit on the branch and must not merge, rebase, push, or switch branches.
3. After the run, the parent inspects the checkout (commits since base, diffstat, uncommitted changes):
   - Uncommitted changes: the checkout and its tab are retained and reported.
   - Clean with commits: the tab closes, the checkout is removed with `git worktree remove` (never forced), and the branch is kept and reported with an integration hint.
   - Clean without commits: the checkout and branch are removed.
4. A launch failure or abort applies the same release rules. The extension never commits, merges, or deletes a branch that has commits. Integration is the parent's job.

Outside a Git repository, the run proceeds in place and the result says so. Parallel isolated runs are allowed because each one gets a unique branch.

### Per tool

- `herdr_subagent`: launch, monitor, settle, and return the bounded result. Progress updates include the attach and capture commands. Retryable failures move to the next model candidate in a fresh tab.
- `herdr_async`: return the run id and Herdr coordinates once the first child is running. A session-scoped monitor tracks it in the parent widget, auto-closes the tab, and injects a visible `herdr-async-result` custom message with `deliverAs: "steer"` and `triggerTurn: true`.

### Run records and retention

Each run writes `run.json` next to its `task.md`, session directory, and result file under `~/.pi/agent/herdr-subagents/<parent session>/<run>/`. Records drive re-attachment after `/reload` or a crash. On startup, run directories older than `PI_HERDR_SUBAGENT_RETENTION_DAYS` (default 14; `0` disables) are pruned in the background, except the current session's. `/herdr-prune [days]` prunes on demand.

Blocking children remain visible and attachable while running, then shut down and auto-close after the parent collects their result. Set `PI_HERDR_SUBAGENT_EXIT_ON_FINISH=0` on the parent to retain completed blocking tabs for inspection. A blocking subagent fallback attempt belongs to the same logical tool call and must not produce multiple successful results.

## Trust and isolation

- A child working inside the trusted caller project may inherit project approval.
- A child outside that tree starts without project approval.
- Trust follows the caller's source directory, so a worktree of a trusted project is trusted.
- Reported child mode registers only its result reporter and does not register delegation tools.
- Both delegation tool names are excluded from all child `--tools` allowlists.
- Profile file contents are configuration; Markdown bodies are ignored.
- Shell commands must continue to use argument-safe construction and private run files.
- Returned output remains capped at Pi's standard 50 KB / 2,000-line tool limit; the complete child session stays on disk.

## Expected files

```text
extensions/herdr-subagent.ts        Herdr runner and tool registration
extensions/subagent-profiles.ts     profile discovery, parsing, and validation
extensions/agent-ref-autocomplete.ts  & reference completion
extensions/tests/                    profile, fallback, concurrency, and autocomplete tests
agents/*.md                          user-authored profile files
```

The exact module split may change, but profile parsing and autocomplete must share one registry implementation.

## Validation

Add focused tests for:

- String and array model parsing.
- Ordered fallback on retryable provider failure.
- No fallback on task/tool failure or abort.
- Inherited model and thinking behavior.
- Tool allowlist validation and removal of both delegation tools.
- Immediate `herdr_async` dispatch followed by one automatic steer delivery when its result appears.
- Async failure delivery, tab cleanup, tool stripping, and parent-shutdown cancellation.
- Async model fallback, and fast startup-failure fallback.
- `/reload` detaching and re-attaching async runs with exactly-once delivery.
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
- Ordered model fallback works only for retryable provider or startup failures, in blocking and async calls.
- Isolated profiles never write to the parent checkout, and their commits are reported as a branch for the parent to integrate.
- Async runs survive `/reload`.
- The parent can launch as many sibling calls as it chooses without an extension-wide serial queue.
- Each child remains visible and inspectable in Herdr while running; completed blocking and async tabs auto-close.
- Async completion and failure are delivered exactly once as steer messages without polling by the model.
- Typing `&` offers current profile names and inserts a literal `&name ` reference.
- A valid reference routes through `herdr_async`, including `&worker`, while leaving task composition to the parent.
- No workflow, chain, automatic role prompt, profile concurrency, or nested-subagent system is introduced.
