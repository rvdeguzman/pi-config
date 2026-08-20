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

For more durable state, keep track with a TODO.md

