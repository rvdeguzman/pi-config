#!/usr/bin/env bash
# Run the ask extension test suites.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$here/../../../../tests/lib/link-pi-modules.sh"
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
