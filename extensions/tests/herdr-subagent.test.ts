import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import herdrSubagentExtension, { herdrOk, isRunDetails, resultText } from "../herdr-subagent.ts";

function execPi(result: { code: number; stdout?: string; stderr?: string }) {
	return {
		exec: async () => ({
			code: result.code,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			killed: false,
		}),
	} as any;
}

test("herdrOk accepts exit 0 with empty stdout", async () => {
	await herdrOk(execPi({ code: 0 }), ["pane", "run", "w1:p1", "printf ok"]);
});

test("herdrOk preserves structured and plain nonzero errors", async () => {
	await assert.rejects(
		herdrOk(
			execPi({
				code: 1,
				stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane is gone" } }),
			}),
			["pane", "run", "w1:p1", "printf ok"],
		),
		(error: unknown) => error instanceof Error && error.message === "pane is gone",
	);

	await assert.rejects(
		herdrOk(execPi({ code: 2, stderr: "usage: herdr pane run <pane_id> <command>" }), [
			"pane",
			"run",
			"w1:p1",
		]),
		/usage: herdr pane run/,
	);
});

const validDetails = {
	status: "failed",
	task: "inspect",
	cwd: "/tmp",
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	agentName: "sub-test",
	attachCommand: "herdr tab focus w1:t1",
	captureCommand: "herdr pane read w1:p1",
	killCommand: "herdr tab close w1:t1",
	provider: "openai-codex",
	model: "gpt-test",
	thinking: "high",
	error: "Operation aborted",
	stopReason: "aborted",
};

test("run details validation rejects empty and malformed details", () => {
	assert.equal(isRunDetails({}), false);
	assert.equal(isRunDetails({ ...validDetails, status: "bogus" }), false);
	assert.equal(isRunDetails({ ...validDetails, model: undefined }), false);
	assert.equal(isRunDetails(validDetails), true);
});

test("renderer falls back to raw tool content for empty details", () => {
	let tool: any;
	const pi = {
		on: () => undefined,
		registerTool: (definition: any) => {
			tool = definition;
		},
		getThinkingLevel: () => "high",
	} as any;
	herdrSubagentExtension(pi);

	const component = tool.renderResult(
		{ details: {}, content: [{ type: "text", text: "herdr pane run failed" }] },
		{ expanded: false, isPartial: false },
		{},
	);
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /herdr pane run failed/);
	assert.doesNotMatch(rendered, /undefined/);
});

test("aborted child results expose both error and stop reason", () => {
	const text = resultText({
		...validDetails,
		output: "(no text output)",
		startedAt: 1_000,
		finishedAt: 2_000,
	} as any);
	assert.match(text, /Stop reason: aborted/);
	assert.match(text, /Error: Operation aborted/);
});

test("a shutdown retry preserves an already-settled successful result", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "herdr-subagent-reporter-"));
	const resultDir = join(sandbox, "missing-on-first-write");
	const resultPath = join(resultDir, "result.json");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const previousChild = process.env.PI_HERDR_SUBAGENT_CHILD;
	const previousResult = process.env.PI_HERDR_SUBAGENT_RESULT;
	const previousExit = process.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH;
	const previousConsoleError = console.error;

	process.env.PI_HERDR_SUBAGENT_CHILD = "1";
	process.env.PI_HERDR_SUBAGENT_RESULT = resultPath;
	process.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH = "0";
	console.error = () => undefined;

	try {
		herdrSubagentExtension({
			on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => handlers.set(event, handler),
			getThinkingLevel: () => "high",
		} as any);
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "finished answer" }],
							stopReason: "stop",
							provider: "openai-codex",
							model: "gpt-test",
						},
					},
				],
				getSessionFile: () => "/tmp/child.jsonl",
			},
			model: { provider: "openai-codex", id: "gpt-test" },
		};

		await handlers.get("agent_settled")?.({}, ctx);
		await mkdir(resultDir);
		await handlers.get("session_shutdown")?.({}, ctx);

		const result = JSON.parse(await readFile(resultPath, "utf8"));
		assert.equal(result.status, "completed");
		assert.equal(result.output, "finished answer");
		assert.equal(result.error, undefined);
	} finally {
		console.error = previousConsoleError;
		if (previousChild === undefined) delete process.env.PI_HERDR_SUBAGENT_CHILD;
		else process.env.PI_HERDR_SUBAGENT_CHILD = previousChild;
		if (previousResult === undefined) delete process.env.PI_HERDR_SUBAGENT_RESULT;
		else process.env.PI_HERDR_SUBAGENT_RESULT = previousResult;
		if (previousExit === undefined) delete process.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH;
		else process.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH = previousExit;
		await rm(sandbox, { recursive: true, force: true });
	}
});
