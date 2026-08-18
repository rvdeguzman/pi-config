# Global Agent Notes

## Exploratory repositories

When cloning repositories for reference or investigation, place them in a `.repos/` directory rather than alongside project source files.

- Reuse an existing `.repos/` directory when available. Creating a new clone under `.repos/` is allowed.
- Ensure `.repos/` is ignored by Git; prefer `.git/info/exclude` to avoid modifying the project's `.gitignore` solely for agent scratch work.
- Treat each checkout inside `.repos/` as read-only and exploratory by default: browse, search, and cite it, but do not edit files or run mutating git operations in its default checkout.
- If the user explicitly asks to develop in one of those repositories, use a dedicated branch or isolated worktree and confine all writes and commits to that requested workspace.
- Do not build or run exploratory repositories unless explicitly requested.
- Follow project-specific instructions when they define another location.

## Running things

Use `make <target>` for common tasks (test, lint, build, run) when a project has or needs one. Add a Makefile target instead of documenting ad-hoc shell one-liners.

- Makefile is the default: it's preinstalled everywhere, no new dependency.

## Task tracking

For multi-step work, track steps with the `todo` tool (add/toggle/list/clear) instead of only holding the plan in context. Keep it current as steps complete so `/todos` reflects real state.

## Subagent delegation

When a multi-step task has sequential, dependent steps (e.g. a todo list
where step N needs step N-1's output), delegate one `Agent` call per
checkpoint instead of one call for the whole plan.

- Write each step's prompt from the **distilled result** of the previous
  step (the specific facts it needs — a struct shape, a file path, a
  decision) — never by pasting or inheriting the prior agent's full
  transcript. Long, unfiltered context degrades a subagent's output quality
  as it grows.
- Foreground the call when the step depends on the prior step's result and
  no independent work exists to fill the wait (the common case for
  sequential chains). Background only when there's genuinely independent
  work to do concurrently.
- Batch multiple small, truly independent steps into one call only when
  their combined context stays small — don't fan out a fresh agent per
  trivial action.
- Skip delegation entirely for single-file/quick-fix scope; spawn overhead
  isn't worth it below that size.

## Grilling before building

- Before implementing any non-trivial build or design change (new feature, redesign, architecture decision), apply the `grilling` skill first: interview me until the design tree is settled. Skip grilling for quick fixes, questions, investigations, and one-liner tasks.
- When grilling, deliver each round's frontier questions through the ask tool in a single call — numbered questions, your recommended answer listed as the first option.
- Never implement during a grilling session until I confirm shared understanding.
- After I confirm shared understanding, do not edit files yet. Present one four-option implementation gate:
  1. **Work** — work on the current session.
  2. **Handoff** — when running inside Herdr (`HERDR_ENV=1`), create a new tab in the current workspace and cwd, launch Pi there, wait for its intercom session, then send it a self-contained implementation prompt. Keep the original tab open and unfocused. If Herdr or intercom is unavailable, fall back to the installed `/handoff` flow.
  3. **Artifact** — uses the `/artifact` command, similar to `/handoff`, but creates the file.
  4. **Continue design** — ask whether to refine the plan or re-run grilling; make no implementation edits.
