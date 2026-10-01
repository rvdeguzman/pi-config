---
name: interrogate
description: "Multi-model adversarial review: reviewer-claude and reviewer-gpt challenge a diff independently, then you synthesize a verdict. Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\"."
disable-model-invocation: true
---

# Interrogate

Run one reviewer per model family on the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas. Reviewers are the Pi agent profiles `reviewer-claude` (anthropic/claude-opus-5-5) and `reviewer-gpt` (openai/gpt-6.1-sol), both read-only, both on the user's scoped models.

The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1: Determine scope

- If the user points at files or a diff, use that.
- On a feature branch, use `git diff <base>...HEAD` (find the base; usually `main`).
- Otherwise use uncommitted changes (`git diff HEAD`), or the files the recent work touched.

## Step 2: State the intent

Write one paragraph stating what the change is for, from the user's message, commit messages, PR description, and the code. If unsure, ask the user before continuing.

## Step 3: Build the review packet

Create a run directory: `RUN=$(mktemp -d "${TMPDIR:-/tmp}/interrogate.XXXXXX")`.

1. Write the diff (or file snapshots) to `$RUN/diff.patch`.
2. Fill `references/reviewer-prompt.md` (the part below its `---` line) and write it to `$RUN/prompt.md`:
   - `{INTENT}`: the Step 2 paragraph.
   - `{DIFF_OR_FILES}`: a pointer, not the content: "Read `$RUN/diff.patch`. The repository is at `<absolute repo path>`; read surrounding files there as needed."
   - `{RUBRIC_CONTENTS}`: contents of `references/rubric.md`.
   - `{CODE_QUALITY_CONTENTS}`: contents of `references/code-quality-review.md`.

## Step 4: Run reviewers

Call `herdr_subagent` twice **in the same tool-call block** so both run concurrently: once with agent `reviewer-claude`, once with agent `reviewer-gpt`. Use the same task for both, with the absolute path substituted:

> You are a read-only reviewer. Do not edit files, commit, or run mutating commands. Read `<RUN>/prompt.md` and follow it exactly. Return only the Findings section it specifies.

If one reviewer fails, report which one and continue with the other's findings. Do not substitute a different model.

## Step 5: Synthesize

1. Parse all findings.
2. **Consensus**: findings both models raised independently are highest signal.
3. **Lone-model findings**: still read them, weighted accordingly.
4. **Deduplicate**: merge findings that describe the same issue differently; note which models raised them.
5. **Disagreements**: if one model flags something and the other says the opposite, record it.

## Step 6: Lead judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read `references/lead-judgment.md`, verify each finding against the code yourself, then bucket every finding:

- **Act on**: real correctness, security, or maintainability issues given the actual goals. Would block a real PR.
- **Consider**: legitimate, but unclear the payoff beats the cost right now.
- **Noted**: technically valid, not actionable at this stage.
- **Dismissed**: wrong, nitpicky, or missing context; say why briefly.

## Output format

### Intent
> [Step 2 paragraph]

### Reviewers
- reviewer-claude (claude-opus-5-5): N findings
- reviewer-gpt (gpt-6.1-sol): N findings

### Act on
[Each: description, which model(s), why it matters.]

### Consider
[Each: description, which model(s), the tradeoff.]

### Noted
[Brief list.]

### Dismissed
[Each with a brief rationale.]

### Agreement map
[Where the models agreed, where they diverged, and what that pattern suggests.]

---
Adapted from Lauren Tan's pstack (`cursor/plugins`, MIT, commit c47b128) for Pi + herdr.
