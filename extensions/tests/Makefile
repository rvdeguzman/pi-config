PI_TEST_ENTRY ?= $(shell command -v pi)
NODE ?= $(dir $(PI_TEST_ENTRY))node
NODE_TYPE_FLAGS ?= --experimental-transform-types
export PI_TEST_ENTRY

.DEFAULT_GOAL := test

.PHONY: test test-extensions test-ask test-btw test-subagents test-euler test-recall test-corrections smoke

test: test-extensions

test-extensions:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/*.test.ts extensions/openai-codex-priority/test.mjs

test-ask:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/ask-user-question.test.ts

test-btw:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/btw.test.ts

# Herdr runner (fake CLI) and tmux backend (real tmux on an isolated socket, stub pi).
test-subagents:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/subagent*.test.ts

# Euler mode and /goal (a real Pi session against a scripted model).
test-euler:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/euler*.test.ts

test-recall:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/recall.test.ts

test-corrections:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/corrections.test.ts

smoke:
	cd ../.. && PI_OFFLINE=1 $(NODE) --import ./extensions/tests/register-pi.mjs ./extensions/tests/smoke.mjs
