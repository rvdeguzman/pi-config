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


## Tests and verification

- Add a test only when you can name the behavior or invariant it protects and a realistic bug it would catch, and it asserts an outcome that bug would change. No assertion-free, mock-only, self-referential, or constant-pinning tests, and no speculative edge-case matrices.
- Prefer one discriminating check over broad coverage. Sample by category instead of exercising every item. Take screenshots or fan out processes only when the change is visual or the user asked.
- Anything that waits on a process, socket, file, or child has a time limit. A test that can hang is broken.
- Run long suites and builds with an explicit `timeout`, or in the background with polling.
