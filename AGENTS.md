# Global Agent Notes

## Exploratory repositories

When cloning repositories for reference or investigation, place them in a `.repos/` directory rather than alongside project source files.

- Reuse an existing `.repos/` directory when available. Creating a new clone under `.repos/` is allowed.
- Ensure `.repos/` is ignored by Git; prefer `.git/info/exclude` to avoid modifying the project's `.gitignore` solely for agent scratch work.
- Treat each checkout inside `.repos/` as read-only and exploratory by default: browse, search, and cite it, but do not edit files or run mutating git operations in its default checkout.
- If the user explicitly asks to develop in one of those repositories, use a dedicated branch or isolated worktree and confine all writes and commits to that requested workspace.
- Do not build or run exploratory repositories unless explicitly requested.
- Follow project-specific instructions when they define another location.

## Browser automation

Prefer controlling the user's existing Brave Browser windows with `find_roots`, `observe_ui`, and `act_ui`. Do not use `launch_browser` unless the user specifically requests a separate managed browser instance.

## Running things

Use `make <target>` for common tasks (test, lint, build, run) when a project has or needs one. Add a Makefile target instead of documenting ad-hoc shell one-liners.

- Makefile is the default: it's preinstalled everywhere, no new dependency.

