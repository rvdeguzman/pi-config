import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Keep run directories and profiles out of the real agent directory. The
// registry rereads agents/*.md on every call, so each profile variant a test
// needs is a file here.
const agentDir = await mkdtemp(join(tmpdir(), "herdr-subagent-agentdir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "agents"));
await writeFile(join(agentDir, "agents", "scout.md"), "---\nname: scout\nthinking: low\ntools: [read, grep]\n---\n");
await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\nthinking: high\n---\n");
const testProfiles: Record<string, string> = {
	fallback: "thinking: low\ntools: [read, grep]\nmodel: [openai-codex/first, openai-codex/second]",
	nostart: "thinking: low\ntools: [read, grep]\nmodel: [nope/missing, openai-codex/second]",
	"nostart-only": "thinking: low\ntools: [read, grep]\nmodel: nope/missing",
	isolated: "thinking: high\nworktree: true",
	"scout-worktree": "thinking: low\ntools: [read, grep]\nworktree: true",
};
for (const [name, body] of Object.entries(testProfiles)) {
	await writeFile(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\n${body}\n---\n`);
}
// These tests may themselves run inside a delegated child, Herdr, or tmux.
for (const key of Object.keys(process.env)) {
	if (/^(HERDR_|TMUX|PI_HERDR_SUBAGENT_)/.test(key)) delete process.env[key];
}
process.env.PI_SUBAGENT_BACKEND = "herdr";
after(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

const { default: extensionImpl, isRunDetails, pruneRunDirs, resolveChildTools, resultText } = await import(
	"../subagent.ts"
);
const { herdrOk } = await import("../lib/subagent-backends.ts");
const { createFakeHerdr } = await import("./fake-herdr.ts");
type FakeHerdr = ReturnType<typeof createFakeHerdr>;

function herdrSubagentExtension(pi: any): void {
	extensionImpl({ registerCommand: () => undefined, ...pi });
}

function execPi(result: { code: number; stdout?: string; stderr?: string }) {
	return {
		exec: async () => ({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false }),
	} as any;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

interface Harness {
	pi: any;
	tools: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	messages: Array<{ message: any; options: any }>;
	ctx: any;
	herdr: FakeHerdr;
}

function harness(herdr: FakeHerdr, options: { sessionId?: string; cwd?: string; toolNames?: string[] } = {}): Harness {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: Array<{ message: any; options: any }> = [];
	const toolNames = options.toolNames ?? [
		"read",
		"grep",
		"find",
		"ls",
		"bash",
		"subagent",
		"subagent_async",
	];
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getThinkingLevel: () => "high",
		getAllTools: () => toolNames.map((name) => ({ name })),
		getActiveTools: () => toolNames,
		sendMessage: (message: any, sendOptions: any) => messages.push({ message, options: sendOptions }),
		exec: herdr.exec,
	} as any;
	const sessionId = options.sessionId ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		model: { provider: "openai-codex", id: "gpt-test" },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => sessionId },
		ui: { addAutocompleteProvider: () => undefined, setWidget: () => undefined, notify: () => undefined },
	};
	herdrSubagentExtension(pi);
	return { pi, tools, handlers, messages, ctx, herdr };
}


test("herdrOk accepts exit 0 with empty stdout", async () => {
	await herdrOk(execPi({ code: 0 }), ["tab", "close", "w1:t1"]);
});

test("herdrOk preserves structured and plain nonzero errors", async () => {
	await assert.rejects(
		herdrOk(
			execPi({ code: 1, stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane is gone" } }) }),
			["tab", "close", "w1:t1"],
		),
		(error: unknown) => error instanceof Error && error.message === "pane is gone",
	);
	await assert.rejects(
		herdrOk(execPi({ code: 2, stderr: "usage: herdr tab close <tab_id>" }), ["tab", "close"]),
		/usage: herdr tab close/,
	);
});

const validDetails = {
	status: "failed",
	task: "inspect",
	cwd: "/tmp",
	backend: "herdr",
	target: "herdr pane w1:p1, tab w1:t1",
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
	assert.equal(isRunDetails({ ...validDetails, worktree: "nope" }), false);
	assert.equal(isRunDetails({ ...validDetails, autoClosed: true }), true);
	assert.equal(isRunDetails(validDetails), true);
});

test("renderer falls back to raw tool content for empty details", () => {
	const { tools } = harness(createFakeHerdr());
	const component = tools
		.get("subagent")
		.renderResult(
			{ details: {}, content: [{ type: "text", text: "herdr agent start failed" }] },
			{ expanded: false, isPartial: false },
			{},
		);
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /herdr agent start failed/);
	assert.doesNotMatch(rendered, /undefined/);
});

test("result text exposes errors, run ids, and hides stale commands once auto-closed", () => {
	const text = resultText({ ...validDetails, output: "(no text output)", startedAt: 1_000, finishedAt: 2_000 } as any);
	assert.match(text, /Stop reason: aborted/);
	assert.match(text, /Error: Operation aborted/);
	const closed = resultText({ ...validDetails, autoClosed: true, runId: "0123456789abcdef" } as any);
	assert.match(closed, /tab w1:t1 \(auto-closed\)/);
	assert.match(closed, /Run: 01234567/);
	assert.doesNotMatch(closed, /Attach:|Capture:|Clean up:/);
});

test("the extensions tools token grants every active extension tool, but never delegation tools", () => {
	const builtin = (name: string) => ({ name, exposure: "direct", sourceInfo: { path: `builtin:${name}`, source: "builtin" } });
	const fromExtension = (name: string, exposure = "direct") => ({
		name,
		exposure,
		sourceInfo: { path: `/ext/${name}.ts`, source: "local" },
	});
	const pi = {
		getAllTools: () => [
			builtin("read"),
			builtin("bash"),
			fromExtension("web_search_exa"),
			fromExtension("image_generation", "model-only"),
			fromExtension("hidden_tool", "hidden"),
			fromExtension("deferred_tool", "deferred"),
			{ name: "sdk_tool", exposure: "direct", sourceInfo: { path: "<sdk:sdk_tool>", source: "sdk" } },
			{ name: "mcp_call", exposure: "direct", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			fromExtension("subagent_async"),
			fromExtension("subagent"),
		],
	} as any;
	assert.deepEqual(resolveChildTools(pi, ["read", "extensions"], "scout"), [
		"read",
		"web_search_exa",
		"image_generation",
		"mcp_call",
	]);
	assert.deepEqual(resolveChildTools(pi, ["extensions", "web_search_exa", "read"], "scout"), [
		"web_search_exa",
		"image_generation",
		"mcp_call",
		"read",
	]);
	assert.throws(() => resolveChildTools(pi, ["read", "nope"], "scout"), /unknown tool\(s\): nope/);
});

test("all explicit agent references route through subagent_async, including worker", async () => {
	let execCalled = false;
	const { tools, handlers } = harness({
		...createFakeHerdr(),
		exec: async () => {
			execCalled = true;
			throw new Error("unexpected process launch");
		},
	} as any);
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await handlers.get("before_agent_start")?.(event, {});
	const guidance = event.systemPromptOptions.sections.agent_profiles!;
	assert.match(guidance, /Route every valid &name through subagent_async, including &worker/);
	assert.match(guidance, /subagent only for a parent-selected blocking dependency/);
	assert.doesNotMatch(guidance, /herdr_/);

	assert.match(tools.get("subagent_async").promptGuidelines.join("\n"), /every explicit &name.*including &worker/);
	const subagent = tools.get("subagent");
	assert.match(subagent.description, /Available blocking profiles:/);
	assert.doesNotMatch(subagent.description, /Available blocking profiles:[^.]*worker/);
	assert.deepEqual([...tools.keys()].sort(), ["subagent", "subagent_async"]);
	await assert.rejects(
		subagent.execute("blocking-worker", { agent: "WoRkEr", task: "implement it" }, undefined, undefined, {}),
		/worker profile is not available.*Use subagent_async/s,
	);
	assert.equal(execCalled, false);
});

test("subagent_async returns immediately and steers eventual completion or failure into the parent", async () => {
	let nextResult: Record<string, unknown> = { output: "async answer", provider: "openai-codex", model: "gpt-test" };
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => void setTimeout(() => void fake.complete(launch, nextResult), 80),
	});
	const { tools, messages, ctx, handlers } = harness(herdr);
	try {
		const result = await tools.get("subagent_async").execute("async-1", { agent: "worker", task: "finish in the background" }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /delivered automatically; do not poll/i);
		assert.match(result.content[0].text, /run [0-9a-f]{8}/);
		assert.equal(result.details.status, "running");
		assert.equal(result.details.profile, "worker");
		assert.equal(messages.length, 0, "dispatch should return before completion delivery");

		const launch = herdr.launches[0]!;
		assert.equal(launch.env.PI_HERDR_SUBAGENT_CHILD, "1");
		assert.equal(launch.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH, "1");
		assert.match(launch.env.PI_HERDR_SUBAGENT_RESULT!, /result\.json$/);
		const toolsArg = launch.argv![launch.argv!.indexOf("--tools") + 1]!;
		assert.deepEqual(toolsArg.split(",").filter((name) => name.startsWith("subagent")), []);
		assert.equal(launch.prompt, "finish in the background");

		await waitFor(() => messages.length === 1);
		assert.deepEqual(herdr.closedTabs, ["w1:t1"]);
		assert.equal(messages[0]!.message.customType, "subagent-async-result");
		assert.match(messages[0]!.message.content, /Async subagent "worker" completed/);
		assert.match(messages[0]!.message.content, /async answer/);
		assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });

		nextResult = { status: "failed", output: "partial async output", error: "child task failed", failureKind: "task" };
		await tools.get("subagent_async").execute("async-2", { agent: "worker", task: "fail in the background" }, undefined, undefined, ctx);
		await waitFor(() => messages.length === 2);
		assert.match(messages[1]!.message.content, /Async subagent "worker" failed/);
		assert.match(messages[1]!.message.content, /child task failed/);
		assert.match(messages[1]!.message.content, /partial async output/);
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	}
});

test("async runs fall back to the next model only on retryable provider failures", async () => {
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			const model = launch.argv![launch.argv!.indexOf("--model") + 1];
			const result =
				model === "first"
					? { status: "failed", output: "", error: "429 rate limited", failureKind: "provider" }
					: { output: `answer from ${model}` };
			setTimeout(() => void fake.complete(launch, result), 30);
		},
	});
	const { tools, messages, ctx, handlers } = harness(herdr);
	try {
		await tools.get("subagent_async").execute("fallback", { agent: "fallback", task: "look" }, undefined, undefined, ctx);
		await waitFor(() => messages.length === 1);
		assert.equal(herdr.launches.length, 2);
		assert.match(messages[0]!.message.content, /completed/);
		assert.match(messages[0]!.message.content, /answer from second/);
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	}
});

test("a child that fails to start falls back to the next model", async () => {
	const herdr = createFakeHerdr({
		startError: (launch) => (launch.argv!.includes("nope") ? 'Unknown provider "nope"' : undefined),
	});
	const { tools, ctx } = harness(herdr);
	const result = await tools.get("subagent").execute("start", { agent: "nostart", task: "look" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /openai-codex\/second/);
	assert.equal(herdr.launches.length, 2);
	assert.ok(herdr.closedTabs.includes(herdr.launches[0]!.tabId));

	await assert.rejects(
		tools.get("subagent").execute("start2", { agent: "nostart-only", task: "look" }, undefined, undefined, ctx),
		/Child Pi did not start/,
	);
});

test("a result arriving during exit grace wins over a vanished agent and auto-closes its tab", async () => {
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			launch.exited = true; // Herdr already lost the agent…
			setTimeout(() => void fake.complete(launch, { output: "late but valid" }), 700); // …but the result lands in grace.
		},
	});
	const { tools, ctx } = harness(herdr);
	const result = await tools.get("subagent").execute("call-1", { agent: "scout", task: "wait for a late result" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /late but valid/);
	assert.match(result.content[0].text, /auto-closed/);
	assert.equal(result.details.autoClosed, true);
	assert.deepEqual(herdr.closedTabs, ["w1:t1"]);
});

test("a child that exits without a result fails the blocking call with pane context", async () => {
	const herdr = createFakeHerdr({
		onPrompt: (launch) => {
			launch.exited = true;
		},
	});
	const { tools, ctx } = harness(herdr);
	await assert.rejects(
		tools.get("subagent").execute("dead", { agent: "scout", task: "die" }, undefined, undefined, ctx),
		/exited before reporting a result/,
	);
});

test("sibling subagent calls run concurrently and auto-close independently", async () => {
	let active = 0;
	let maximum = 0;
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			active++;
			maximum = Math.max(maximum, active);
			setTimeout(async () => {
				await fake.complete(launch);
				active--;
			}, 150);
		},
	});
	const { tools, ctx } = harness(herdr);
	await Promise.all([
		tools.get("subagent").execute("one", { agent: "scout", task: "first" }, undefined, undefined, ctx),
		tools.get("subagent").execute("two", { agent: "scout", task: "second" }, undefined, undefined, ctx),
	]);
	assert.equal(maximum, 2);
	assert.deepEqual(herdr.closedTabs.sort(), ["w1:t1", "w2:t1"]);
});

test("async runs survive /reload: the next extension instance re-attaches and delivers once", async () => {
	let pending: (() => Promise<void>) | undefined;
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			pending = () => fake.complete(launch, { output: "after reload" });
		},
	});
	const sessionId = `reload-${Date.now()}`;
	const first = harness(herdr, { sessionId });
	await first.tools.get("subagent_async").execute("reload", { agent: "scout", task: "keep going" }, undefined, undefined, first.ctx);
	await first.handlers.get("session_shutdown")?.({ reason: "reload" }, first.ctx);
	assert.deepEqual(herdr.closedTabs, [], "reload must not close async children");

	const second = harness(herdr, { sessionId });
	await second.handlers.get("session_start")?.({ reason: "reload" }, second.ctx);
	await pending!();
	await waitFor(() => second.messages.length === 1);
	assert.match(second.messages[0]!.message.content, /after reload/);
	assert.equal(first.messages.length, 0);
	assert.deepEqual(herdr.closedTabs, ["w1:t1"]);
	await second.handlers.get("session_shutdown")?.({ reason: "quit" }, second.ctx);
});

test("reattachment does not close a reused Herdr pane hosting another agent", async () => {
	const herdr = createFakeHerdr({ onPrompt: () => undefined });
	const sessionId = `reuse-${Date.now()}`;
	const first = harness(herdr, { sessionId });
	await first.tools.get("subagent_async").execute("reuse", { agent: "scout", task: "keep going" }, undefined, undefined, first.ctx);
	await first.handlers.get("session_shutdown")?.({ reason: "reload" }, first.ctx);
	herdr.launches[0]!.name = "someone-else";

	const second = harness(herdr, { sessionId });
	await second.handlers.get("session_start")?.({ reason: "reload" }, second.ctx);
	await waitFor(() => second.messages.length === 1);
	assert.deepEqual(herdr.closedTabs, []);
	await second.handlers.get("session_shutdown")?.({ reason: "quit" }, second.ctx);
});

test("quitting cancels async children and closes their tabs", async () => {
	const herdr = createFakeHerdr({ onPrompt: () => undefined });
	const { tools, messages, ctx, handlers } = harness(herdr);
	await tools.get("subagent_async").execute("quit", { agent: "scout", task: "never finishes" }, undefined, undefined, ctx);
	await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	assert.deepEqual(herdr.closedTabs, ["w1:t1"]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(messages.length, 0);
});

async function gitRepo(): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "herdr-wt-repo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	await writeFile(join(repo, "README.md"), "hello\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return repo;
}

test("worktree profiles run on their own branch; clean checkouts are removed and the branch reported", async () => {
	const repo = await gitRepo();
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			setTimeout(async () => {
				await writeFile(join(launch.cwd, "feature.txt"), "feature\n");
				execFileSync("git", ["-C", launch.cwd, "add", "."]);
				execFileSync("git", ["-C", launch.cwd, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "add feature"]);
				await fake.complete(launch, { output: "implemented" });
			}, 30);
		},
	});
	const { tools, messages, ctx, handlers } = harness(herdr, { cwd: repo });
	try {
		const dispatched = await tools.get("subagent_async").execute("wt", { agent: "isolated", task: "add a feature" }, undefined, undefined, ctx);
		const created = herdr.worktrees[0]!;
		assert.match(created.branch, /^pi\/isolated-[0-9a-f]{8}$/);
		assert.match(dispatched.content[0].text, new RegExp(created.branch));
		const launch = herdr.launches.find((candidate) => candidate.env.PI_HERDR_SUBAGENT_CHILD === "1")!;
		assert.equal(launch.workspaceId, created.workspaceId, "child runs inside the worktree workspace");
		assert.equal(launch.cwd, created.path);
		assert.match(launch.prompt!, /Isolated checkout: .*dedicated Git worktree/);
		assert.ok(herdr.closedTabs.includes(`${created.workspaceId}:t1`), "worktree root tab replaced by the child tab");

		await waitFor(() => messages.length === 1);
		const content = messages[0]!.message.content as string;
		assert.match(content, /completed/);
		assert.match(content, new RegExp(`Worktree branch: ${created.branch}`));
		assert.match(content, /Commits \(1\):\n\s+[0-9a-f]+ add feature/);
		assert.match(content, /Checkout removed; branch kept/);
		assert.equal(existsSync(created.path), false);
		const branches = execFileSync("git", ["-C", repo, "branch", "--list", created.branch]).toString();
		assert.match(branches, new RegExp(created.branch.replace("/", "\\/")));
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		await rm(repo, { recursive: true, force: true });
	}
});

test("dirty worktrees are retained with their tab; no-commit clean worktrees drop their branch", async () => {
	const repo = await gitRepo();
	let mode: "dirty" | "noop" = "dirty";
	const herdr = createFakeHerdr({
		onPrompt: (launch, fake) => {
			setTimeout(async () => {
				if (mode === "dirty") await writeFile(join(launch.cwd, "wip.txt"), "uncommitted\n");
				await fake.complete(launch, { output: mode });
			}, 30);
		},
	});
	const { tools, messages, ctx, handlers } = harness(herdr, { cwd: repo });
	try {
		await tools.get("subagent_async").execute("dirty", { agent: "isolated", task: "leave mess" }, undefined, undefined, ctx);
		await waitFor(() => messages.length === 1);
		const dirty = herdr.worktrees[0]!;
		assert.match(messages[0]!.message.content, /Uncommitted changes; checkout and tab retained/);
		assert.match(messages[0]!.message.content, new RegExp(`Checkout: ${dirty.path}`));
		assert.equal(existsSync(dirty.path), true);
		assert.equal(herdr.closedTabs.includes(`${dirty.workspaceId}:t2`), false);

		mode = "noop";
		await tools.get("subagent_async").execute("noop", { agent: "isolated", task: "do nothing" }, undefined, undefined, ctx);
		await waitFor(() => messages.length === 2);
		const noop = herdr.worktrees[1]!;
		assert.match(messages[1]!.message.content, /No commits; checkout and branch removed/);
		assert.equal(existsSync(noop.path), false);
		assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", noop.branch]).toString().trim(), "");
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		await rm(repo, { recursive: true, force: true });
		await rm(herdr.worktrees[0]!.path, { recursive: true, force: true });
	}
});

test("worktree requests outside a Git repository run in place with a note", async () => {
	const plain = await mkdtemp(join(tmpdir(), "herdr-no-git-"));
	const herdr = createFakeHerdr();
	const { tools, ctx } = harness(herdr, { cwd: plain });
	try {
		const result = await tools.get("subagent").execute("plain", { agent: "scout-worktree", task: "look" }, undefined, undefined, ctx);
		assert.equal(herdr.worktrees.length, 0);
		assert.match(result.content[0].text, /not a Git repository; ran in place/);
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});

test("pruning removes only run directories older than the retention window", async () => {
	const root = await mkdtemp(join(tmpdir(), "herdr-prune-"));
	try {
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		for (const [session, run, stale] of [
			["s-old", "r1", true],
			["s-mixed", "r2", true],
			["s-mixed", "r3", false],
			["s-keep", "r4", true],
		] as const) {
			const dir = join(root, session, run);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "run.json"), "{}");
			if (stale) {
				await utimes(join(dir, "run.json"), old, old);
				await utimes(dir, old, old);
			}
		}
		const removed = await pruneRunDirs(14, { roots: [root], keepSessionId: "s-keep" });
		assert.equal(removed, 2);
		assert.deepEqual((await readdir(root)).sort(), ["s-keep", "s-mixed"]);
		assert.deepEqual(await readdir(join(root, "s-mixed")), ["r3"]);
		assert.equal(await pruneRunDirs(0, { roots: [root] }), 0, "0 disables pruning");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a shutdown retry preserves an already-settled successful result", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "herdr-subagent-reporter-"));
	const resultDir = join(sandbox, "missing-on-first-write");
	const resultPath = join(resultDir, "result.json");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const previous = {
		child: process.env.PI_HERDR_SUBAGENT_CHILD,
		result: process.env.PI_HERDR_SUBAGENT_RESULT,
		exit: process.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH,
	};
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
		for (const [key, value] of [
			["PI_HERDR_SUBAGENT_CHILD", previous.child],
			["PI_HERDR_SUBAGENT_RESULT", previous.result],
			["PI_HERDR_SUBAGENT_EXIT_ON_FINISH", previous.exit],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("auto uses Herdr only inside a Herdr pane, then tmux; explicit backends fail closed", async () => {
	const { configuredBackend, resolveBackend } = await import("../lib/subagent-backends.ts");
	const stub = (name: string, available: boolean) => ({
		name,
		preflight: async () => {
			if (!available) throw new Error(`${name} missing.`);
		},
	});
	const choose = (setting: any, env: Record<string, string>, herdr: boolean, tmux: boolean) =>
		resolveBackend({ herdr: stub("herdr", herdr), tmux: stub("tmux", tmux) } as any, setting, env).then((b) => b.name);
	const inHerdr = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };

	assert.equal(await choose("auto", inHerdr, true, true), "herdr");
	assert.equal(await choose("auto", {}, true, true), "tmux", "a reachable Herdr CLI alone does not select Herdr");
	assert.equal(await choose("auto", inHerdr, false, true), "tmux");
	await assert.rejects(choose("auto", {}, true, false), /No subagent backend is available.*Install tmux or run Pi inside Herdr/);
	await assert.rejects(choose("herdr", {}, false, true), /backend herdr is unavailable/, "no silent fallback to tmux");
	await assert.rejects(choose("tmux", inHerdr, true, false), /backend tmux is unavailable/);

	await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ backend: "tmux" }));
	try {
		assert.deepEqual(await configuredBackend({}), { setting: "tmux", source: "file" });
		assert.deepEqual(await configuredBackend({ PI_SUBAGENT_BACKEND: "herdr" }), { setting: "herdr", source: "env" });
		await assert.rejects(configuredBackend({ PI_SUBAGENT_BACKEND: "screen" }), /Invalid subagent backend/);
	} finally {
		await rm(join(agentDir, "subagents.json"));
	}
});
