# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types (`@earendil-works/pi-*`, `@sinclair/typebox`, etc.); don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Match the surrounding code style — it is enforced by biome (`biome.json`).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- This is a pi extension. Respect the Claude Code-compatible tool names, calling conventions, and UI patterns the extension deliberately mirrors; don't diverge from them without a stated reason.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Commands

- After code changes (not docs), run the full check suite and fix all errors and warnings:
  ```bash
  npm run lint        # biome
  npm run typecheck   # tsc --noEmit
  npm run test        # vitest run
  ```
- `npm run lint:fix` auto-fixes most style issues.
- `npm run test` runs the whole suite, including `*-e2e.test.ts` files. To iterate on a single file, run it directly: `npx vitest run test/<file>.test.ts`.
- If you create or modify a test file, run it and iterate on the test or implementation until it passes.
- `npm run build` compiles with `tsc`; run it only when verifying the build output or when requested.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
