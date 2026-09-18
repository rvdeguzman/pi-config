import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearStoredApiKey, credentialsPath, storeApiKey } from "pi-typesafe";
import { createRoutingClient, ENDPOINT, MAX_RESPONSE_BYTES, type ChoiceRequest } from "../lib/typesafe-client.ts";
import { decideRoute, type RoutingPolicy } from "../lib/jev-routing.ts";
import { registerAutoDelegation } from "../lib/auto-delegation.ts";

const keyA = "synthetic-typesafe-key-a";
const keyB = "synthetic-typesafe-key-b";
const request: ChoiceRequest = { model: "jev-latest", state: { task: "Synthetic task" }, questions: {
	execution: { type: "choice", instructions: "Choose one", criteria: { a: "Option A", b: "Option B" } },
} };
const callOptions = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
const result = (questions = request.questions, chosen?: string) => ({ model: "jev-latest", usage: { input_tokens: 10, output_tokens: 0 }, answers:
	Object.fromEntries(Object.entries(questions).map(([name, question]) => {
		const labels = Object.keys(question.criteria);
		const choice = chosen ?? labels[0]!;
		return [name, { type: "choice", choice, confidence: 0.95, probabilities: Object.fromEntries(labels.map((label) => [label, labels.length === 1 ? 1 : label === choice ? 0.95 : 0.05 / (labels.length - 1)])) }];
	})),
});
const clientWith = (fetcher: typeof fetch, extra: Parameters<typeof createRoutingClient>[0] = {}) => createRoutingClient({ apiKey: () => keyA, fetch: fetcher, ...extra });
const models = [{ id: "test/light", description: "Routine" }];
const policy: RoutingPolicy = { version: 1, model: "jev-latest", timeoutMs: 1000, minConfidence: 0.8, minProbability: 0.7, objective: "Balanced", profiles: { scout: { description: "Read", models } } };
const candidates = [{ profile: "scout", description: "Read", tools: ["read"], models: [{ ...models[0]!, thinkingLevels: ["off" as const] }] }];
const task = { task: "Synthetic task", delivery: "async" as const, allowWrites: false };

test("delegation extension loads through Pi with the local declared dependency", async () => {
	const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const paths = ["../herdr-subagent.ts"].map(path => fileURLToPath(new URL(path, import.meta.url)));
	const loaded = await loadExtensions(paths, process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.ok(loaded.extensions[0].commands.has("delegate-auto"));
	assert.ok(loaded.extensions[0].tools.has("herdr_delegate"));
});

test("public package transport has fixed destination, no redirects/retries, usage, and sanitized answers", async () => {
	const oldUrl = process.env.TYPESAFE_BASE_URL;
	const oldLog = process.env.TYPESAFE_LOG_LEVEL;
	process.env.TYPESAFE_BASE_URL = "https://not-typesafe.invalid";
	process.env.TYPESAFE_LOG_LEVEL = "debug";
	try {
		const client = clientWith(async (url, init) => {
			assert.equal(url, ENDPOINT);
			assert.equal(init?.redirect, "error");
			assert.equal((init?.headers as any).Authorization, `Bearer ${keyA}`);
			assert.deepEqual(JSON.parse(String(init?.body)), request);
			const payload = result();
			(payload.answers.execution as any).extra = "PRIVATE_METADATA";
			return Response.json({ ...payload, extra: "PRIVATE_METADATA" });
		});
		const answer = await client.evaluate(request, callOptions());
		assert.equal(answer.execution!.choice, "a");
		assert.doesNotMatch(JSON.stringify(answer), /PRIVATE_METADATA/);
		assert.equal(client.getUsage().requestsSucceeded, 1);
		assert.equal(client.getUsage().inputTokens, 10);
		assert.doesNotMatch(client.status(), /synthetic-typesafe-key/);
	} finally {
		if (oldUrl === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = oldUrl;
		if (oldLog === undefined) delete process.env.TYPESAFE_LOG_LEVEL; else process.env.TYPESAFE_LOG_LEVEL = oldLog;
	}
});

test("shared credential resolution supports login, environment precedence, rotation and logout without stale-key reuse", async () => {
	const seen: string[] = [];
	const client = createRoutingClient({ fetch: async (_url, init) => {
		seen.push((init?.headers as any).Authorization);
		return Response.json(result());
	} });
	try {
		assert.equal(client.credentials().available, false);
		storeApiKey(keyA);
		assert.equal(client.credentials().available, true);
		await client.evaluate(request, callOptions());
		process.env.TYPESAFE_API_KEY = keyB;
		await client.evaluate(request, callOptions());
		delete process.env.TYPESAFE_API_KEY;
		storeApiKey(keyB);
		await client.evaluate(request, callOptions());
		clearStoredApiKey();
		assert.equal(client.credentials().available, false);
		await assert.rejects(client.evaluate(request, callOptions()), (error: any) => error.code === "configuration");
		assert.deepEqual(seen, [`Bearer ${keyA}`, `Bearer ${keyB}`, `Bearer ${keyB}`]);
		assert.equal(client.getUsage().requestsStarted, 3);
	} finally { delete process.env.TYPESAFE_API_KEY; clearStoredApiKey(); client.reset(); }
});

test("insecure login store cannot enable routing or send HTTP", async () => {
	let calls = 0;
	const client = createRoutingClient({ fetch: async () => { calls++; return Response.json(result()); } });
	try {
		storeApiKey(keyA);
		chmodSync(credentialsPath(), 0o644);
		assert.equal(client.credentials().available, false);
		assert.equal((await decideRoute(policy, task, candidates, { client })).action, "parent");
		assert.equal(calls, 0);
	} finally { clearStoredApiKey(); }
});

test("command preflight and real delegation router accept the stored login, not only environment keys", async () => {
	let calls = 0;
	const client = createRoutingClient({ fetch: async (_url, init) => {
		calls++;
		const input = JSON.parse(String(init?.body));
		return Response.json(result(input.questions, "parent"));
	} });
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const notifications: string[] = [];
	const pi: any = { on: (event: string, handler: Function) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, appendEntry() {} };
	const ctx: any = { hasUI: true, ui: { notify: (text: string) => notifications.push(text), setStatus() {} } };
	try {
		storeApiKey(keyA);
		registerAutoDelegation(pi, { loadPolicy: async () => policy, client, resolveTools: names => names, dispatch: async () => { throw new Error("No launch expected"); } });
		await commands.get("delegate-auto").handler("on", ctx);
		assert.match(notifications.at(-1)!, /on —/);
		const routed = await decideRoute(policy, task, candidates, { client });
		assert.equal(routed.action, "parent");
		assert.equal(routed.evidence[0]!.choice, "parent");
		assert.equal(calls, 1);
		clearStoredApiKey();
		assert.equal((await decideRoute(policy, task, candidates, { client })).action, "parent");
		assert.equal(calls, 1);
	} finally { clearStoredApiKey(); for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); }
});

test("package success envelopes still undergo strict routing validation", async () => {
	for (const mutate of [
		(p: any) => { p.answers.execution.probabilities = { a: 0.9, b: 0.9 }; },
		(p: any) => { p.answers.execution.probabilities = { a: 0.1, b: 0.9 }; },
		(p: any) => { p.answers.execution.choice = "unknown"; },
		(p: any) => { delete p.model; },
		(p: any) => { p.usage.input_tokens = -1; },
		(p: any) => { p.answers.unexpected = p.answers.execution; },
	]) {
		const payload = result(); mutate(payload);
		const client = clientWith(async () => Response.json(payload));
		await assert.rejects(client.evaluate(request, callOptions()));
		assert.match(client.status(), /Last failure/);
	}
});

test("HTTP errors are not retried, bodies are not read or echoed, and failure categories remain useful", async () => {
	for (const status of [401, 403, 429, 500]) {
		let calls = 0;
		const client = clientWith(async () => {
			calls++;
			return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("PRIVATE_ERROR")); }, cancel() { return new Promise(() => {}); } }), { status });
		});
		const decision = await decideRoute(policy, task, candidates, { client });
		assert.equal(decision.action, "parent");
		assert.equal(calls, 1);
		assert.doesNotMatch(JSON.stringify(decision) + client.status(), /PRIVATE_ERROR/);
		if (status === 401 || status === 403) assert.match(client.status(), /authentication or access rejected/);
	}
});

test("bounded transport rejects oversized streamed responses, malformed JSON, and redirects", async () => {
	for (const fetcher of [
		async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)),
		async () => new Response("PRIVATE_BAD_JSON"),
		async () => { const response = Response.json(result()); Object.defineProperty(response, "redirected", { value: true }); return response; },
	] as Array<typeof fetch>) {
		const client = clientWith(fetcher);
		assert.equal((await decideRoute(policy, task, candidates, { client })).action, "parent");
		assert.doesNotMatch(client.status(), /PRIVATE_BAD_JSON/);
	}
});

test("hard deadline bounds uncooperative fetch, stalled body and cancellation cleanup", async () => {
	for (const fetcher of [
		() => new Promise<Response>(() => {}),
		async () => new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } })),
	] as Array<typeof fetch>) {
		const client = clientWith(fetcher);
		const start = Date.now();
		const answer = await decideRoute({ ...policy, timeoutMs: 30 }, task, candidates, { client });
		assert.equal(answer.action, "parent");
		assert.ok(Date.now() - start < 1000);
	}
});

test("pre-abort skips HTTP and reset aborts in-flight requests without late success", async () => {
	let calls = 0;
	const client = clientWith(() => { calls++; return new Promise<Response>(() => {}); });
	await assert.rejects(client.evaluate(request, { ...callOptions(), signal: AbortSignal.abort() }));
	assert.equal(calls, 0);
	const pending = client.evaluate(request, callOptions());
	client.reset();
	await assert.rejects(pending);
	assert.equal(calls, 1);
	assert.equal(client.getUsage().requestsStarted, 0);
});

test("64 labels work; 65 labels and oversized UTF-8 payloads fail before HTTP", async () => {
	let calls = 0;
	const client = clientWith(async (_url, init) => { calls++; return Response.json(result(JSON.parse(String(init?.body)).questions)); });
	const make = (count: number): ChoiceRequest => ({ ...request, questions: { execution: { type: "choice", criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`label_${i}`, "Option"])) } } });
	await client.evaluate(make(64), callOptions());
	await assert.rejects(client.evaluate(make(65), callOptions()), (error: any) => error.code === "validation");
	await assert.rejects(client.evaluate({ ...request, state: "界".repeat(22000) }, callOptions()), (error: any) => error.code === "validation");
	assert.equal((await decideRoute(policy, { ...task, task: "界".repeat(22000) }, candidates, { client })).action, "parent");
	assert.equal(calls, 1);
});

test("default routing budget does not unexpectedly stop after the package's 20 attempts", async () => {
	const client = clientWith(async () => Response.json(result()));
	for (let i = 0; i < 21; i++) await client.evaluate(request, callOptions());
	assert.equal(client.getUsage().requestsStarted, 21);
});

test("an explicit session budget survives key/timeout rotation and fails closed in delegation", async () => {
	let calls = 0;
	let key = keyA;
	const client = clientWith(async () => { calls++; return Response.json(result()); }, { maxRequests: 2, apiKey: () => key });
	await client.evaluate(request, callOptions());
	key = keyB;
	await client.evaluate(request, { ...callOptions(), timeoutMs: 900 });
	assert.equal((await decideRoute(policy, task, candidates, { client })).action, "parent");
	assert.equal(calls, 2);
	assert.match(client.status(), /budget reached/);
});

test("lowered environment daily cap is picked up by a cached client without clearing local usage", async () => {
	const client = clientWith(async () => Response.json(result()));
	try {
		await client.evaluate(request, callOptions());
		process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = "1";
		await assert.rejects(client.evaluate(request, callOptions()), (error: any) => error.code === "budget");
		assert.equal(client.getUsage().requestsStarted, 1);
	} finally { delete process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY; }
});
