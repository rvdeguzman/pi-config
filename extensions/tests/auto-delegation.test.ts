import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoDelegation } from "../lib/auto-delegation.ts";
import type { AgentProfile } from "../lib/subagent-profiles.ts";
import type { RoutingDecision, RoutingPolicy } from "../lib/jev-routing.ts";

const policy: RoutingPolicy = {
	version: 1, model: "jev-latest", timeoutMs: 2500, minConfidence: 0.8, minProbability: 0.7, objective: "Balanced",
	profiles: {
		scout: { description: "Read local code", models: [{ id: "p/small", description: "Routine" }, { id: "p/large", description: "Deep" }] },
		worker: { description: "Implement", models: [{ id: "p/large", description: "Deep" }] },
		researcher: { description: "Web research", models: [{ id: "p/large", description: "Deep" }] },
	},
};
const models = ["small", "large", "outside"].map((id) => ({ provider: "p", id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }));
const profiles: AgentProfile[] = [
	{ name: "scout", model: "p/small", thinking: "xhigh", tools: ["read"] },
	{ name: "worker", model: "p/large", thinking: "high" },
	{ name: "researcher", model: "p/large", thinking: "medium", tools: ["read", "missing_web_tool"] },
];
const positive = (profile = "scout", model = "p/large"): RoutingDecision => ({ action: "delegate", profile, model, evidence: [], elapsedMs: 1 });

function harness() {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let branch: any[] = [];
	let active = ["read", "bash", "write", "herdr_delegate", "herdr_async", "herdr_subagent", "herdr_worker"];
	let profileList = structuredClone(profiles);
	let config = structuredClone(policy);
	let configuredKey: string | undefined = "test-key";
	let failPolicy = false;
	let failDispatch = false;
	const notifications: string[] = [];
	const routes: any[] = [];
	const dispatched: any[] = [];
	let evaluate: (...args: any[]) => Promise<RoutingDecision> = async () => positive();
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getActiveTools: () => active,
		getThinkingLevel: () => "medium",
		appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
	};
	const ctx: any = {
		cwd: process.cwd(), hasUI: true,
		sessionManager: { getBranch: () => branch },
		modelRegistry: { getAvailable: () => models },
		scopedModels: models.slice(0, 2).map((model) => ({ model })),
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
	};
	registerAutoDelegation(pi, {
		listProfiles: async () => profileList,
		loadPolicy: async () => { if (failPolicy) throw new Error("bad config"); return structuredClone(config); },
		apiKey: () => configuredKey,
		resolveTools: (names) => {
			if (names.includes("missing_web_tool")) throw new Error("unregistered tool");
			return names.filter((name) => !name.startsWith("herdr_"));
		},
		route: async (...args) => { routes.push(args); return evaluate(...args); },
		dispatch: async (...args) => {
			dispatched.push(args);
			if (failDispatch) throw new Error("Child launch failed after pane creation");
			return { content: [{ type: "text", text: "Child coordinates" }], details: { tabId: "tab-1" } };
		},
	});
	const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	return {
		ctx, routes, dispatched, notifications, emit,
		command: (args: string) => commands.get("delegate-auto").handler(args, ctx),
		run: (params: any = {}, signal?: AbortSignal) => tools.get("herdr_delegate").execute("call-1", { task: "Trace the cross-module flow", ...params }, signal, undefined, ctx),
		prompt: async () => {
			let systemPrompt = "base";
			for (const handler of handlers.get("before_agent_start") ?? []) systemPrompt = (await handler({ systemPrompt }, ctx))?.systemPrompt ?? systemPrompt;
			return systemPrompt;
		},
		setEvaluator: (fn: typeof evaluate) => { evaluate = fn; },
		setKey: (key: string | undefined) => { configuredKey = key; },
		setActive: (names: string[]) => { active = names; },
		setBranch: (entries: any[]) => { branch = entries; },
		getBranch: () => branch,
		setPolicy: (p: RoutingPolicy) => { config = p; },
		setProfiles: (p: AgentProfile[]) => { profileList = p; },
		badPolicy: () => { failPolicy = true; },
		badDispatch: () => { failDispatch = true; },
	};
}

test("default off; missing credentials prevent opt-in; no network or child", async () => {
	const h = harness();
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(await h.prompt(), "base");
	h.setKey(undefined);
	await h.command("on");
	assert.match(h.notifications.at(-1)!, /TYPESAFE_API_KEY/);
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.routes.length, 0);
	assert.equal(h.dispatched.length, 0);
});

test("opt-in guidance preserves explicit references and no-bypass policy", async () => {
	const h = harness(); await h.command("on");
	assert.match(await h.prompt(), /Explicit &name requests remain direct herdr_async/);
	assert.match(await h.prompt(), /do not bypass/);
	assert.match(h.notifications.at(-1)!, /sent to TypeSafe/);
});

test("session branch persistence restores on reload/tree; new branch defaults off", async () => {
	const h = harness(); await h.command("on");
	const enabledEntries = structuredClone(h.getBranch());
	await h.emit("session_start");
	assert.match(await h.prompt(), /enabled/);
	await h.command("off");
	assert.equal(await h.prompt(), "base");
	h.setBranch(enabledEntries); await h.emit("session_tree");
	assert.match(await h.prompt(), /enabled/);
	h.setBranch([]); await h.emit("session_start");
	assert.equal(await h.prompt(), "base");
});

test("prepares only available, scoped, permitted profiles/models and preserves thinking", async () => {
	const h = harness(); await h.command("on");
	const result = await h.run({ context: "Parent can inspect tests concurrently.", cwd: "/tmp" });
	assert.equal(result.details.action, "delegate");
	assert.equal(h.routes.length, 1);
	const candidates = h.routes[0][2];
	assert.deepEqual(candidates.map((c: any) => c.profile), ["scout"]);
	assert.deepEqual(candidates[0].models.map((m: any) => m.id), ["p/small", "p/large"]);
	assert.equal(h.dispatched[0][0], "async");
	assert.equal(h.dispatched[0][1].model, "p/large");
	assert.equal(h.dispatched[0][1].thinking, "xhigh");
	assert.deepEqual(h.dispatched[0][1].tools, ["read"]);
	assert.match(h.dispatched[0][3].task, /Parent can inspect tests concurrently/);
	assert.equal(h.dispatched[0][3].cwd, "/tmp");
	assert.equal(profiles[0]!.model, "p/small", "profile configuration stays untouched");
});

test("pinning an agent restricts candidates but still invokes the dispatch gate", async () => {
	const h = harness(); await h.command("on");
	h.setEvaluator(async () => ({ action: "parent", reason: "Not worth delegating", evidence: [], elapsedMs: 1 }));
	assert.equal((await h.run({ agent: "SCOUT" })).details.action, "parent");
	assert.equal(h.routes[0][1].agent, "scout");
	assert.equal(h.dispatched.length, 0);
});

test("worker requires write authorization and can only launch asynchronously", async () => {
	const h = harness(); await h.command("on");
	h.setEvaluator(async () => positive("worker"));
	assert.equal((await h.run({ agent: "worker" })).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
	assert.equal((await h.run({ agent: "worker", allowWrites: true, delivery: "blocking" })).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
	assert.equal((await h.run({ agent: "worker", allowWrites: true })).details.action, "delegate");
	assert.equal(h.dispatched.length, 1);
	assert.deepEqual(h.dispatched[0][1].tools, ["read", "bash", "write"]);
});

test("worker stays ineligible without write authorization even if its inherited tools are read-only", async () => {
	const h = harness(); await h.command("on");
	h.setActive(["read", "herdr_delegate", "herdr_async"]);
	h.setEvaluator(async () => positive("worker"));
	assert.equal((await h.run({ agent: "worker" })).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

test("scope and available model list are hard bounds, including at revalidation", async () => {
	const h = harness(); await h.command("on");
	h.ctx.scopedModels = [{ model: models[0] }];
	assert.equal((await h.run()).details.action, "parent", "unscoped p/large cannot dispatch");
	assert.deepEqual(h.routes[0][2][0].models.map((m: any) => m.id), ["p/small"]);
	h.ctx.scopedModels = [];
	h.setEvaluator(async () => positive("scout", "p/outside"));
	assert.equal((await h.run()).details.action, "parent", "available but unapproved model cannot dispatch");
	h.setEvaluator(async () => { h.ctx.modelRegistry.getAvailable = () => [models[0]]; return positive(); });
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

test("read-only allowlist rejects an incorrectly configured scout with bash", async () => {
	const h = harness(); await h.command("on");
	h.setProfiles([{ ...profiles[0]!, tools: ["read", "bash"] }]);
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

test("disabled delegation tools block routing and revalidation prevents mode-change races", async () => {
	const h = harness(); await h.command("on");
	h.setActive(["read"]);
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.routes.length, 0);
	h.setActive(["read", "herdr_delegate", "herdr_async"]);
	h.setEvaluator(async () => { h.setActive(["read"]); return positive(); });
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

for (const action of ["off", "shutdown", "tree"]) {
	test(`${action} cancels in-flight routing and forbids late dispatch`, async () => {
		const h = harness(); await h.command("on");
		h.setEvaluator(async (_p, _t, _c, options) => {
			if (action === "off") await h.command("off");
			else await h.emit(action === "shutdown" ? "session_shutdown" : "session_tree");
			assert.equal(options.signal.aborted, true);
			return positive();
		});
		assert.equal((await h.run()).details.action, "parent");
		assert.equal(h.dispatched.length, 0);
	});
}

test("caller abort never launches a child even with a non-cooperating classifier", async () => {
	const h = harness(); await h.command("on");
	const controller = new AbortController();
	h.setEvaluator(async () => { controller.abort(); return positive(); });
	assert.equal((await h.run({}, controller.signal)).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

test("policy changes, profile changes, and unknown profile/model selections fail closed", async () => {
	for (const mutate of [
		(h: ReturnType<typeof harness>) => h.setPolicy({ ...policy, objective: "Changed" }),
		(h: ReturnType<typeof harness>) => h.setProfiles([{ ...profiles[0]!, thinking: "low" }]),
	]) {
		const h = harness(); await h.command("on");
		h.setEvaluator(async () => { mutate(h); return positive(); });
		assert.equal((await h.run()).details.action, "parent");
		assert.equal(h.dispatched.length, 0);
	}
	const h = harness(); await h.command("on");
	h.setEvaluator(async () => positive("nonexistent"));
	assert.equal((await h.run()).details.action, "parent");
	assert.equal(h.dispatched.length, 0);
});

test("configuration errors and classifier errors return parent, not a tool error", async () => {
	for (const failure of ["config", "network"]) {
		const h = harness(); await h.command("on");
		if (failure === "config") h.badPolicy();
		else h.setEvaluator(async () => { throw new Error("SECRET"); });
		const result = await h.run();
		assert.equal(result.details.action, "parent");
		assert.doesNotMatch(JSON.stringify(result), /SECRET/);
		assert.equal(h.dispatched.length, 0);
	}
});

test("launch failures propagate rather than falsely claiming no child launched", async () => {
	const h = harness(); await h.command("on"); h.badDispatch();
	await assert.rejects(h.run(), /Child launch failed/);
	assert.equal(h.dispatched.length, 1);
});

test("blocking read-only tasks use the existing blocking dispatcher", async () => {
	const h = harness(); await h.command("on");
	assert.equal((await h.run({ delivery: "blocking" })).details.action, "delegate");
	assert.equal(h.dispatched[0][0], "blocking");
});
