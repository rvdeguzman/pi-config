import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import exitCommand from "../exit.ts";

test("/exit requests a clean shutdown", async () => {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (name: string, command: { description: string; handler: typeof handler }) => {
			assert.equal(name, "exit");
			assert.equal(command.description, "Exit Pi cleanly");
			handler = command.handler;
		},
	};
	exitCommand(pi as ExtensionAPI);
	assert.ok(handler);

	let shutdowns = 0;
	await handler("", { shutdown: () => shutdowns++ } as unknown as ExtensionCommandContext);
	assert.equal(shutdowns, 1);
});
