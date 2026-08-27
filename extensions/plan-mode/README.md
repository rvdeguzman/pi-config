# Plan mode

A global Pi extension providing read-only planning and tracked implementation.

## Commands

- `/plan` — toggle plan mode; during execution, pause and preserve the current plan
- `/implement [steps]` — choose plan steps and execute them in a fresh linked session with a full context budget (default)
- `/implement-compact [steps]` — compact the planning conversation, then execute the selected steps there
- `/implement-here [steps]` — execute the selected steps directly in the current full context
- `/plan-status` — show progress for the captured plan
- `Ctrl+Alt+P` — toggle plan mode

You can also start Pi directly in plan mode with `pi --plan`.

While planning, `bash`, `edit`, `write`, `todo`, and `herdr_subagent` are disabled. Read-only inspection, questions, and web research remain available. Plans written as numbered steps under a `Plan:` heading are captured automatically. During implementation, `[DONE:n]` markers update the progress widget.

The interactive completion menu offers all three implementation strategies and then asks for a milestone range. Step selectors accept individual steps, comma-separated ranges, or `all`, for example `/implement 1-3,5`. Running `/implement` without arguments opens the selector.

Fresh-session handoff carries the full captured plan, completed-step state, and selected milestone into the linked session while leaving the exploration transcript behind. Only `[DONE:n]` markers for the active milestone are accepted. When that milestone finishes, remaining steps are preserved and the session returns to read-only plan mode so `/implement` can launch the next milestone with a fresh context budget.
