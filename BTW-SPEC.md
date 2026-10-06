# BTW: answer-only side questions

## Intent

Replace the configured tool-using `agent-stuff` BTW extension with a small native
Pi implementation inspired by OMP's usage. Keep a minimal, thin-divider reader
instead of importing OMP's TUI/runtime. No OMP source code or dependencies are
vendored.

## Commands and interaction

- `/btw QUESTION` starts a new topic using the current main model and thinking
  level. It can run while the main agent is working.
- `/btw` opens this session's history. If a side request is still running, it
  reopens that answer instead.
- The reader is a focused bottom-centered overlay. It does not replace the main
  editor or modify its draft. `x` hides the overlay and returns to the main task
  while an answer continues in the background.
- One side request at a time; another question is refused rather than queued.
- The question and visible answer are scrollable. Streaming follows the tail
  until the user scrolls away; End returns to the tail.

| Key outside editing | Action |
| --- | --- |
| `j` / `k`, Down / Up | Scroll the answer or select a history topic |
| PageDown / PageUp, End / Home | Page through the answer or jump to its ends |
| `c` | Copy the latest visible answer, including a partial answer |
| `f` | Edit a follow-up in this topic |
| `n` | Edit a new side question |
| `h` | Show history |
| `b` | Promote an eligible single answer into a new saved session branch |
| `r` | Retry saving the displayed/selected topic |
| `x` | Hide without cancelling |
| Esc | Cancel a running request and retain partial output; otherwise close |

In the question editor, letters are ordinary text. Enter submits, Shift+Enter
adds a newline, and Esc returns to browsing without submitting. Esc preserves
an expanded pasted draft within that dialog; rejected submissions restore the
text. A new editor instance prevents cross-topic undo leakage. Unsaved editor
drafts are not durable after closing the dialog.

Very narrow readers/editors must not crash or emit overflowing lines. Footer
hints become compact when necessary. ANSI/control sequences in model output,
questions and error messages are stripped before terminal display.

## Plugin allowlist

`/btw` is answer-only unless `~/.pi/agent/btw.json` allowlists plugins:

```json
{ "allow": ["pi-exa", "read"], "trust": ["web_search_exa"] }
```

- `allow` names plugins (package name such as `pi-exa`, or a local extension's
  file/directory name such as `herdr-subagent`) and/or built-in tools (`read`,
  `grep`, `find`, `ls`, `bash`, `edit`, `write`). `/btw-plugins` toggles entries
  from the installed list. Unknown entries are kept.
- With a non-empty allowlist, each side turn runs an in-memory side
  `AgentSession` seeded from the main branch entries. It loads **only the
  allowlisted plugins**, so their tools **and hooks** apply; nothing else loads
  (no footer/quota/Herdr state plugins unless listed). BTW never loads itself.
- Built-in tools are available only when allowlisted.
- Plugins that register model providers are never loaded in the side runtime;
  the side session reuses the main model runtime, so providers and auth match
  exactly, and re-registering a provider would replace the main one.
- Side plugins get no UI context: dialogs/widgets are no-ops, so UI-driven tools
  (for example `ask_user_question`) report themselves unavailable.
- Approval: read-only built-ins (`read`, `grep`, `find`, `ls`) and plugin tools
  annotated `readOnlyHint` (and not destructive) run immediately. Every other
  call waits in the BTW panel: `y` allow once, `a` always allow (saved to
  `trust`), `n` decline (the model receives a blocked result). A hidden panel
  triggers a notification. Cancelling declines pending approvals.
- Plugins are reloaded for each side turn (startup cost of the allowlisted
  plugins only). The main session is never written to.
- Pi exposes the main model runtime to extensions only through a private field;
  if a future Pi removes it, plugin mode reports an error and answer-only mode
  still works with an empty allowlist.

## Model execution and context

The following applies to **answer-only** mode (empty allowlist). Use
`ctx.modelRegistry.streamSimple()` for one model stream; do not create an
`AgentSession` or execute tools.

- Capture `buildSessionProjection().messages` and convert via `convertToLlm()`.
  This honors compaction and context edits instead of assigning agent state.
- Detach accepted context before asynchronous work. Observe main stream events
  by reference, then include visible transient text without signatures, response
  IDs, tool calls or incomplete reasoning. Reasoning-only partials are omitted.
- Retain the finalized candidate through Pi's `message_end`-before-persistence
  interval. Detect its raw branch entry before adding it, so it contributes only
  once and cannot resurrect a message omitted by an edit or compaction.
- Keep the main system/tool transcript for protocol compatibility and request
  `toolChoice: "none"`. The side policy forbids tools and follow-up questions.
  A provider that nevertheless returns a tool call produces an error and no tool
  execution. Never continue a tool loop.
- Replay only the selected topic's visible Q&A before its new question. Do not
  replay prior side-response reasoning signatures or provider response IDs.
- Use a unique side session ID, distinct from the main provider conversation.
  Clean up its provider resources after stream forwarding terminates.
- Cancellation is visible immediately, with partial text retained. Keep request
  ownership while the provider is still stopping; ignore late content but drain
  through termination before launching another request. Cleanup-hook failures
  are reported, release local ownership, and require `/reload` before reuse. A custom provider that ignores abort
  can delay reuse/disposal; this extension cannot terminate arbitrary host code.

The side call does not run the host's entire agent/extension context and request
hook pipeline. Pi exposes no OMP-equivalent core ephemeral-turn operation to
extensions. Likewise, Pi does not expose separate provider conversation and
prompt-cache keys: isolated IDs can reduce OpenAI-style main-prefix cache reuse.

## History and persistence

History is private session-scoped side data under `~/.pi/agent/btw-history/`, not
custom model-context messages or edits to the main transcript. Directories use
0700 and revisions use 0600 permissions.

- Each topic captures its main session ID and original leaf.
- Turn states are `running`, `complete`, `cancelled`, or `error`; partial answers
  and error messages remain readable.
- Persist the initial turn and terminal state as immutable per-topic revisions.
  Write a private temporary file, then atomically hard-link it to the next
  revision name. A concurrent/stale commit fails rather than overwriting another
  process's answer. There are no persistent lock files to strand after a crash.
- Temporary files are ignored. Damaged revisions/topics are reported without
  overwriting them or blocking healthy history/new topics. An older valid
  revision may remain readable, but cannot overwrite a newer damaged revision.
- A saved `running` turn recovered without its controller becomes cancelled/
  interrupted, retaining its last saved visible text.
- Track save failures per topic. Another topic's successful save cannot hide an
  unsaved answer. `r` retries and reserves mutation ownership, preventing an old
  retry from clearing a newer answer's dirty flag. Orderly disposal retries
  pending writes.
- Session navigation/switch/fork is refused if answers still cannot be saved.
- On `/reload`, plain unsaved data is kept outside the old extension runtime.
  On shutdown/reload save failure, also attempt a private temporary recovery
  copy and report its path. If both primary and recovery storage fail, report
  explicitly that only memory remains; there is no durability guarantee when
  all available storage is unavailable.
- Completed side-call usage/native metadata is retained with the saved answer,
  but is not added to the main session's usage totals.
- In `--no-session`, ordinary history is memory-only and is reset by an extension
  reload or process exit.
- Preserve the previous extension's active saved thread as a legacy topic,
  respecting its reset markers. Do not insert that thread into model context.

Append-only revisions trade modest extra disk space for crash-safe commits.
They are machine state and remain Git-ignored.

## Explicit branch promotion

`b` creates and opens a separate saved session from the captured main leaf,
then appends the exact question and actual successful assistant message. For
plugin turns it appends the exact side prompt, tool calls, tool results and
final answer. It never reruns the model or modifies the original session file.

Require all of:

- Main agent idle, with no queued messages.
- Same main session and leaf as when this topic began.
- A real saved source file and leaf that can be opened.
- Exactly one side turn, with a successful `stop` response and no tool calls.
- No outstanding side request or unsaved answer.

Use a separate exported `SessionManager` to clone the original entry path,
preserving compaction/context-edit IDs and native answer metadata; only then
call `ctx.switchSession()`. Use its fresh `withSession` context for post-switch
UI work. Pi reports this as a session resume, not OMP's native `reason: "btw"`.
Multi-turn, cancelled, failed, truncated and stale answers remain in side history.

The old automatic summary handoff is removed. Closing/hiding never injects a
user message or starts a main-agent turn.

## Files and verification

- Entry point: `extensions/btw.ts`
- State, context, history and promotion: `extensions/lib/btw-session.ts`
- Terminal adapter: `extensions/lib/btw-ui.ts`
- Plugin allowlist, side agent and approval gate: `extensions/lib/btw-agent.ts`
- Static side instructions: `extensions/prompts/btw.md`, `extensions/prompts/btw-agent.md`
- Machine-local allowlist: `~/.pi/agent/btw.json` (Git-ignored)
- Offline contracts: `extensions/tests/btw.test.ts`

Disable `extensions/btw.ts` in the installed `agent-stuff` package allowlist in
both live and portable settings, retaining its `files.ts` extension. Do not edit
the downloaded package checkout.

Run:

```sh
make -C extensions/tests test-btw
make -C extensions/tests test
make -C extensions/tests smoke
```

Tests use isolated state, fake model streams and temporary files. They must not
make model requests, use desktop automation or access live credentials/sessions.
Run `/reload` to activate the rewritten command.
