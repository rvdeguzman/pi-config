import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import extensionImpl, { herdrOk, isRunDetails, parseChildExitCode, resultText } from "../herdr-subagent.ts";

function herdrSubagentExtension(pi: any): void {
	extensionImpl({ registerCommand: () => undefined, ...pi });
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("herdrOk accepts exit 0 with empty stdout", async () => {
	await herdrOk(execPi({ code: 0 }), ["pane", "run", "w1:p1", "printf ok"]);
});

test("exit sentinel parser ignores echoed commands and parses standalone lines", () => {
	const sentinel = "__pi_herdr_subagent_exit__abc123";
	const echoed = `rv@host $ env FOO=1 pi '@task.md' ; printf '\\n${sentinel} %s\\n' "$?"`;
	assert.equal(parseChildExitCode(echoed, sentinel), undefined);
	assert.equal(parseChildExitCode(`${echoed}\nworking...\n${sentinel} 17\n`, sentinel), 17);
	assert.equal(parseChildExitCode(`${sentinel} nope\n`, sentinel), undefined);
	assert.equal(parseChildExitCode(`prefix ${sentinel} 0\n`, sentinel), undefined);
});

test("herdrOk preserves structured and plain nonzero errors", async () => {
	await assert.rejects(
		herdrOk(
			execPi({
				code: 1,
				stderr: JSON.stringify({
					error: { code: "pane_not_found", message: "pane is gone" },
				}),
			}),
			["pane", "run", "w1:p1", "printf ok"],
		),
		(error: unknown) => error instanceof Error && error.message === "pane is gone",
	);

	await assert.rejects(
		herdrOk(execPi({ code: 2, stderr: "usage: herdr pane run <pane_id> <command>" }), ["pane", "run", "w1:p1"]),
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
	assert.equal(isRunDetails({ ...validDetails, autoClosed: "yes" }), false);
	assert.equal(isRunDetails({ ...validDetails, autoClosed: true }), true);
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

test("auto-closed results do not advertise stale Herdr commands", () => {
	const text = resultText({ ...validDetails, autoClosed: true } as any);
	assert.match(text, /tab w1:t1 \(auto-closed\)/);
	assert.doesNotMatch(text, /Attach:|Capture:|Clean up:/);
});

test("worker children do not register delegation tools", () => {
	const previousWorkerChild = process.env.PI_HERDR_WORKER_CHILD;
	process.env.PI_HERDR_WORKER_CHILD = "1";
	const registered: string[] = [];
	try {
		herdrSubagentExtension({
			registerTool: (definition: { name: string }) => registered.push(definition.name),
		} as any);
		assert.deepEqual(registered, []);
	} finally {
		if (previousWorkerChild === undefined) delete process.env.PI_HERDR_WORKER_CHILD;
		else process.env.PI_HERDR_WORKER_CHILD = previousWorkerChild;
	}
});

test("all explicit agent references route through async Herdr, including worker", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	let execCalled = false;
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getThinkingLevel: () => "high",
		exec: async () => {
			execCalled = true;
			throw new Error("unexpected process launch");
		},
	} as any;

	herdrSubagentExtension(pi);
	const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {});
	assert.match(prompt.systemPrompt, /Route every valid &name through herdr_async, including &worker/);
	assert.match(prompt.systemPrompt, /herdr_subagent only for a parent-selected blocking dependency/);
	assert.match(prompt.systemPrompt, /herdr_worker only when no automatic result is wanted/);

	const asyncTool = tools.get("herdr_async");
	const subagent = tools.get("herdr_subagent");
	const worker = tools.get("herdr_worker");
	assert.ok(asyncTool);
	assert.ok(subagent);
	assert.ok(worker);
	assert.match(asyncTool.promptGuidelines.join("\n"), /every explicit &name.*including &worker/);
	assert.doesNotMatch(worker.promptGuidelines.join("\n"), /Route an explicit &worker/);
	assert.match(worker.promptGuidelines.join("\n"), /no automatic completion result/);
	assert.match(subagent.description, /Available blocking profiles:/);
	assert.doesNotMatch(subagent.description, /Available blocking profiles:[^.]*worker/);
	assert.match(subagent.promptGuidelines.join("\n"), /route explicit &name references through herdr_async/);
	await assert.rejects(
		subagent.execute("blocking-worker", { agent: "WoRkEr", task: "implement it" }, undefined, undefined, {}),
		/worker profile is not available.*Use herdr_async.*herdr_worker/s,
	);
	assert.equal(execCalled, false);
});

test("herdr_worker dispatches immediately without polling for a result", async () => {
	const tools = new Map<string, any>();
	const calls: string[][] = [];
	let childCommand = "";
	let runDir = "";
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_WORKSPACE_ID;

	const pi = {
		on: () => undefined,
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getThinkingLevel: () => "high",
		getAllTools: () => ["read", "herdr_subagent", "herdr_worker"].map((name) => ({ name })),
		getActiveTools: () => ["read", "herdr_subagent", "herdr_worker"],
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "--version") return { code: 0, stdout: "herdr test", stderr: "", killed: false };
			if (args[0] === "workspace" && args[1] === "create") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspace: { workspace_id: "w1" },
							tab: { tab_id: "w1:t1" },
							root_pane: { pane_id: "w1:p1" },
						},
					}),
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "pane" && args[1] === "run") {
				childCommand = args[3] ?? "";
				const sessionDir = childCommand.match(/'--session-dir' '([^']+)'/)?.[1];
				assert.ok(sessionDir);
				runDir = dirname(sessionDir);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			throw new Error(`unexpected result-polling call: ${args.join(" ")}`);
		},
	} as any;

	try {
		herdrSubagentExtension(pi);
		const result = await tools.get("herdr_worker").execute(
			"worker-1",
			{ task: "implement the focused fix" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				model: { provider: "openai-codex", id: "gpt-test" },
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => `worker-${Date.now()}` },
			},
		);

		assert.match(result.content[0].text, /Worker dispatched/);
		assert.match(result.content[0].text, /herdr tab focus w1:t1/);
		assert.equal(result.details.tabId, "w1:t1");
		assert.equal(result.details.paneId, "w1:p1");
		assert.match(childCommand, /PI_HERDR_WORKER_CHILD=1/);
		assert.doesNotMatch(childCommand, /PI_HERDR_SUBAGENT_RESULT|result\.json/);
		assert.match(childCommand, /'--tools' 'read'/);
		assert.doesNotMatch(childCommand, /herdr_subagent|herdr_worker.*--tools/);
		assert.deepEqual(
			calls.map((args) => args.slice(0, 2)),
			[["--version"], ["workspace", "create"], ["pane", "run"]],
			"dispatch must return without pane, agent, or result-file polling",
		);
	} finally {
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
		if (runDir) await rm(dirname(runDir), { recursive: true, force: true });
	}
});

test("herdr_async returns immediately and steers eventual completion or failure into the parent", async () => {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: Array<{ message: any; options: any }> = [];
	const closedTabs: string[] = [];
	const resultPaths: string[] = [];
	let childCommand = "";
	let paneReads = 0;
	let nextChildResult: Record<string, unknown> = {
		version: 1,
		status: "completed",
		output: "async answer",
		provider: "openai-codex",
		model: "gpt-test",
		thinking: "high",
	};
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_WORKSPACE_ID;

	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getThinkingLevel: () => "high",
		getAllTools: () => ["read", "herdr_subagent", "herdr_worker", "herdr_async", "herdr_delegate"].map((name) => ({ name })),
		getActiveTools: () => ["read", "herdr_subagent", "herdr_worker", "herdr_async", "herdr_delegate"],
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		exec: async (_command: string, args: string[]) => {
			if (args[0] === "--version") return { code: 0, stdout: "herdr test", stderr: "", killed: false };
			if (args[0] === "workspace" && args[1] === "create") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspace: { workspace_id: "w1" },
							tab: { tab_id: "w1:t1" },
							root_pane: { pane_id: "w1:p1" },
						},
					}),
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "pane" && args[1] === "run") {
				childCommand = args[3] ?? "";
				const resultPath = childCommand.match(/PI_HERDR_SUBAGENT_RESULT='([^']+)'/)?.[1] ?? "";
				assert.ok(resultPath);
				resultPaths.push(resultPath);
				const childResult = { ...nextChildResult };
				setTimeout(async () => {
					await writeFile(resultPath, JSON.stringify({ ...childResult, finishedAt: Date.now() }));
				}, 80);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args[0] === "pane" && args[1] === "read") {
				paneReads++;
				return { code: 0, stdout: "child running", stderr: "", killed: false };
			}
			if (args[0] === "agent" && args[1] === "get") {
				return { code: 1, stdout: "", stderr: "no agent", killed: false };
			}
			if (args[0] === "tab" && args[1] === "close") {
				closedTabs.push(args[2] ?? "");
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			throw new Error(`unexpected herdr args: ${args.join(" ")}`);
		},
	} as any;

	try {
		herdrSubagentExtension(pi);
		const result = await tools.get("herdr_async").execute(
			"async-1",
			{ agent: "worker", task: "finish in the background" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				model: { provider: "openai-codex", id: "gpt-test" },
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => `async-${Date.now()}` },
			},
		);

		assert.match(result.content[0].text, /delivered automatically; do not poll/i);
		assert.equal(result.details.status, "running");
		assert.equal(result.details.profile, "worker");
		assert.equal(messages.length, 0, "dispatch should return before completion delivery");
		assert.match(childCommand, /PI_HERDR_SUBAGENT_CHILD=1/);
		assert.match(childCommand, /PI_HERDR_SUBAGENT_EXIT_ON_FINISH=1/);
		assert.match(childCommand, /'--tools' 'read'/);
		assert.doesNotMatch(childCommand.match(/'--tools' '[^']*'/)?.[0] ?? "", /herdr_(?:subagent|worker|async|delegate)/);

		await waitFor(() => messages.length === 1);
		assert.ok(paneReads > 0);
		assert.deepEqual(closedTabs, ["w1:t1"]);
		assert.equal(messages[0].message.customType, "herdr-async-result");
		assert.match(messages[0].message.content, /Async Herdr subagent "worker" completed/);
		assert.match(messages[0].message.content, /async answer/);
		assert.deepEqual(messages[0].options, { deliverAs: "steer", triggerTurn: true });

		nextChildResult = {
			version: 1,
			status: "failed",
			output: "partial async output",
			error: "child task failed",
		};
		const failedDispatch = await tools.get("herdr_async").execute(
			"async-2",
			{ agent: "worker", task: "fail in the background" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				model: { provider: "openai-codex", id: "gpt-test" },
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => `async-failure-${Date.now()}` },
			},
		);
		assert.equal(failedDispatch.details.status, "running");
		assert.equal(messages.length, 1, "failure must also arrive asynchronously");
		await waitFor(() => messages.length === 2);
		assert.match(messages[1].message.content, /Async Herdr subagent "worker" failed/);
		assert.match(messages[1].message.content, /child task failed/);
		assert.match(messages[1].message.content, /partial async output/);
		assert.deepEqual(closedTabs, ["w1:t1", "w1:t1"]);
	} finally {
		await handlers.get("session_shutdown")?.({}, { hasUI: false });
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
		await Promise.all(resultPaths.map((resultPath) => rm(dirname(resultPath), { recursive: true, force: true })));
	}
});

test("a result arriving during exit grace wins over the exit sentinel and auto-closes its tab", async () => {
	let tool: any;
	let childCommand = "";
	let resultPath = "";
	let sentinel = "";
	const closedTabs: string[] = [];
	const sessionId = `grace-race-${Date.now()}`;
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_WORKSPACE_ID;

	const pi = {
		on: () => undefined,
		registerTool: (definition: any) => {
			tool = definition;
		},
		getThinkingLevel: () => "high",
		getAllTools: () => ["read", "grep", "find", "ls"].map((name) => ({ name })),
		getActiveTools: () => ["read", "grep", "find", "ls"],
		exec: async (_command: string, args: string[]) => {
			if (args[0] === "--version") return { code: 0, stdout: "herdr test", stderr: "", killed: false };
			if (args[0] === "workspace" && args[1] === "create") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspace: { workspace_id: "w1" },
							tab: { tab_id: "w1:t1" },
							root_pane: { pane_id: "w1:p1" },
						},
					}),
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "pane" && args[1] === "run") {
				childCommand = args[3] ?? "";
				assert.doesNotMatch(childCommand, /--session-id/);
				resultPath = childCommand.match(/PI_HERDR_SUBAGENT_RESULT='([^']+)'/)?.[1] ?? "";
				sentinel = childCommand.match(/(__pi_herdr_subagent_exit__[a-f0-9]+) %s/)?.[1] ?? "";
				assert.ok(resultPath);
				assert.ok(sentinel);
				setTimeout(async () => {
					await writeFile(
						resultPath,
						JSON.stringify({
							version: 1,
							status: "completed",
							output: "late but valid",
							finishedAt: Date.now(),
						}),
					);
				}, 700);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args[0] === "pane" && args[1] === "read") {
				return {
					code: 0,
					stdout: `${sentinel} 0\n`,
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "agent" && args[1] === "get") {
				return { code: 1, stdout: "", stderr: "no agent", killed: false };
			}
			if (args[0] === "tab" && args[1] === "close") {
				closedTabs.push(args[2] ?? "");
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			throw new Error(`unexpected herdr args: ${args.join(" ")}`);
		},
	} as any;

	try {
		herdrSubagentExtension(pi);
		const result = await tool.execute(
			"call-1",
			{ agent: "scout", task: "wait for a late result" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				model: { provider: "openai-codex", id: "gpt-test" },
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => sessionId },
			},
		);
		assert.match(result.content[0].text, /late but valid/);
		assert.match(result.content[0].text, /auto-closed/);
		assert.equal(result.details.autoClosed, true);
		assert.match(childCommand, /PI_HERDR_SUBAGENT_EXIT_ON_FINISH=1/);
		assert.deepEqual(closedTabs, ["w1:t1"]);
	} finally {
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
		if (resultPath) await rm(dirname(resultPath), { recursive: true, force: true });
	}
});

test("sibling subagent calls run concurrently and auto-close independently", async () => {
	let tool: any;
	let paneSequence = 0;
	let activeRuns = 0;
	let maximumActiveRuns = 0;
	const closedTabs: string[] = [];
	const resultDirectories: string[] = [];
	const pi = {
		on: () => undefined,
		registerTool: (definition: any) => {
			tool = definition;
		},
		getThinkingLevel: () => "low",
		getAllTools: () => ["read", "grep", "find", "ls"].map((name) => ({ name })),
		getActiveTools: () => ["read"],
		exec: async (_command: string, args: string[]) => {
			if (args[0] === "--version") return { code: 0, stdout: "herdr test", stderr: "", killed: false };
			if ((args[0] === "workspace" || args[0] === "tab") && args[1] === "create") {
				const id = ++paneSequence;
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspace: { workspace_id: `w${id}` },
							tab: { tab_id: `w${id}:t1` },
							root_pane: { pane_id: `w${id}:p1` },
						},
					}),
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "pane" && args[1] === "run") {
				const resultPath = (args[3] ?? "").match(/PI_HERDR_SUBAGENT_RESULT='([^']+)'/)?.[1] ?? "";
				resultDirectories.push(dirname(resultPath));
				activeRuns++;
				maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
				setTimeout(async () => {
					await writeFile(
						resultPath,
						JSON.stringify({
							version: 1,
							status: "completed",
							output: "done",
							finishedAt: Date.now(),
						}),
					);
					activeRuns--;
				}, 100);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args[0] === "pane" && args[1] === "read") return { code: 0, stdout: "", stderr: "", killed: false };
			if (args[0] === "agent" && args[1] === "get") return { code: 1, stdout: "", stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "close") {
				closedTabs.push(args[2] ?? "");
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			throw new Error(`unexpected herdr args: ${args.join(" ")}`);
		},
	} as any;
	herdrSubagentExtension(pi);
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "openai-codex", id: "gpt-test" },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => `concurrent-${Date.now()}` },
	} as any;
	try {
		await Promise.all([
			tool.execute("one", { agent: "scout", task: "first" }, undefined, undefined, ctx),
			tool.execute("two", { agent: "scout", task: "second" }, undefined, undefined, ctx),
		]);
		assert.equal(maximumActiveRuns, 2);
		assert.deepEqual(closedTabs.sort(), ["w1:t1", "w2:t1"]);
	} finally {
		await Promise.all(resultDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
	}
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
