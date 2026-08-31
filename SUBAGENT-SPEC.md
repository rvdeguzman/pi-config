# Herdr Subagents with Agent Profiles

## Status

Approved design specification. This replaces the previous asynchronous RPC/fleet design.

## Goal

Keep the observable Herdr-backed subagent runner, with child runtime configuration in small named agent profiles, and provide a second fire-and-forget path for implementation workers.

The responsibility split is:

- The caller/parent chooses the agent profile for a blocking `herdr_subagent` call.
- `herdr_worker` always uses the `worker` profile.
- The caller/parent writes the complete delegated task.
- The agent profile selects the model, thinking level, and tools.
- The caller/parent decides how many children to launch and whether those calls are parallel or sequential.
- `herdr_subagent` waits for a result; `herdr_worker` returns launch coordinates immediately and never polls for completion.

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

### Frontmatter schema

```ts
type AgentProfile = {
  name: string;
  model?: string | string[];
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
};
```

No other profile fields are supported. In particular, profiles do not define prompts, descriptions, extensions, durations, background behavior, workflows, or concurrency.

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
- Fallback occurs only for retryable provider failures such as rate limiting, temporary unavailability, authentication/provider startup failure, or a model being unavailable.
- Task errors, tool failures, invalid configuration, explicit aborts, and user cancellation do not advance to another model.
- `thinking` applies to every candidate and is clamped by the selected model's capabilities.
- A missing `thinking` value inherits the caller's current thinking level.

### Tool resolution

- `tools` is the child's complete active-tool allowlist.
- A missing `tools` value inherits the caller's active tools, excluding both `herdr_subagent` and `herdr_worker` to prevent recursive delegation.
- Both delegation tools are removed from every child tool allowlist, even if a profile names them explicitly.
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

The fire-and-forget worker tool is also one-child-per-call, but fixes profile selection to `worker`:

```ts
herdr_worker({
  task: string;
  cwd?: string;
})
```

`herdr_worker` returns the created workspace, tab, and pane IDs plus attach, capture, and cleanup commands as soon as `herdr pane run` accepts the launch. It does not create or poll a result file, read pane output, query agent state, retry another model, or deliver a later completion result.

Neither tool accepts model, thinking, tools, parallel count, chain, or workflow parameters. Those concerns belong to the selected/fixed profile or the caller.

Example:

```ts
herdr_subagent({
  agent: "scout",
  task: "Map the authentication initialization flow. Cite exact files and explain unresolved gaps.",
})
```

The extension exposes the available profile names in the tool description so the caller can select one. An unknown profile is a hard error that lists the available names.

## Concurrency

The caller controls concurrency by issuing the desired number of ordinary `herdr_subagent` or `herdr_worker` calls.

- Sibling calls emitted by the parent may execute concurrently through Pi's normal parallel tool execution.
- Sequential subagent calls remain sequential when the parent waits for one result before issuing the next.
- Worker calls return immediately after dispatch, so later parent work does not depend on worker completion unless the parent or user explicitly inspects the returned Herdr pane.
- Profiles do not contain `max_parallel` or any equivalent field.
- The current extension-wide serial queue must be removed.
- The implementation may retain a fixed defensive process ceiling only as a safety guard; it must not choose how many agents the caller should spawn.

Each call has independent cancellation, result data, Herdr identifiers, and lifecycle state. Session shutdown closes every unfinished child owned by that parent session, not just one active tab.

## `&agent` references and autocomplete

Humans can explicitly reference a profile in the editor:

```text
&scout map the authentication flow
&researcher find the current upstream API behavior
&worker implement the approved change and run the focused tests
```

An `&name` reference is an instruction to the parent to use that agent profile. It does not bypass the parent or launch a child directly. The parent still writes the complete `task` passed to `herdr_subagent`, adding relevant context and constraints from the conversation.

Every reference requests a fresh child invocation. It does not address or steer an already-running child.

### Autocomplete behavior

Install an autocomplete provider through `ctx.ui.addAutocompleteProvider()`:

- Trigger on `&` only; do not interfere with Pi's `@` file completion.
- Match a token at the start of input or after whitespace.
- Match profile names by case-insensitive prefix.
- Read suggestions from the same profile registry used by `herdr_subagent`.
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

- Treat a valid `&name` reference as the user's explicit request to delegate through that profile.
- Compose a complete, self-contained task for each child rather than forwarding an underspecified fragment blindly.
- Do not add model, thinking, or tool overrides; the profile owns those settings.
- The number and ordering of child calls remain the parent's decision unless the user explicitly requests particular references or parallelism.

## Herdr execution

The existing Herdr transport remains the execution backend.

For `herdr_subagent`:

1. Resolve and validate the selected profile.
2. Resolve the ordered model candidates, thinking level, and tool allowlist.
3. Write the caller-authored task to the run directory.
4. Create a background Herdr tab in the caller's workspace.
5. Launch a separate Pi process with the resolved configuration and isolated session directory.
6. Poll the atomic `result.json` as the authoritative completion result.
7. Use Herdr pane and agent state for progress, blocked state, attachment, and inspection.
8. Return the bounded result with attach, capture, cleanup, and child-session information.

For `herdr_worker`:

1. Resolve the fixed `worker` profile and its first model candidate, thinking level, and tool allowlist.
2. Write the caller-authored task to a private worker run directory.
3. Create a background Herdr tab and launch the child Pi process with a worker-child environment marker.
4. Return the workspace/tab/pane IDs and attach, capture, and cleanup commands immediately after successful dispatch.
5. Perform no completion, pane-output, agent-state, sentinel, or result-file polling.

Completed children and their Pi sessions remain alive for inspection and continued conversation until explicitly closed. A blocking subagent fallback attempt belongs to the same logical tool call and must not produce multiple successful results. Fire-and-forget workers do not attempt model fallback because the parent does not observe completion.

## Trust and isolation

- A child working inside the trusted caller project may inherit project approval.
- A child outside that tree starts without project approval.
- Blocking child mode registers only its result reporter and does not register delegation tools.
- Worker child mode registers neither `herdr_subagent` nor `herdr_worker` and performs no result reporting.
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
- Worker-child suppression of delegation tool registration.
- Immediate `herdr_worker` dispatch with returned tab/pane/attach commands and no result polling.
- Unknown and malformed profiles.
- Multiple sibling calls running concurrently.
- Independent cancellation and shutdown cleanup for multiple children.
- `&` matching at start-of-input and after whitespace.
- Case-insensitive prefix filtering.
- Literal insertion with one trailing space.
- Delegation to the wrapped autocomplete provider outside `&` tokens.
- Autocomplete and execution resolving profiles from the same registry.

## Acceptance criteria

- The parent invokes a named blocking profile, or the fixed fire-and-forget worker, and supplies only the complete task and optional working directory.
- Profiles contain only `name`, `model`, `thinking`, and `tools` frontmatter.
- Ordered model fallback works only for retryable provider failures in blocking subagent calls.
- `herdr_worker` returns Herdr launch coordinates immediately and never polls for completion.
- The parent can launch as many sibling calls as it chooses without an extension-wide serial queue.
- Each child remains visible and inspectable in Herdr.
- Typing `&` offers current profile names and inserts a literal `&name ` reference.
- A valid reference tells the parent which profile to use while leaving task composition to the parent.
- No workflow, chain, automatic role prompt, profile concurrency, or nested-subagent system is introduced.
