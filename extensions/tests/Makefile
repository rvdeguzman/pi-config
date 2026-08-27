.PHONY: test test-extensions

test: test-extensions

test-extensions:
	cd ../.. && node --experimental-transform-types --test extensions/tests/herdr-subagent.test.ts extensions/tests/subagent-profiles.test.ts extensions/tests/agent-ref-autocomplete.test.ts extensions/tests/plan-mode.test.ts extensions/tests/todo-integration.test.ts
