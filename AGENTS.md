# Global Agent Notes

## Exploratory repositories

When cloning repositories for reference or investigation, place them in a `.repos/` directory rather than alongside project source files.

- Reuse an existing `.repos/` directory when available. Creating a new clone under `.repos/` is allowed.
- Ensure `.repos/` is ignored by Git; prefer `.git/info/exclude` to avoid modifying the project's `.gitignore` solely for agent scratch work.
- Treat each checkout inside `.repos/` as read-only and exploratory by default: browse, search, and cite it, but do not edit files or run mutating git operations in its default checkout.
- If the user explicitly asks to develop in one of those repositories, use a dedicated branch or isolated worktree and confine all writes and commits to that requested workspace.
- Do not build or run exploratory repositories unless explicitly requested.
- Follow project-specific instructions when they define another location.

## Grilling before building

- Before implementing any non-trivial build or design change (new feature, redesign, architecture decision), apply the `grilling` skill first: interview me until the design tree is settled. Skip grilling for quick fixes, questions, investigations, and one-liner tasks.
- When grilling, deliver each round's frontier questions through the ask tool in a single call — numbered questions, your recommended answer listed as the first option.
- Never implement during a grilling session until I confirm shared understanding.
