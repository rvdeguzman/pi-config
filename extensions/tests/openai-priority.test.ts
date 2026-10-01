import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import priorityExtension from "../openai-codex-priority/index.ts";

type RequestHandler = (event: { payload: unknown }, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function setup() {
	const handlers = new Map<string, RequestHandler>();
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	const changes: unknown[] = [];
	priorityExtension({
		on: (event: string, handler: RequestHandler) => handlers.set(event, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		events: { emit: (_event: string, value: unknown) => changes.push(value) },
	} as never);
	return {
		request: (provider: string, payload: unknown) =>
			handlers.get("before_provider_request")!({ payload }, { model: { provider } } as never),
		command: (args: string) => commands.get("fast")!.handler(args, {
			ui: { notify: (message: string) => notifications.push(message) },
		} as never),
		notifications,
		changes,
	};
}

for (const provider of ["openai", "openai-codex"]) {
	test(`/fast applies priority processing to ${provider} requests`, () => {
		const { request } = setup();
		const payload = { model: "test-model", input: [] };
		assert.deepEqual(request(provider, payload), { ...payload, service_tier: "priority" });
		assert.deepEqual(payload, { model: "test-model", input: [] });
	});
}

test("does not alter unrelated provider requests", () => {
	const { request } = setup();
	assert.equal(request("anthropic", { model: "test-model" }), undefined);
});

test("/fast toggles both OpenAI providers and persists the preference", async () => {
	const stateFile = join(getAgentDir(), "openai-codex-priority.json");
	const { request, command, notifications, changes } = setup();
	try {
		await command("off");
		for (const provider of ["openai", "openai-codex"]) {
			assert.deepEqual(request(provider, { model: "test-model", service_tier: "priority" }), { model: "test-model" });
		}
		assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { enabled: false });
		assert.deepEqual(setup().request("openai", { model: "test-model" }), { model: "test-model" });
		await command("on");
		for (const provider of ["openai", "openai-codex"]) {
			assert.deepEqual(request(provider, { model: "test-model" }), { model: "test-model", service_tier: "priority" });
		}
		await command("status");
		assert.deepEqual(changes, [false, true]);
		assert.deepEqual(notifications, ["OpenAI fast mode: OFF", "OpenAI fast mode: ON", "OpenAI fast mode: ON"]);
	} finally {
		rmSync(stateFile, { force: true });
	}
});
