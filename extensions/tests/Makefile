PI_TEST_ENTRY ?= $(shell command -v pi)
NODE ?= $(dir $(PI_TEST_ENTRY))node
NODE_TYPE_FLAGS ?= --experimental-transform-types
export PI_TEST_ENTRY

.PHONY: test test-extensions smoke

test: test-extensions

test-extensions:
	cd ../.. && $(NODE) $(NODE_TYPE_FLAGS) --import ./extensions/tests/register-pi.mjs --test extensions/tests/*.test.ts extensions/openai-codex-priority/test.mjs

smoke:
	cd ../.. && PI_OFFLINE=1 $(NODE) --import ./extensions/tests/register-pi.mjs --input-type=module -e 'import assert from "node:assert/strict"; import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent"; const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() }); await loader.reload(); const result = loader.getExtensions(); assert.deepEqual(result.errors, []); for (const extension of result.extensions) console.log(extension.path, [...extension.commands.keys()].map(name => "/" + name).join(" "));'
