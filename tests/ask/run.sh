#!/usr/bin/env bash
# Run the ask extension test suites.
#
# The extension imports @earendil-works/* from the globally installed pi, which
# bun can only resolve if a node_modules directory exists somewhere above
# pi/extensions/ask.ts. We link one at pi/node_modules (gitignored) rather than
# vendoring anything, so the tests always run against whatever pi is installed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pi_root="$(cd "$here/../.." && pwd)"       # <repo>/pi
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
echo

failed=0
for suite in ask notes navigation timeout; do
	printf '%-12s ' "$suite"
	# Hard cap: the whole point of these suites is that they never hang.
	if output="$(cd "$here" && timeout 120 bun run "$suite.test.ts" 2>&1)"; then
		echo "$output" | grep -oE '[0-9]+/[0-9]+ checks passed|All checks passed' | tail -1
	else
		failed=1
		echo "FAILED"
		echo "$output" | grep -E 'FAIL|error' | head -20 | sed 's/^/             /'
	fi
done

echo
if [[ $failed -eq 0 ]]; then
	echo "All suites passed."
else
	echo "Some suites failed. Re-run one directly for full output:"
	echo "  cd $here && bun run navigation.test.ts"
	exit 1
fi
