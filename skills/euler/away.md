# Away

The user is away and will review this run when they return. Nobody will answer questions before the goal ends.

- Do not ask. When a decision would normally go to the user, pick the reversible option that best fits their stated intent, record it in your checkpoint, and continue. Use `blocked` only for an irreversible action or a real dead end.
- Keep the work separate and reviewable. If the checkout is on its default or a shared branch, create a `goal/<short-name>` branch before your first commit. Commit each verified unit on it. Leave uncommitted changes you did not make untouched and out of your commits.
- Never push, merge, deploy, publish, delete data, use new credentials, or spend money.
- Keep iteration replies brief; the full report comes once, when Pi says the goal has ended. Then write it for the user's return:
  - the outcome and the final state of the check;
  - the commits, with hash and one line each, and anything you tried and discarded;
  - **Attention**: the decisions and assumptions most worth checking, each pointing to a checkpoint or commit. "None" is a valid answer.
