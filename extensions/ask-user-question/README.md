# @juicesharp/rpiv-ask-user-question

A terminal-only Pi extension that gives the model an `ask_user_question` tool.

It opens a plain ASCII questionnaire with:

- one to four tabbed questions;
- single- and multi-select options;
- a `Type something.` custom-answer row;
- multiline notes on each question; and
- a final review and submit tab when several questions are asked.

## Install

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart Pi after installation.

## Keyboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move through options |
| `Enter` | Select, toggle, advance, or confirm |
| `Space` | Toggle a multi-select option |
| `Tab` / `Shift+Tab` | Move between question tabs |
| `Left` / `Right` | Move between question tabs |
| `n` | Open the current question's note |
| `Shift+Enter` | Add a line in notes or a custom answer |
| `Ctrl+U` | Clear a custom-answer draft |
| `Esc` | Close a note or cancel the questionnaire |

The extension honors Pi's configured select, submit, cancel, newline, and clear-line keybindings.

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

This package intentionally supports Pi's interactive terminal UI only. It has no RPC/ACP fallback, preview pane, configuration file, emitted events, terminal bell, collapse/ticker mode, or external-editor integration.

In headless sessions, including subagents, the tool is hidden because there is no user interface to answer it. A subagent must return its question to the parent agent instead.

## License

MIT — see [LICENSE](./LICENSE).
