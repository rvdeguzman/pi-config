import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileProfileRegistry, parseAgentProfile } from "../lib/subagent-profiles.ts";
import { isRetryableProviderFailure } from "../herdr-subagent.ts";

test("profile parser accepts string and ordered array models", () => {
	assert.deepEqual(
		parseAgentProfile("---\nname: scout\nmodel: openai/gpt\nthinking: low\ntools: [read, grep]\n---\nignored"),
		{
			name: "scout",
			model: "openai/gpt",
			thinking: "low",
			tools: ["read", "grep"],
		},
	);
	assert.deepEqual(parseAgentProfile("---\nname: worker\nmodel:\n - openai/one\n - anthropic/two\n---"), {
		name: "worker",
		model: ["openai/one", "anthropic/two"],
	});
});

test("profile parser rejects unsupported and malformed configuration", () => {
	assert.throws(() => parseAgentProfile("---\nname: bad\nprompt: nope\n---"), /unsupported field/);
	assert.throws(() => parseAgentProfile("---\nname: bad\nmodel: []\n---"), /non-empty string array/);
	assert.throws(() => parseAgentProfile("not frontmatter"), /name must match/);
});

test("registry refreshes files and reports unknown and duplicate names", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-profiles-"));
	try {
		const registry = new FileProfileRegistry(directory);
		assert.deepEqual(await registry.list(), []);
		await writeFile(join(directory, "a.md"), "---\nname: scout\n---\nbody ignored");
		assert.equal((await registry.get("SCOUT")).name, "scout");
		await assert.rejects(registry.get("missing"), /Available profiles: scout/);
		await writeFile(join(directory, "b.md"), "---\nname: Scout\n---");
		await assert.rejects(registry.list(), /Duplicate agent profile/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("fallback classification advances only provider failures", () => {
	assert.equal(isRetryableProviderFailure({ failureKind: "provider" } as any), true);
	assert.equal(isRetryableProviderFailure({ failureKind: "tool" } as any), false);
	assert.equal(isRetryableProviderFailure({ failureKind: "task" } as any), false);
	assert.equal(isRetryableProviderFailure({ failureKind: "abort" } as any), false);
	assert.equal(isRetryableProviderFailure(new Error("provider startup failed: 429")), true);
	assert.equal(isRetryableProviderFailure(new Error("tests failed")), false);
});
