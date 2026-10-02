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

## Verify bootstrap behavior

```sh
make test-setup
```

Tests use temporary directories and a fake Pi command; they do not install
packages or modify your live settings or credentials.
