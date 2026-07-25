#!/usr/bin/env bash
# Link pi/node_modules at the globally installed pi.
#
# Extension sources import @earendil-works/* from the installed pi, which bun can
# only resolve if a node_modules directory exists somewhere above
# pi/extensions/*.ts. We link one at pi/node_modules (gitignored) rather than
# vendoring anything, so suites always run against whatever pi is installed.
#
# Prints one line identifying the package the suites will run against.
set -euo pipefail

pi_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # <repo>/pi
pi_root="$(cd "$pi_root/.." && pwd)"
modules="$pi_root/node_modules"

for tool in node bun; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "error: $tool is required to run these suites" >&2
		exit 1
	fi
done

# Derive the package from the `pi` on PATH. `npm root -g` is unreliable here:
# the npm prefix and the nvm install routinely disagree. Fall back to it anyway.
pi_pkg=""
if command -v pi >/dev/null 2>&1; then
	entry="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v pi)")"
	candidate="$entry"
	while [[ "$candidate" != "/" ]]; do
		candidate="$(dirname "$candidate")"
		if [[ -f "$candidate/package.json" ]]; then
			pi_pkg="$candidate"
			break
		fi
	done
fi
if [[ -z "$pi_pkg" || ! -d "$pi_pkg/dist" ]]; then
	pi_pkg="$(npm root -g)/@earendil-works/pi-coding-agent"
fi
if [[ ! -d "$pi_pkg/node_modules/@earendil-works/pi-tui" ]]; then
	echo "error: could not locate the installed pi package (tried $pi_pkg)" >&2
	exit 1
fi

mkdir -p "$modules/@earendil-works"
ln -sfn "$pi_pkg" "$modules/@earendil-works/pi-coding-agent"
ln -sfn "$pi_pkg/node_modules/@earendil-works/pi-tui" "$modules/@earendil-works/pi-tui"
ln -sfn "$pi_pkg/node_modules/typebox" "$modules/typebox"

echo "pi $(node -e 'console.log(require(process.argv[1] + "/package.json").version)' "$pi_pkg") — $pi_pkg"
