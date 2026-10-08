---
description: Commit this session's work, matching the repo's message style
argument-hint: "[push] [extra instructions]"
---
Commit the work. My typing /commit is my approval to commit here, even if project instructions say to ask first.

Extra instructions: ${@:-none}

1. Look at the current state: `jj status` and `jj diff` if the repo has a `.jj` directory, otherwise `git status`, `git diff --staged`, and `git diff`. Also run `git log --format=%s -15` for message style.
2. Decide what goes in:
   - If anything is staged, commit only what is staged.
   - Otherwise, commit the changes this session made. Leave unrelated or pre-existing changes untouched and don't stash or revert them. If you can't tell whether a change belongs, leave it out and say so.
   - Never commit secrets, `.env` files, credentials, or large generated artifacts. Leave them out and mention them.
   - Make separate commits only when the changes are clearly independent. Otherwise make one commit.
3. Write the message in the repo's style: conventional commits (`feat(scope): …`) if recent history uses them, otherwise plain imperative. Keep the subject under 72 characters. Add a short body only when the reason isn't obvious from the subject.
4. Commit with explicit paths (`git add <paths>`, then `git commit -F -`; in jj, `jj commit <paths> -m …`). Don't run tests or builds just for the commit.
5. Never amend, rebase, squash, or force anything. Push only if the extra instructions say push, and only to the branch's existing upstream (in jj, `jj git push` for the bookmark). If there's no upstream, stop and say so instead of creating a remote or repository.

Reply in one or two lines: each commit's short hash and subject, whether anything was pushed, and anything left uncommitted.
