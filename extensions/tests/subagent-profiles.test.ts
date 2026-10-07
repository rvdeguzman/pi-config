import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileProfileRegistry, parseAgentProfile } from "../lib/subagent-profiles.ts";
import { isFallbackFailure } from "../subagent.ts";

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

test("profile parser accepts a boolean worktree flag", () => {
	assert.deepEqual(parseAgentProfile("---\nname: worker\nworktree: true\n---"), { name: "worker", worktree: true });
	assert.throws(() => parseAgentProfile("---\nname: worker\nworktree: yes please\n---"), /worktree must be true or false/);
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

test("fallback advances on every final failure except cancellation", () => {
	for (const failureKind of ["provider", "tool", "task", undefined]) {
		assert.equal(isFallbackFailure({ status: "failed", failureKind } as any), true);
		assert.equal(isFallbackFailure({ status: "completed", failureKind } as any), false);
	}
	assert.equal(isFallbackFailure({ status: "failed", failureKind: "abort" } as any), false);
	assert.equal(isFallbackFailure({ status: "failed", stopReason: "aborted" } as any), false);
	assert.equal(isFallbackFailure(new Error("provider startup failed: 429")), true);
	assert.equal(isFallbackFailure(new Error("tests failed")), true);
	assert.equal(isFallbackFailure(new Error("Child Pi exited before reporting a result")), true);
});
