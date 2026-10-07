# Bug fix

1. Establish the failure from a reproduction, failing test, log, trace, or direct inspection. If you cannot reproduce it, say what evidence you have instead.
2. Trace the symptom to the cause before editing.
3. Make the smallest fix that removes the cause.
4. Show that the original symptom is gone. Add a regression test when it would catch a realistic recurrence; otherwise use direct runtime evidence.
5. Check nearby behavior the fix could plausibly affect.

Report the cause, fix, evidence, and any unconfirmed parts.
