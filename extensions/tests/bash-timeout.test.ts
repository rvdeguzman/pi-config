import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const { default: bashTimeout, BASH_TIMEOUT_ENV } = await import("../bash-timeout.ts");

/** A real Pi session (real bash tool) with the extension, driven by a scripted model. */
async function session(t: TestContext) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-timeout-"));
	const faux = fauxProvider({ provider: `bash-timeout-faux-${Math.random().toString(36).slice(2)}` });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, "auth.json"), modelsPath: null });
	runtime.registerNativeProvider(faux.provider);
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: getAgentDir(), extensionFactories: [{ name: "bash-timeout", factory: bashTimeout }] });
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: getAgentDir(),
		modelRuntime: runtime,
		model: faux.getModel() as Model<Api>,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	await session.bindExtensions({});
	t.after(async () => {
		session.dispose();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const bashResult = async (args: Record<string, unknown>) => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
		await session.prompt("go");
		while (!session.isIdle) await sleep(20);
		const result = session.messages.findLast((message) => message.role === "toolResult") as
			| { isError: boolean; content: Array<{ type: string; text?: string }> }
			| undefined;
		assert.ok(result, "bash produced a tool result");
		return { isError: result.isError, text: result.content.map((part) => part.text ?? "").join("") };
	};
	return { bashResult };
}

// Protects: a command with no timeout (a hung test) is killed instead of holding the session forever.
// Catches: the hook not reaching Pi's bash tool (wrong event field, mutation ignored).
test("a bash call without a timeout gets the default and is killed with a hint", async (t) => {
	process.env[BASH_TIMEOUT_ENV] = "1";
	t.after(() => delete process.env[BASH_TIMEOUT_ENV]);
	const s = await session(t);
	const started = Date.now();
	const result = await s.bashResult({ command: "sleep 30" });
	assert.ok(Date.now() - started < 10_000, "the hung command was cut off near the default timeout");
	assert.equal(result.isError, true);
	assert.match(result.text, /timed out after 1 seconds/);
	assert.match(result.text, /Default 1s timeout applied/);
});

// Protects: long commands the model deliberately budgets for still run to completion.
// Catches: the default overwriting an explicit timeout.
test("an explicit timeout wins over the default", async (t) => {
	process.env[BASH_TIMEOUT_ENV] = "1";
	t.after(() => delete process.env[BASH_TIMEOUT_ENV]);
	const s = await session(t);
	const result = await s.bashResult({ command: "sleep 2; echo finished", timeout: 10 });
	assert.equal(result.isError, false);
	assert.match(result.text, /finished/);
});
