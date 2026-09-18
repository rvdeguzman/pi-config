import assert from "node:assert/strict";
import test from "node:test";
import { chooseAutoModel, eligibleExecutions, parseAutoPolicy } from "../lib/auto-model-routing.ts";
import { registerAutoModel } from "../auto-model.ts";

const policy = parseAutoPolicy({ version: 1, model: "jev-latest", timeoutMs: 100, minConfidence: 0.8, minProbability: 0.7, objective: "Balanced", models: [{ id: "test/light", description: "Simple work" }] });
const execution = { id: "test/light", thinking: "off" as const, description: "Simple work" };
const response = (choice = "route_0", confidence = 0.95) => new Response(JSON.stringify({ answers: { execution: { type: "choice", choice, confidence, probabilities: { keep: choice === "keep" ? 0.95 : 0.05, route_0: choice === "keep" ? 0.05 : 0.95 } } } }));

test("auto policy validates model allowlists", () => {
	assert.throws(() => parseAutoPolicy({ ...policy, models: [] }));
	assert.throws(() => parseAutoPolicy({ ...policy, models: [{ id: "bad", description: "bad" }] }));
});
test("one Jev request selects a pair without delegation or transcript disclosure", async () => {
	let calls = 0;
	const result = await chooseAutoModel(policy, "Fix a typo", [execution], { apiKey: "test", fetch: async (_url, init) => {
		calls++;
		const payload = JSON.parse(String(init?.body));
		assert.deepEqual(payload.state, { prompt: "Fix a typo", objective: "Balanced" });
		assert.deepEqual(Object.keys(payload.questions), ["execution"]);
		assert.equal(init?.redirect, "error");
		return response();
	} });
	assert.equal(calls, 1);
	assert.equal(result.action, "select");
	if (result.action === "select") assert.deepEqual(result.execution, execution);
	assert.deepEqual(result.response, { type: "choice", choice: "route_0", confidence: 0.95, probabilities: { keep: 0.05, route_0: 0.95 }, labels: { route_0: { model: "test/light", thinking: "off" } } });
});
test("keep, uncertainty, invalid output, HTTP errors and deadline retain current execution", async () => {
	for (const fetcher of [async () => response("keep"), async () => response("route_0", 0.5), async () => response("unknown"), async () => new Response("secret error", { status: 500 }), async () => new Response("invalid"), () => new Promise<Response>(() => {})]) {
		const result = await chooseAutoModel(policy, "Fix a typo", [execution], { apiKey: "test", fetch: fetcher });
		assert.equal(result.action, "keep");
		assert.ok(!JSON.stringify(result).includes("secret"));
	}
});
test("preflight rejects missing auth, oversized prompt, no candidates and cancellation", async () => {
	let calls = 0;
	const fetcher = async () => { calls++; return response(); };
	await chooseAutoModel(policy, "task", [execution], { fetch: fetcher });
	await chooseAutoModel(policy, "x".repeat(24001), [execution], { apiKey: "test", fetch: fetcher });
	await chooseAutoModel(policy, "task", [], { apiKey: "test", fetch: fetcher });
	await chooseAutoModel(policy, "task", [execution], { apiKey: "test", fetch: fetcher, signal: AbortSignal.abort() });
	assert.equal(calls, 0);
});

function harness(route: typeof chooseAutoModel = async () => ({ action: "select" as const, execution, confidence: 0.95, probability: 0.95, elapsedMs: 3 })) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const switches: any[] = [];
	const entries: any[] = [];
	const notifications: string[] = [];
	const model = { provider: "test", id: "light", reasoning: false, contextWindow: 128000, input: ["text"] };
	let effort = "off";
	const ctx: any = { model: { ...model, id: "current" }, scopedModels: [], hasUI: true, isIdle: () => true, getContextUsage: () => ({ tokens: 1000 }), modelRegistry: { getAvailable: () => [model] }, sessionManager: { getBranch: () => entries.map(([customType, data]) => ({ type: "custom", customType, data })) }, ui: { setStatus() {}, notify(text: string) { notifications.push(text); } } };
	const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd), getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { switches.push(value); ctx.model = value; await handlers.get("model_select")?.({}, ctx); return true; }, appendEntry: (...args: any[]) => entries.push(args) };
	registerAutoModel(pi, { loadPolicy: async () => policy, apiKey: () => "test", route });
	return { ctx, switches, entries, notifications, handlers, command: (args: string) => commands.get("auto").handler(args, ctx), input: (extra: any = {}) => handlers.get("input")!({ text: "Fix a typo", source: "interactive", ...extra }, ctx) };
}
test("eligibility respects availability, scopes, unsupported pins and context capacity", () => {
	const h = harness();
	assert.equal(eligibleExecutions(policy, h.ctx, "task").length, 1);
	h.ctx.scopedModels = [{ model: { provider: "test", id: "other" } }];
	assert.equal(eligibleExecutions(policy, h.ctx, "task").length, 0);
	h.ctx.scopedModels = [{ model: { provider: "test", id: "light" }, thinkingLevel: "high" }];
	assert.equal(eligibleExecutions(policy, h.ctx, "task").length, 0);
	h.ctx.scopedModels = [];
	h.ctx.getContextUsage = () => ({ tokens: 127000 });
	assert.equal(eligibleExecutions(policy, h.ctx, "task").length, 0);
});
test("off by default; opt-in routes idle user prompts, not steering, images, commands or synthetic input", async () => {
	const h = harness();
	await h.input();
	assert.equal(h.switches.length, 0);
	await h.command("on");
	for (const extra of [{ streamingBehavior: "steer" }, { streamingBehavior: "followUp" }, { source: "extension" }, { images: [{}] }, { text: "/skill:test" }]) await h.input(extra);
	h.ctx.isIdle = () => false;
	await h.input();
	assert.equal(h.switches.length, 0);
	h.ctx.isIdle = () => true;
	await h.input();
	assert.equal(h.switches.length, 1);
	assert.equal(h.entries.length, 2);
	await h.command("off");
	await h.input();
	assert.equal(h.entries.length, 2);
});
test("last shows branch-persisted Jev evidence for keep and low-confidence decisions", async () => {
	for (const [choice, confidence] of [["keep", 0.95], ["route_0", 0.5]] as const) {
		const h = harness((p, prompt, candidates) => chooseAutoModel(p, prompt, candidates, { apiKey: "test", fetch: async () => response(choice, confidence) }));
		await h.command("last");
		assert.match(h.notifications.at(-1)!, /No recorded/);
		await h.command("on");
		await h.input();
		assert.equal(h.switches.length, 0);
		assert.equal(h.entries.length, 1);
		await h.command("last");
		const logged = JSON.parse(h.notifications.at(-1)!);
		assert.equal(logged.action, "keep");
		assert.equal(logged.response.choice, choice);
		assert.equal(logged.response.confidence, confidence);
		assert.deepEqual(logged.response.labels.route_0, { model: "test/light", thinking: "off" });
		assert.ok(!JSON.stringify(logged).includes("Fix a typo"));
	}
});
test("invalid responses log only a sanitized failure, never server body", async () => {
	const h = harness((p, prompt, candidates) => chooseAutoModel(p, prompt, candidates, { apiKey: "test", fetch: async () => new Response("PRIVATE_SERVER_BODY", { status: 500 }) }));
	await h.command("on");
	await h.input();
	await h.command("last");
	const logged = JSON.parse(h.notifications.at(-1)!);
	assert.equal(logged.response, null);
	assert.match(logged.reason, /failed/);
	assert.ok(!JSON.stringify(h.entries).includes("PRIVATE_SERVER_BODY"));
});
test("validated evidence excludes arbitrary extra response fields", async () => {
	const raw = await response().json();
	raw.answers.execution.extra = "PRIVATE_METADATA";
	const result = await chooseAutoModel(policy, "task", [execution], { apiKey: "test", fetch: async () => new Response(JSON.stringify(raw)) });
	assert.ok(result.response);
	assert.ok(!JSON.stringify(result).includes("PRIVATE_METADATA"));
});
test("manual model selection disables auto", async () => {
	const h = harness();
	await h.command("on");
	await h.handlers.get("model_select")!({}, h.ctx);
	await h.input();
	assert.equal(h.switches.length, 0);
});
test("off invalidates an in-flight decision", async () => {
	let release!: Function;
	const h = harness(() => new Promise((resolve) => { release = resolve; }));
	await h.command("on");
	const input = h.input();
	await new Promise((resolve) => setImmediate(resolve));
	await h.command("off");
	release({ action: "select", execution, confidence: 0.95, probability: 0.95, elapsedMs: 1 });
	await input;
	assert.equal(h.switches.length, 0);
});
test("changed scope invalidates a pending route", async () => {
	let release!: Function;
	const h = harness(() => new Promise((resolve) => { release = resolve; }));
	await h.command("on");
	const input = h.input();
	await new Promise((resolve) => setImmediate(resolve));
	h.ctx.scopedModels = [{ model: { provider: "test", id: "other" } }];
	release({ action: "select", execution, confidence: 0.95, probability: 0.95, elapsedMs: 1 });
	await input;
	assert.equal(h.switches.length, 0);
});
