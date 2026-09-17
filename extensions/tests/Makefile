PI_TEST_ENTRY ?= $(shell command -v pi)
NODE ?= $(dir $(PI_TEST_ENTRY))node
NODE_TYPE_FLAGS ?= --experimental-transform-types
export PI_TEST_ENTRY

.PHONY: test test-extensions

test: test-extensions

test-extensions:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/herdr-subagent.test.ts extensions/tests/subagent-profiles.test.ts extensions/tests/agent-ref-autocomplete.test.ts extensions/tests/plan-mode.test.ts extensions/tests/todo-integration.test.ts extensions/tests/jev-routing.test.ts extensions/tests/auto-delegation.test.ts extensions/tests/auto-delegation-runner.test.ts
