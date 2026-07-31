import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatFooter } from "../minimal-footer.ts";

test("renders the requested footer with the original layout", () => {
	const usage = {
		input: 1_700,
		output: 0,
		cacheRead: 98_300,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 100_000,
		cost: { input: 1.158, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.158 },
	};
	const ctx = {
		cwd: join(homedir(), ".pi", "agent"),
		model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		thinkingLevel: "xhigh",
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", usage } }] },
		getContextUsage: () => ({ tokens: 84_864, contextWindow: 272_000, percent: 31.2 }),
	};

	const left = "CH98.3% $1.158 (sub) 85k/272k 31.2%";
	const right = "gpt-5.6-sol • xhigh";

	assert.deepEqual(formatFooter(ctx as never, 100), [
		"~/.pi/agent",
		left.padEnd(100 - right.length) + right,
	]);
});
