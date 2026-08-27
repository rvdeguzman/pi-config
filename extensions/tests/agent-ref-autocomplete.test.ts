import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRefAutocomplete } from "../lib/agent-ref-autocomplete.ts";

function setup() {
	let delegated = 0;
	const current = {
		getSuggestions: async () => {
			delegated++;
			return { prefix: "@x", items: [{ value: "@x", label: "@x" }] };
		},
		applyCompletion: () => ({
			lines: ["delegated"],
			cursorLine: 0,
			cursorCol: 9,
		}),
		shouldTriggerFileCompletion: () => true,
	} as any;
	const registry = {
		list: async () => [{ name: "scout" }, { name: "Worker" }],
		get: async () => ({ name: "scout" }),
	} as any;
	return {
		provider: createAgentRefAutocomplete(current, registry),
		delegated: () => delegated,
	};
}

test("agent references match at start and after whitespace case-insensitively", async () => {
	const { provider } = setup();
	const start = await provider.getSuggestions(["&SC"], 0, 3, {
		force: false,
		signal: new AbortController().signal,
	});
	assert.deepEqual(start, {
		prefix: "&SC",
		items: [{ value: "&scout", label: "&scout" }],
	});
	const later = await provider.getSuggestions(["please &wo"], 0, 10, {
		force: false,
		signal: new AbortController().signal,
	});
	assert.deepEqual(later, {
		prefix: "&wo",
		items: [{ value: "&Worker", label: "&Worker" }],
	});
});

test("agent completion inserts a literal reference and exactly one space", () => {
	const { provider } = setup();
	assert.deepEqual(provider.applyCompletion(["please &sc   now"], 0, 10, { value: "&scout", label: "&scout" }, "&sc"), {
		lines: ["please &scout now"],
		cursorLine: 0,
		cursorCol: 14,
	});
});

test("autocomplete delegates outside agent tokens and when no profile matches", async () => {
	const first = setup();
	await first.provider.getSuggestions(["@file"], 0, 5, {
		force: false,
		signal: new AbortController().signal,
	});
	assert.equal(first.delegated(), 1);
	const second = setup();
	await second.provider.getSuggestions(["&zzz"], 0, 5, {
		force: false,
		signal: new AbortController().signal,
	});
	assert.equal(second.delegated(), 1);
});
