# Minimal Pi Subagent Plugin

## Status

Design specification. No implementation yet.

## Goal

Provide one small Pi extension that lets the parent delegate focused work to isolated child Pi processes without introducing a workflow/orchestration framework.

## Non-goals for v1

- Missions, schedules, or durable jobs
- Nested subagents
- FleetView or custom inspectors
- Git worktree management
- Watchdog/policy framework
- Named agent profiles
- Conversation inheritance
- Automatic multi-step workflows

## User-facing API

Register one tool named `subagent`.

### Start one child

```ts
subagent({
  action: "run",
  task: string,
  background?: boolean,
  model?: string,
  thinking?: string,
  systemPrompt?: string,
  tools?: string[],
  cwd?: string,
})
```

`task` is required. `background` defaults to `false`.

Foreground execution waits for completion and returns the result. Background execution returns immediately with an ID.

### Run children in parallel

```ts
subagent({
  action: "parallel",
  tasks: [
    { task: string, ...options },
    { task: string, ...options },
  ],
})
```

The call returns one ID per child. The parent controls concurrency by the number of tasks submitted; no durable queue is required in v1.

### Inspect or retrieve a child

```ts
subagent({ action: "status", id: string })
subagent({ action: "result", id: string })
```

`result` returns the final result when complete and a clear pending status otherwise.

### Stop a child

```ts
subagent({ action: "stop", id: string })
```

Stopping is best-effort and produces terminal status `stopped`.

## Result contract

Every run returns or stores:

```ts
type SubagentResult = {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  output?: string;
  error?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
};
```

The normal result is the child’s final assistant text. Intermediate tool output is optional progress, not part of the stable result contract.

## Execution model

The extension has two core modules:

```text
index.ts   — registers and validates the subagent tool
runner.ts  — starts, communicates with, and stops child Pi processes
```

A run should:

1. Validate the request.
2. Create a run ID and in-memory record.
3. Spawn a separate child process:
   ```text
   pi --mode rpc --no-session ...
   ```
4. Pass the task and child configuration through the RPC startup request or a temporary task file.
5. Read newline-delimited JSON events from stdout.
6. Forward selected progress events to the parent tool’s update callback.
7. Resolve the run on child completion.
8. Kill the owned process group on stop, abort, or unrecoverable failure.

The child receives an explicit task and a small system prompt identifying it as a subagent. It does not receive the parent conversation.

## Child configuration

Per-call overrides are supported for:

- `model`
- `thinking`
- `systemPrompt`
- `tools`
- `cwd`

Defaults come from the parent Pi invocation where possible. The child otherwise uses normal Pi behavior. Parent permissions are inherited as requested; v1 does not create a separate policy system.

The runner must prevent accidental recursive delegation by excluding this extension’s `subagent` tool from child tools unless explicitly enabled later.

## Lifecycle and storage

Run records are held in memory for v1. A background run remains queryable for the lifetime of the parent Pi process.

No session transcript or durable mission record is required. Temporary task/control files must be cleaned up after terminal completion.

If the parent exits, background children should be stopped when practical; orphan recovery is out of scope.

## Error handling

Report clear terminal failures for:

- Missing or invalid task
- Unknown action
- Unknown run ID
- Child startup failure
- RPC timeout or malformed event
- Non-zero child exit
- Parent cancellation

Never silently convert a failed child into a successful empty result.

## Concurrency

Parallel runs use independent child processes and run records. The runner should impose a small configurable active-child limit to avoid accidental resource exhaustion; exceeding it returns an error rather than adding a queue in v1.

## Acceptance criteria

- A foreground task returns the child’s final text.
- A background task returns an ID immediately.
- `status` reports running and terminal states.
- `result` returns the final output after completion.
- `stop` terminates a running child and reports `stopped`.
- Parallel tasks can run independently and retain separate results.
- Child failures include actionable error text.
- Parent cancellation stops the owned child process.
- The extension does not modify the project checkout during read-only tasks.
- No implementation adds workflows, profiles, schedules, nested delegation, or UI infrastructure.

## Design principle

Keep the delegation path shallow:

```text
one tool → one runner → one Pi child process
```

Add another layer only when a concrete use case cannot be handled by the runner and a small run record.
