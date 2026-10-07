# Pi configuration

Personal Pi extensions, skills, agent profiles, and portable settings.
This repository is intended to be checked out at `~/.pi/agent`.

## Set up a fresh machine

Install Pi first (Node.js 22.19 or newer):

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

If `~/.pi/agent` does not already exist:

```sh
git clone https://github.com/rvdeguzman/pi-config ~/.pi/agent
cd ~/.pi/agent
make setup
```

If that directory already exists, back it up before cloning; do not delete
existing credentials or sessions. Git cannot clone into a non-empty directory.

`make setup`:

1. Copies tracked `settings.example.json` to ignored `settings.json` **only if
   settings.json is missing**. Existing settings are never overwritten.
2. Runs `pi update --extensions` to install/reconcile the packages declared in
   the live settings file. npm packages and Git checkouts are recreated locally,
   not versioned. Project-local configuration is excluded from this command.

Authenticate separately using `/login` in Pi and any package-specific setup.
Credentials are not restored from Git.

## Settings and secrets

- `settings.example.json` is the portable baseline: preferences and package
  declarations, without `deviceId` or `lastChangelogVersion`.
- `settings.json` is local machine state and remains ignored. Pi edits this file;
  changes are not automatically synced back to the example. Update the example
  deliberately when you want to share a preference or package-list change.
- `auth.json`, `mcp-auth.json`, other machine state, and installed package
  directories remain ignored. Never force-add credentials.
- The baseline retains this setup's `defaultProjectTrust: "always"`. Change it
  to `"ask"` in local settings if you want explicit project-trust prompts.

Restore settings without installing packages:

```sh
make restore-settings
```

Install/update packages from the current local settings:

```sh
make packages
```

A later `git pull` updates the example, not your live settings. Merge desired
changes manually; setup intentionally does not reset local preferences.

## Question UI

The local `ask_user_question` extension supports individual questions and navigable
question chains, with independent option notes, custom answers, explicit skips,
and a final review. Press `n` to annotate an option without selecting it.
Use `j`/`k` or Up/Down for choices, and `h`/`l`, Left/Right or Tab for questions.
These letter shortcuts only navigate outside text editors; while editing, they
insert ordinary text.
Esc in an editor returns to the options; Esc outside editing discards the rest
of the flow **with saved answers and notes**, rather than deleting partial input.

Existing single-question calls remain supported. The approved interaction and
result contracts are in [ASK-QUESTION-SPEC.md](ASK-QUESTION-SPEC.md).
Run `/reload` in Pi after changing the extension.

Verify question behavior without model requests or live credentials:

```sh
make -C extensions/tests test-ask
```

## BTW side questions

The local `/btw` command is an OMP-style quick side question in the current view.
It uses your current conversation/model, runs only the plugins you allowlist
(none by default: answer-only), and keeps its history outside the main transcript.

- `/btw QUESTION` starts a new topic; `/btw` opens history.
- `c` copies, `f` asks a follow-up, `h` opens history, and `n` starts a new topic.
- `j`/`k` or arrows scroll/select; PageUp/PageDown scroll longer answers.
- `x` hides the reader while answering continues. Esc cancels and retains partial
  output, or closes when idle. In the editor, Esc preserves the draft and letters
  type normally.
- `b` explicitly promotes a completed single answer into a new saved session
  branch without another model call. The main conversation must still be idle at
  the original leaf. Closing does not inject a summary or trigger the main agent.
- **Plugins:** `/btw-plugins` picks which plugins (and built-in tools) BTW may
  use; they're saved in ignored `btw.json`. With none, BTW stays answer-only.
  With some, BTW runs a side agent loading only those plugins (tools and hooks).
  Non-read-only calls ask in the panel: `y` once, `a` always, `n` decline.
- Save failures remain visible; `r` retries. Existing saved BTW Q&A is preserved
  as a legacy topic. History lives in ignored `btw-history/` machine state.

The downloaded `agent-stuff` BTW extension is disabled in the live/example
package allowlist; its file browser remains enabled. Details and limitations
are in [BTW-SPEC.md](BTW-SPEC.md). Run `/reload` to activate changes.

Verify without model requests or live credentials:

```sh
make -C extensions/tests test-btw
```

## Subagents

The model delegates with `subagent` (blocking) and `subagent_async`
(background; the result is steered back). Typing `&scout`, `&worker`, … asks for
an async child with that profile from `agents/*.md`. Each child runs in a
visible target: a Herdr tab when Pi runs inside Herdr, otherwise a tmux window
(the current tmux session, or a detached `pi-subagents` session). Results print
exact attach/capture/close commands.

- `/subagent-backend [auto|herdr|tmux]` shows or persists the backend (ignored
  `subagents.json`); `PI_SUBAGENT_BACKEND` overrides it per process. Changes
  affect new runs only.
- `/subagent-prune [days]` removes old run directories.
- tmux cannot see whether a child is waiting for input; attach if it stalls.

Details are in [SUBAGENT-SPEC.md](SUBAGENT-SPEC.md). Verify without model
requests (the tmux tests use an isolated tmux server and a stub `pi`):

```sh
make -C extensions/tests test-subagents
```

## Verify bootstrap behavior

```sh
make test-setup
```

Tests use temporary directories and a fake Pi command; they do not install
packages or modify your live settings or credentials.
