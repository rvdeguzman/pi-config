# Plan mode

A global Pi extension providing read-only planning and tracked implementation.

## Commands

- `/plan` — toggle plan mode
- `/implement` — execute in a fresh linked session with a full context budget (default)
- `/implement-compact` — compact the planning conversation, then execute there
- `/implement-here` — execute directly in the current full context
- `/plan-status` — show progress for the captured plan
- `Ctrl+Alt+P` — toggle plan mode

You can also start Pi directly in plan mode with `pi --plan`.

While planning, `bash`, `edit`, `write`, `todo`, and `herdr_subagent` are disabled. Read-only inspection, questions, and web research remain available. Plans written as numbered steps under a `Plan:` heading are captured automatically. During implementation, `[DONE:n]` markers update the progress widget.

The interactive completion menu offers all three implementation strategies. Fresh-session handoff carries the captured plan and progress state into a child session while leaving the exploration transcript behind.
