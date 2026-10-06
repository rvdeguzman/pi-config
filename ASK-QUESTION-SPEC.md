# Ask-question UI rewrite

## Status

Approved interaction design, implemented in the personal Pi configuration without importing OMP runtime/UI packages. Preserve the minimal visual style of `extensions/ask-user-question.ts` while adopting a navigable question-chain flow.

## Goals

- One tool, `ask_user_question`, for both existing single questions and new multi-question chains.
- Thin dividers, numbered choices, restrained semantic colors, wrapped text, and inline editing—not heavy panel chrome.
- Independent saved notes on every option, including unselected options.
- Custom answers through Other, with later editing.
- Free navigation between questions without losing answers, notes, or text drafts.
- Explicit skipping and a compact final review.
- Discard the remaining flow while returning saved partial input; do not erase it or call it a successful early submission.

## Input compatibility

Existing calls remain valid:

```ts
ask_user_question({
  question: string,
  details?: string,
  options?: Array<{ label: string; value?: string; description?: string }>,
  multiSelect?: boolean,
})
```

Add a chain form:

```ts
ask_user_question({
  questions: Array<{
    id: string,
    header?: string,
    question: string,
    details?: string,
    options?: Array<{ label: string; value?: string; description?: string }>,
    multiSelect?: boolean,
  }>,
})
```

Require exactly one form. Reject mixed forms, empty chains, blank questions/option labels, and duplicate question IDs. Values default to labels. Options omitted or empty mean free-form text. Do not silently remove malformed questions or choices.

Keep recommendation labels supplied by the caller; no new automatic recommendation/timeout policy is needed.

## Visual layout

Conceptually:

```text
────────────────────────────────────────
  2/3 · Storage
  Where should we store the data?

> [x] 1. SQLite (Recommended)
         Simple local persistence.
         Note: Keep the database in the project.
  [ ] 2. Postgres
         Note: I do not want to manage a server.
  [ ] Other…
         Custom answer, editable.
  Skip question

  ←→ questions · ↑↓ options · n note
  Space toggle · Enter next · Esc discard
────────────────────────────────────────
```

Single-select keeps numbered rows; multi-select adds checkboxes. Clearly distinguish focus from selection. Choice descriptions, notes and custom answers wrap. Bound the body to terminal height and scroll to keep the focused row visible. Keep footer hints visible, including on narrow terminals. Support resize, wide characters, tabs, theme changes and text-editor focus.

For a legacy standalone question, omit unnecessary question-navigation chrome. Multi-select retains an explicit Next/Submit row so Other and Skip remain actionable. The `questions` chain form always shows progress and a final Review page, even for a one-item chain. Full questions/context belong to the scrollable body rather than permanently clipped headings.

## Question state

Each question has an observable state:

- **Unanswered:** no selected/custom/text answer and not skipped. Saved notes alone do not count as an answer.
- **Answered:** at least one selected/custom answer, or explicitly submitted free-form text.
- **Skipped:** the user explicitly chose Skip.

Selections, custom-answer/text drafts, and notes survive question navigation.

Skipping suppresses any prior answer for submission without erasing notes or editing drafts. Selecting/submitting an answer again clears Skip. Notes do not clear Skip or select anything.

## Option notes

- `n` on an option opens an inline editor for that option's note.
- Saving a note does not select the option.
- Every option has its own independent note; there is no one-note-per-question limitation.
- Deselecting an option does not delete its note.
- Empty saved note text removes that note.
- Other can also be annotated, even if no custom answer has been submitted.
- Return all saved notes, including notes on unselected choices, skipped questions and otherwise unanswered questions.
- Each returned note explicitly identifies its option and whether that option is part of the submitted answer. A note is not a vote.

## Keyboard behavior

Outside inline editing:

| Context | Key | Action |
| --- | --- | --- |
| Question options | `j`/`k`, Up/Down | Move focus (`j` down, `k` up) |
| Focused option | `n` | Edit independent note |
| Single-select option | Enter | Choose and advance (or submit a standalone question) |
| Multi-select option | Space | Toggle selection |
| Multi-select option / Next row | Enter | Advance if answered; otherwise explain that an answer or explicit Skip is needed |
| Other row | Enter | Edit custom answer |
| Skip row | Enter | Explicitly skip and advance |
| Free-text row | Enter | Edit answer |
| Question / review | `h`/`l`, Left/Right, Tab/Shift+Tab | Navigate questions/review without submitting (`h` previous, `l` next) |
| Question / review | PageUp/PageDown | Scroll full question/context, choices and notes |
| Review row | Enter | Return to the corresponding question |
| Review Submit row | Enter | Submit only if every question is answered or explicitly skipped |
| Question / review | Esc | Discard remaining flow and return saved partial input |

Inside an inline editor:

- Text-navigation keys belong to the editor, not the question chain. `h`, `j`, `k`, and `l` insert ordinary text while editing; their navigation bindings apply only while browsing choices/review.
- Enter saves the answer/note and returns to the flow. Answers can advance; notes do not.
- Esc returns to options without discarding the questionnaire or saving unfinished edits as answers/notes.
- Preserve the unsaved editing draft so reopening the same editor restores it during this interaction. Only explicitly saved text is returned to the model.
- Expand collapsed paste markers when retaining drafts; never return a marker in place of pasted content. Editor undo history is isolated per editing interaction so it cannot transfer a different option's unfinished draft.

## Submission and discard

Normal submission requires every question to be answered or explicitly skipped. Review shows answered/skipped/unanswered states and all saved notes. It permits revision before submission.

**Discard means "discarded, with partial input."** It is not `submitted_early` and does not forcibly stop the agent turn.

On discard, return:

- All saved selections, custom answers, and free-text answers.
- All saved option notes—even on unselected options, skipped questions, and unanswered questions.
- Explicit skips and unanswered-question markers.
- A clear overall `discarded` status and model-facing notice that the questionnaire was not completed or confirmed.

Do not infer missing answers. Do not treat partial input as blanket approval. Do not promote unfinished editor drafts into saved input.

Preserve the existing successful single-question result shape (`status: answered`, `question`, `context`, `mode`, `answers`) and add notes/question state. Chains expose ordered per-question results. `unavailable` remains distinct from user discard; operation abort can retain `cancelled` while carrying the same saved partial data.

## Runtime behavior

- Serialize popup interactions against the existing shared UI lock.
- Check abort while waiting for the lock, not just before enqueueing.
- Close active UI on operation abort and return saved partial state.
- Interactive TUI gets the custom flow. Do not mistake RPC `hasUI` for support of `ctx.ui.custom()`; provide an explicit unavailable result for this terminal-only interaction rather than silently returning a fake cancellation.
- Do not add timeouts or automatic answers.
- No OMP dependency, new provider policy, or subagent-runner changes.

## Verification contracts

- Existing single-question options and free-text calls still produce usable answers.
- Independent notes on multiple options survive navigation and deselection.
- Discard carries saved notes from unanswered questions without selecting those options.
- Unsaved editor drafts survive reopening but never leak into the returned answer.
- Single and multi-select transitions differ correctly; Other is editable.
- Explicit Skip permits submission; accidental unanswered questions block it.
- Review navigation preserves state and permits edits.
- Empty/ambiguous input is rejected before any UI opens.
- Abort while queued does not later open a stale popup; active abort closes the dialog.
- RPC/headless calls clearly report unavailable.
- Rendering fits narrow widths and bounded heights across resizing; inline editor focus is propagated.

## Non-goals

No importing OMP's AskDialog, native UI tree, collab, TTS, image-answer pipeline or timer-selection behavior. No change to the continuation shortcut or Herdr orchestration in this work.
