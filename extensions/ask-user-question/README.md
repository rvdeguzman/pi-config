# @juicesharp/rpiv-ask-user-question

A terminal-only Pi extension that gives the model an `ask_user_question` tool.

It opens a plain ASCII questionnaire above Pi's normal editor and footer with:

- one to four tabbed questions;
- letter-prefixed single-select options (`a.`, `b.`, ...);
- checkbox-only multi-select options (`[ ]` / `[x]`);
- a `Type something.` inline custom-answer row;
- multiline notes on each question; and
- a final review and submit tab when several questions are asked.

The questionnaire is bounded by full-width ASCII dividers and scrolls internally to keep the active row visible without covering the editor.

## Install

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart Pi after installation.

## Keyboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move through options; focusing `Type something.` immediately opens its inline editor |
| `Enter` | Select, toggle, advance, or commit a non-empty custom answer |
| `Space` | Toggle a multi-select option |
| `Tab` / `Shift+Tab` | Move between question tabs |
| `Left` / `Right` | Move between question tabs |
| `n` | Open the current question's note |
| `Shift+Enter` | Add a line in notes or a custom answer |
| `Ctrl+U` | Clear a custom-answer draft |
| `Ctrl+]` | Collapse the questionnaire to use Pi's editor; press again to reopen it |
| `Esc` | Close a note or cancel the questionnaire |

The extension honors Pi's configured select, submit, cancel, newline, and clear-line keybindings. Leaving the custom-answer row with `Up` or `Down` preserves its draft; returning restores the draft and cursor. Collapse also preserves all choices, notes, and drafts while returning input focus to Pi's normal editor.

## Tool shape

```ts
{
  questions: Array<{
    question: string;
    header: string; // max 16 characters
    options: Array<{
      label: string; // max 60 characters
      description: string;
    }>; // 2-4 options
    multiSelect?: boolean;
  }>;
}
```

`questions` accepts one to four entries. `Other`, `Type something.`, and `Next` are reserved option labels.

## Runtime scope

This package intentionally supports Pi's interactive terminal UI only. It has no RPC/ACP fallback, preview pane, configuration file, emitted events, terminal bell, ticker mode, or external-editor integration.

In headless sessions, including subagents, the tool is hidden because there is no user interface to answer it. A subagent must return its question to the parent agent instead.

## License

MIT — see [LICENSE](./LICENSE).
