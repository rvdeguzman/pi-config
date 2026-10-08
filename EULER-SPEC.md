# Euler and portable subagents

## Status

Approved direction; first implementation landed (see [Implementation notes](#implementation-notes)). Euler is a stripped-down, Pi-native operating mode inspired by selected pstack ideas. It does not install, vendor, or wrap pstack's playbooks, agents, model routing, or Cursor-specific runtime.

The same implementation generalizes the existing Herdr subagent runner so delegated children can run in either Herdr or tmux.

## Goals

- `/e` lets the user give an outcome and constraints once, then lets the agent own reversible execution choices.
- Euler addresses the user's main concerns: preserving intent and taste, avoiding overbuilding, and avoiding validation theater.
- One shared delegation runner serves Euler and ordinary sessions.
- Subagent backend selection is automatic, with an explicit override.
- Existing profile, async/blocking, worktree, model-fallback, result-file, and reload guarantees remain intact.

## Euler

### Files

```text
extensions/euler.ts
skills/euler/SKILL.md
skills/euler/UPSTREAM.md
```

`SKILL.md` is the single source of truth for Euler's behavior. It sets `disable-model-invocation: true`, so the model does not load it accidentally; `/skill:euler` remains available as a one-off fallback.

`UPSTREAM.md` records the pinned pstack baseline (`cursor/plugins` commit `e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`, pstack 0.15.9), MIT license provenance, and that Euler adapts ideas rather than copying pstack's runtime.

### Commands

- `/e <task>`: enable Euler for the current session branch, then submit `<task>` as an ordinary user message.
- `/e`: enable Euler without sending a message.
- `/e off`: disable Euler.
- `/e status`: report whether Euler is active.
- `/euler`: alias with the same arguments.

Activation is session-branch state. Persist each on/off change with `pi.appendEntry()`, and reconstruct state from `ctx.sessionManager.getBranch()` on `session_start`, `session_tree`, and other relevant session changes. Abandoned branches must not change the active state.

While active:

- Add the Euler body to the system prompt before each agent run, preferring structured system-prompt sections over replacing the complete prompt.
- Show a compact `euler` status indicator in TUI mode.
- Do not add Euler-specific model tools, model routing, todo machinery, mandatory subagents, or another workflow engine. `/goal` is the one exception: `goal_checkpoint` exists only while a goal is active.

### Goals

Files: `extensions/lib/euler-goal.ts` (registered by `euler.ts`), policy in `skills/euler/goal.md` and `skills/euler/away.md`, tests in `extensions/tests/euler-goal.test.ts` (a real Pi session against a scripted model).

- `/goal <objective> [--until "<check>"] [--max N] [--away]` turns Euler on and submits the objective. `/goal`/`/goal status`, `/goal stop`, and `/goal resume` manage it.
- An iteration is one reply. At `agent_before_settle` the extension runs the check and either ends the goal or appends an iteration message with the output tail and continues. The check is the only proof of done when present; the agent's `done` checkpoint is advisory. Without a check, the agent's `done` ends the goal.
- Checks run as `bash -c` in the session cwd, in their own process group, with a 20-minute timeout: SIGTERM to the group, then SIGKILL after 5 seconds. Only a normal exit with code 0 passes; a signal, timeout, or abort never does. Leftover processes in the group are terminated when the check exits.
- A goal ends on: check passes, `blocked` checkpoint, iteration budget, a model or provider error, `/goal stop`, or Esc. Esc and `/goal stop` also kill a running check, including the startup check.
- A goal is live only while this process runs it. A run that settles with the goal still live (Esc, invalid continuation) ends it as interrupted. A goal rebuilt from history is never live: `/tree` into an old goal does not revive it, and a goal cut off by a crash is recorded as interrupted at the next session start. `/goal resume` restarts it.
- Starting refuses a check that already passes, and an away goal without a check.
- Away goals hide `ask_user_question` and block calls to it, including indirect `executeTool()` calls, until the run settles, report turn included. Its prior state is restored afterward. Branch, no-push, and report rules are prompt policy in `away.md`.
- State is branch-scoped: start and end custom entries, iteration custom messages, and `goal_checkpoint` tool results. Summaries and `/goal` show the per-iteration log from those entries; there is no separate log file.
- Out of scope: timed or event wake-ups (`/loop`), worktree creation, push/merge automation, cross-model review of the log.

### Behavior contract

Euler's instructions must cover:

1. **Intent:** infer the outcome, taste constraints, preservation requirements, non-goals, and done condition from the conversation. Ask only when a missing answer would materially change product direction or authority.
2. **Route:** implement understood changes directly; use a small runnable or visual slice for uncertain taste/feasibility; sketch a consequential interface/data shape before broad implementation.
3. **Ownership:** make reversible implementation decisions without asking. Escalate product-direction changes, material scope expansion, destructive or external actions, credential use, deployment, publishing, spending, pushes, and merges of work that is not the agent's own unless already authorized. Merging the agent's own subagent branch into the current local branch is integration.
4. **Simplicity:** use existing mechanisms; add abstractions, dependencies, and extension points only for current needs.
5. **Evidence:** choose checks that discriminate a correct result from plausible failure. Stop when changed behavior and affected preservation requirements are established. Test rules live in the global `AGENTS.md`, so delegated children follow them too.
6. **Delegation:** use subagents only when they provide useful parallelism, specialist context, review separation, or worktree isolation. The how lives in the runner's `agent_profiles` section (SUBAGENT-SPEC.md), which applies with or without Euler. Parent agents still integrate and evaluate child work.
7. **Report:** state what changed, what was preserved, relevant evidence, and remaining limitations. Prefer a concise report over a ceremonial checklist.

## Portable subagent runner

### Public interface

Rename the model-facing tools to backend-neutral names:

```ts
subagent({ agent: string; task: string; cwd?: string })
subagent_async({ agent: string; task: string; cwd?: string })
```

Keep the existing semantics:

- `subagent` blocks until the child result is collected.
- `subagent_async` returns once the first launch attempt is running, then steers the bounded result back automatically.
- `worker` remains async-only.
- `&name` references route through `subagent_async`, including `&worker`.
- Both delegation tools are stripped from every child, including profiles that list them.

Update prompt guidance, `&name` instructions, skills, docs, and tests that mention `herdr_subagent` or `herdr_async`. Do not keep duplicate active aliases: two names for one capability add model context and ambiguity.

Agent profiles stay unchanged: only `name`, `model`, `thinking`, `tools`, and `worktree`. Backend selection is not a profile field.

### Backend selection

Add `/subagent-backend [auto|herdr|tmux]`.

- No argument reports the configured and resolved backend.
- An argument persists the setting in ignored `~/.pi/agent/subagents.json`.
- `PI_SUBAGENT_BACKEND=auto|herdr|tmux` overrides the file for that process.
- Default is `auto`.

`auto` resolves once per logical delegated run:

1. Herdr when the parent is in a Herdr-managed pane and the Herdr CLI is available.
2. Otherwise tmux when the tmux CLI is available.
3. Otherwise fail before launch with an actionable error.

An explicit backend fails closed when unavailable. Never fall back after a launch side effect starts.

Changing the setting affects new runs only. Persist `backend` and an opaque backend `handle` on each run record. Every model fallback attempt, probe, reattach, cancellation, and cleanup uses the run's persisted backend. Legacy records without `backend` are Herdr records.

### Backend interface

Factor launch-host operations behind a small interface:

```ts
preflight(): Promise<void>
launch(request, onCreated: (handle) => Promise<void>): Promise<BackendHandle>
probe(handle): Promise<"alive" | "gone" | "unknown" | { status: AgentStatus; sessionFile?: string }>
tail(handle, lines): Promise<string | undefined>
close(handle, options?: { verify?: boolean }): Promise<"closed" | "already_gone">
commands(handle): { target; attach; capture; close }
createCheckout?(options): Promise<{ path; workspaceId?; placeholder? }>   // Herdr-managed worktrees
```

`onCreated` runs as soon as the target exists, before startup completes, so the runner can persist and clean it up. `verify` closes only a target the backend can still prove belongs to the run (crash cleanup of possibly recycled ids). `commands` is pure, so persisted handles render without touching the backend.

Keep backend-neutral: profile resolution, tool allowlists, model fallback, task files, result files, child reporting, monitoring, async delivery, run persistence, pruning, Git inspection, and worktree release rules.

### Herdr backend

Preserve current behavior as closely as practical: Herdr tabs/workspaces, `agent start`, `agent prompt`, readiness and blocked-state detection, Herdr-managed worktree placement, root-tab replacement, attach/capture/kill strings, and existing tests.

### tmux backend

- Inside tmux, create background windows in the current tmux session.
- Outside tmux, create or reuse a detached session named `pi-subagents`.
- Use argv-based command construction, not interpolated shell strings for task text.
- Deliver the task through a private task file read by child mode, avoiding paste/type races and shell quoting.
- Remove inherited `HERDR_*` variables from tmux children so Herdr integrations do not activate.
- Report attach, capture, and close commands with the exact tmux target.
- Determine liveness from tmux window/pane state. tmux cannot report Pi's blocked state; report blocked status as unknown and rely on the result file and liveness.
- Name tmux targets with enough run-id material to avoid collisions.
- Close only targets created for that run.

For isolated profiles under tmux, create a Git worktree directly from committed `HEAD` on the same branch scheme. Store backend-created checkouts under the agent directory. Keep the same never-force cleanup rules: retain dirty checkouts, keep branches with commits, and remove clean no-commit checkouts and branches.

## Safety fixes in scope

- Persist enough run state before or immediately after a launch side effect to identify and clean up its backend target and worktree.
- Route all child closes through the persisted backend; remove direct Herdr calls from shutdown paths.
- Keep cleanup idempotent.
- Preserve reload reattachment for async runs on both backends.

Exactly-once delivery across multiple concurrently open parent processes and run leases are out of scope for this pass; do not claim stronger guarantees than implemented.

## Verification

Use focused tests that would fail for real regressions:

- Euler activation follows the active session branch and only active branches receive Euler instructions.
- `/e <task>` activates Euler and submits the task once.
- Auto, explicit, and unavailable backend selection.
- A backend change after launch does not change an existing run's backend.
- tmux launch uses argv/task-file delivery, scrubs `HERDR_*`, and closes only its own target.
- tmux async completion and reload reattachment deliver one result.
- tmux worktree cleanup preserves dirty checkouts and committed branches.
- Existing Herdr subagent tests continue to cover Herdr behavior after the tool rename.

Run `make -C extensions/tests test`. Add a minimal real-tmux smoke check with an isolated tmux socket and a stub command if practical; a live model request is unnecessary.

## Non-goals

- Installing or vendoring pstack.
- Copying pstack playbooks, sticky mode metadata, setup commands, model matrices, or verifier swarms.
- New agent profile fields.
- Automatic merges, pushes, deployments, or PR babysitting.
- Hidden/background tmux runs with no attach command.
- Remote/cloud agent backends.

## Implementation notes

Where the first implementation refines or departs from the text above:

- **Modules.** `extensions/subagent.ts` (renamed from `herdr-subagent.ts`) is the runner; `extensions/lib/subagent-backends.ts` holds both backends and selection. `/herdr-prune` became `/subagent-prune`, the async widget/message type became `subagent-async-result`, and parent guidance moved to an `agent_profiles` system-prompt section.
- **Kept names.** Child-mode environment variables (`PI_HERDR_SUBAGENT_*`) and the run directory `~/.pi/agent/herdr-subagents/` keep their names so in-flight runs and existing records stay compatible across `/reload`.
- **tmux task delivery.** The child reads `task.md` via `PI_HERDR_SUBAGENT_TASK`, submits it shortly after `session_start` (interactive Pi wires its renderer after session handlers finish), and writes `result.json.started`. Launch waits for that marker up to 45 s; a pane that dies first is a startup failure, eligible for model fallback.
- **tmux targets.** Windows are tagged with a run-id option and keep dead panes for diagnostics; probes and closes act only on a tagged window. The detached `pi-subagents` session is found by a session tag, because user tmux hooks may rename sessions; attach commands therefore address the window id (`attach-session -t @7 \; select-window -t @7`) with an explicit `-S <socket>`.
- **Herdr ownership.** Probes treat a pane now hosting a differently named agent as gone.
- **Orphan window.** A record is saved once the run owns a worktree and again in `onCreated`, while still `queued`. Shutdown cancels and closes blocking runs and async runs that have not finished launching (including on `/reload`); launched async runs are detached. On the next session start, a record left `queued` with a handle, or a blocking record left `running`, is closed with `verify` and its worktree released.
- **Delivery.** Async delivery is at most once: `delivered` is saved before the steer.
- **Status.** The `euler` status uses `ctx.ui.setStatus`; `minimal-footer.ts`, which replaces the built-in footer, shows it before the model name.
- **Tests.** `make -C extensions/tests test-subagents` runs the Herdr runner tests (fake CLI) and real-tmux tests on an isolated `TMUX_TMPDIR` with a stub `pi`; `make -C extensions/tests test-euler` runs Euler's branch-state tests against Pi's in-memory `SessionManager`.
