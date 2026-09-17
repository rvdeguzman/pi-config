import assert from "node:assert/strict";
import test from "node:test";
import { decideRoute, MAX_TASK_CHARS, parseChoice, parseRoutingPolicy, type RoutingPolicy, type RouteCandidate, type RoutingTask } from "../lib/jev-routing.ts";

const policy: RoutingPolicy = {
	version: 1, model: "jev-latest", timeoutMs: 2500, minConfidence: 0.8, minProbability: 0.7,
	objective: "Avoid unnecessary delegation.",
	profiles: { scout: { description: "Read local code", models: [{ id: "provider/small", description: "Routine" }] } },
};
const candidates: RouteCandidate[] = [
	{ profile: "scout", description: "Read local code", tools: ["read"], models: [
		{ id: "provider/small", description: "Routine", thinking: "high" },
		{ id: "provider/large", description: "Deep", thinking: "high" },
	] },
	{ profile: "worker", description: "Implement", tools: ["write"], models: [{ id: "provider/large", description: "Deep", thinking: "high" }] },
];
const task: RoutingTask = { task: "Trace a difficult cross-module initialization path and cite all relevant files.", delivery: "async", allowWrites: false };

function answer(labels: string[], chosen: string, confidence = 0.95, probability = 0.95) {
	return { type: "choice", choice: chosen, confidence, probabilities: Object.fromEntries(labels.map((label) => [label, label === chosen ? (labels.length === 1 ? 1 : probability) : (1 - probability) / (labels.length - 1)])) };
}

function transport(choices: Record<string, string> = {}) {
	const calls: any[] = [];
	let mutate: ((payload: any, request: any) => void) | undefined;
	const fetcher: typeof fetch = async (url, options) => {
		assert.equal(url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(options?.redirect, "error");
		assert.equal((options?.headers as any).Authorization, "Bearer secret-test-key");
		const request = JSON.parse(options!.body as string);
		calls.push(request);
		const payload = { answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]: [string, any]) => [name, answer(Object.keys(question.criteria), choices[name] ?? ({ dispatch: "delegate", profile: "scout", model: "provider/large" } as any)[name])])) };
		mutate?.(payload, request);
		return Response.json(payload);
	};
	return { calls, fetcher, mutate: (fn: typeof mutate) => { mutate = fn; } };
}

const options = (fetcher: typeof fetch) => ({ apiKey: "secret-test-key", fetch: fetcher });

test("policy parser validates explicit global allowlists and thresholds", () => {
	assert.deepEqual(parseRoutingPolicy(policy), policy);
	for (const patch of [{ version: 2 }, { timeoutMs: 0 }, { timeoutMs: 1e6 }, { minConfidence: NaN }, { minProbability: 1.1 }, { profiles: {} }, { model: "" }]) {
		assert.throws(() => parseRoutingPolicy({ ...policy, ...patch }));
	}
	assert.throws(() => parseRoutingPolicy({ ...policy, profiles: { scout: { description: "x", models: [{ id: "bare", description: "x" }] } } }));
	assert.throws(() => parseRoutingPolicy({ ...policy, profiles: { scout: { description: "x", models: Array(2).fill({ id: "p/a", description: "x" }) } } }));
});

test("dispatch gate keeps task in parent and never asks for a model", async () => {
	const t = transport({ dispatch: "parent" });
	const result = await decideRoute(policy, task, candidates, options(t.fetcher));
	assert.equal(result.action, "parent");
	assert.equal(t.calls.length, 1);
});

test("gates dispatch, chooses profile, then only offers that profile's models", async () => {
	const t = transport();
	const result = await decideRoute(policy, task, candidates, options(t.fetcher));
	assert.equal(result.action, "delegate");
	if (result.action !== "delegate") return;
	assert.equal(result.profile, "scout");
	assert.equal(result.model, "provider/large");
	assert.equal(t.calls.length, 2);
	assert.equal(t.calls[1].state.selectedProfile, "scout");
	assert.deepEqual(Object.keys(t.calls[1].questions.model.criteria), ["provider/small", "provider/large"]);
	assert.deepEqual(result.evidence.map((entry) => entry.stage), ["dispatch", "profile", "model"]);
});

test("pinning a profile still evaluates dispatch; a singleton model needs no second call", async () => {
	const t = transport();
	const result = await decideRoute(policy, { ...task, agent: "worker", allowWrites: true }, candidates, options(t.fetcher));
	assert.equal(result.action, "delegate");
	if (result.action === "delegate") assert.equal(result.profile, "worker");
	assert.equal(t.calls.length, 1);
	assert.deepEqual(Object.keys(t.calls[0].questions), ["dispatch"]);
});

for (const stage of ["dispatch", "profile", "model"]) {
	test(`low ${stage} confidence returns parent`, async () => {
		const t = transport();
		t.mutate((payload) => { if (payload.answers[stage]) payload.answers[stage].confidence = 0.2; });
		const result = await decideRoute(policy, task, candidates, options(t.fetcher));
		assert.equal(result.action, "parent");
		assert.equal(t.calls.length, stage === "model" ? 2 : 1);
	});
}

test("confidence alone cannot override an ambiguous selected probability", async () => {
	const t = transport();
	t.mutate((payload) => { if (payload.answers.dispatch) payload.answers.dispatch = answer(["delegate", "parent"], "delegate", 0.99, 0.6); });
	assert.equal((await decideRoute(policy, task, candidates, options(t.fetcher))).action, "parent");
});

test("strict response validation rejects unknown, missing, malformed, and inconsistent choices", () => {
	const good = answer(["a", "b"], "a");
	assert.equal(parseChoice(good, ["a", "b"]).choice, "a");
	for (const malformed of [null, {}, { ...good, choice: "evil" }, { ...good, confidence: "0.9" }, { ...good, probabilities: { a: 0.9 } }, { ...good, probabilities: { a: 0.9, b: 0.1, extra: 0 } }, { ...good, probabilities: { a: 0.1, b: 0.9 } }, { ...good, probabilities: { a: 0.9, b: 0.9 } }, { ...good, probabilities: { a: NaN, b: 0.1 } }]) {
		assert.throws(() => parseChoice(malformed, ["a", "b"]));
	}
});

test("hallucinated model returns parent instead of falling back to an arbitrary model", async () => {
	const t = transport();
	t.mutate((payload) => { if (payload.answers.model) payload.answers.model.choice = "provider/unapproved"; });
	assert.equal((await decideRoute(policy, task, candidates, options(t.fetcher))).action, "parent");
});

test("missing key, no candidates, oversized input, and cancellation skip network", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async () => { calls++; throw new Error("must not call"); };
	assert.equal((await decideRoute(policy, task, candidates, { fetch: fetcher })).action, "parent");
	assert.equal((await decideRoute(policy, task, [], options(fetcher))).action, "parent");
	assert.equal((await decideRoute(policy, { ...task, task: "a".repeat(MAX_TASK_CHARS + 1) }, candidates, options(fetcher))).action, "parent");
	assert.equal((await decideRoute(policy, task, candidates, { ...options(fetcher), signal: AbortSignal.abort() })).action, "parent");
	assert.equal(calls, 0);
});

test("HTTP errors, malformed responses, and oversized bodies fail closed without leaking contents", async () => {
	for (const fetcher of [
		async () => new Response("SECRET", { status: 401 }),
		async () => new Response("SECRET", { status: 429 }),
		async () => new Response("SECRET", { status: 529 }),
		async () => new Response("not json SECRET"),
		async () => new Response("a".repeat(128_001)),
		async () => { throw new Error("SECRET credential or provider body"); },
	] as Array<typeof fetch>) {
		let calls = 0;
		const result = await decideRoute(policy, task, candidates, options(async (...args) => { calls++; return fetcher(...args); }));
		assert.equal(result.action, "parent");
		assert.equal(calls, 1, "no retry adds hidden routing latency");
		assert.doesNotMatch(JSON.stringify(result), /SECRET/);
	}
});

test("deadline bounds even an uncooperative transport", async () => {
	const started = Date.now();
	const result = await decideRoute({ ...policy, timeoutMs: 30 }, task, candidates, options(() => new Promise(() => {})));
	assert.equal(result.action, "parent");
	assert.ok(Date.now() - started < 1000);
});

test("one total deadline covers both stages, not a timeout per API call", async () => {
	const t = transport();
	const started = Date.now();
	const result = await decideRoute({ ...policy, timeoutMs: 70 }, task, candidates, options(async (...args) => {
		await new Promise((resolve) => setTimeout(resolve, 45));
		return t.fetcher(...args);
	}));
	assert.equal(result.action, "parent");
	assert.ok(Date.now() - started < 500);
});
