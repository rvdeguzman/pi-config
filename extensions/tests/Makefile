PI_TEST_ENTRY ?= $(shell command -v pi)
NODE ?= $(dir $(PI_TEST_ENTRY))node
NODE_TYPE_FLAGS ?= --experimental-transform-types
export PI_TEST_ENTRY

.DEFAULT_GOAL := test

.PHONY: test test-extensions smoke

test: test-extensions

test-extensions:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/*.test.ts extensions/openai-codex-priority/test.mjs

smoke:
	cd ../.. && PI_OFFLINE=1 $(NODE) --import ./extensions/tests/register-pi.mjs ./extensions/tests/smoke.mjs
