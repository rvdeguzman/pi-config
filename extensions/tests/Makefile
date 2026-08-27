.PHONY: test test-herdr-subagent

test: test-herdr-subagent

test-herdr-subagent:
	cd ../.. && node --experimental-transform-types --test extensions/tests/herdr-subagent.test.ts extensions/tests/subagent-profiles.test.ts extensions/tests/agent-ref-autocomplete.test.ts
