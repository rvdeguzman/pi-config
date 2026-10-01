import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import herdrSubagentExtension from "../herdr-subagent.ts";
import { createFakeHerdr } from "./fake-herdr.ts";

// Full extension wiring: mocked Jev + mocked Herdr, real profile/policy loading,
// real private executor handoff and result-file/monitor lifecycle. No live API.
test("automatic routing launches the chosen model/effort through both runners; explicit dispatch preserves profile defaults", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalAgentDir = getAgentDir();
	const isolatedAgentDir = await mkdtemp(join(tmpdir(), "jev-runner-"));
	await mkdir(join(isolatedAgentDir, "extensions"));
	// Fixture profiles: the test must not depend on the user's live profile tuning.
	await mkdir(join(isolatedAgentDir, "agents"));
	await writeFile(join(isolatedAgentDir, "agents", "scout.md"), "---\nname: scout\nmodel: openai-codex/gpt-5.6-luna\nthinking: xhigh\ntools: [read, grep, find, ls]\n---\n");
	await writeFile(join(isolatedAgentDir, "agents", "researcher.md"), "---\nname: researcher\nmodel: openai-codex/gpt-5.6-sol\nthinking: medium\ntools: [read, grep, find, ls]\n---\n");
	await writeFile(join(isolatedAgentDir, "agents", "worker.md"), "---\nname: worker\nmodel: openai-codex/gpt-5.6-sol\nthinking: high\n---\n");
	await cp(join(originalAgentDir, "extensions", "herdr-routing.json"), join(isolatedAgentDir, "extensions", "herdr-routing.json"));
	process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	const previousFetch = globalThis.fetch;
	process.env.TYPESAFE_API_KEY = "fake-integration-key";
	delete process.env.HERDR_WORKSPACE_ID;
	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const results: any[] = [];
	const herdr = createFakeHerdr({
		onPrompt: async (launch, fake) => {
			assert.match(launch.prompt ?? "", /Trace the subsystem/);
			await fake.complete(launch, { output: "Trace with citations" });
		},
	});
	const argvOf = () => herdr.launches.at(-1)!.argv!;
	const flag = (name: string) => argvOf()[argvOf().indexOf(name) + 1];
	const entries: any[] = [];
	let requests = 0;
	let executionEffort = "low";
	const toolNames = ["read", "grep", "find", "ls", "herdr_delegate", "herdr_async", "herdr_subagent", "herdr_worker"];
	const models = ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({ provider: "openai-codex", id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
	const sessionId = `routing-test-${Date.now()}`;
	const ctx: any = {
		cwd: process.cwd(), hasUI: false,
		model: models[0], scopedModels: models.map((model) => ({ model })),
		modelRegistry: { getAvailable: () => models },
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
		ui: { notify: () => {}, addAutocompleteProvider: () => {} },
	};
	globalThis.fetch = async (_url, init) => {
		requests++;
		const request = JSON.parse(init!.body as string);
		return Response.json({ model: "jev-latest", usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]: [string, any]) => {
			const choice = name === "dispatch" ? "delegate" : name === "profile" ? "scout" : `openai-codex/gpt-5.6-sol:${executionEffort}`;
			const labels = Object.keys(question.criteria);
			return [name, { type: "choice", choice, confidence: 0.99, probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 0.99 : 0.01 / (labels.length - 1)])) }];
		})) });
	};
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		getAllTools: () => toolNames.map((name) => ({ name })),
		getActiveTools: () => toolNames,
		getThinkingLevel: () => "high",
		setThinkingLevel: () => { throw new Error("Must not change parent effort"); },
		setModel: () => { throw new Error("Must not change parent model"); },
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any) => results.push(message),
		exec: herdr.exec,
	};
	try {
		herdrSubagentExtension(pi);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		await commands.get("delegate-auto").handler("on", ctx);
		for (const delivery of ["async", "blocking"]) {
			executionEffort = delivery === "async" ? "low" : "max";
			const result = await tools.get("herdr_delegate").execute(`routed-${delivery}`, { task: "Trace the subsystem", context: "Read only. Return file citations.", delivery }, undefined, undefined, ctx);
			assert.equal(result.details.action, "delegate");
			assert.equal(flag("--model"), "gpt-5.6-sol");
			assert.equal(flag("--thinking"), executionEffort);
			assert.equal(result.details.routing.thinking, executionEffort);
			assert.equal(flag("--tools"), "read,grep,find,ls");
		}
		assert.equal(requests, 4);
		await tools.get("herdr_async").execute("explicit", { agent: "scout", task: "Trace the subsystem" }, undefined, undefined, ctx);
		assert.equal(requests, 4, "explicit direct dispatch must not invoke Jev");
		assert.equal(flag("--model"), "gpt-5.6-luna");
		assert.equal(flag("--thinking"), "xhigh");
		assert.equal(ctx.model.id, "gpt-5.6-luna");
		assert.equal(pi.getThinkingLevel(), "high");
		const deadline = Date.now() + 2000;
		while (results.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(results.length, 2, "both async children deliver exactly one result");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(isolatedAgentDir, { recursive: true, force: true });
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
	}
});
