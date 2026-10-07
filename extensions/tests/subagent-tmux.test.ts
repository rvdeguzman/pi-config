// Real tmux on an isolated socket (TMUX_TMPDIR) with a stub `pi` on PATH: the
// stub records what a child would see, then reports a result like child mode.
// No model requests; skipped when tmux is not installed.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";

const hasTmux = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

for (const key of Object.keys(process.env)) {
	if (/^(HERDR_|TMUX|PI_HERDR_SUBAGENT_|PI_SUBAGENT_)/.test(key)) delete process.env[key];
}
// Short path: tmux socket paths are length-limited.
const root = await mkdtemp("/tmp/pi-tmux-test-");
const agentDir = join(root, "agent");
const bin = join(root, "bin");
const gate = join(root, "gate");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMUX_TMPDIR = root;
process.env.STUB_GATE = gate;
process.env.PATH = `${bin}:${process.env.PATH}`;
// Inherited by the tmux server's global environment; children must not see these.
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "parent-pane";
process.env.HERDR_SOCKET_PATH = join(root, "no-herdr.sock");

await mkdir(join(agentDir, "agents"), { recursive: true });
await writeFile(join(agentDir, "agents", "scout.md"), "---\nname: scout\nthinking: low\ntools: [read]\n---\n");
await writeFile(join(agentDir, "agents", "isolated.md"), "---\nname: isolated\nthinking: low\ntools: [read]\nworktree: true\n---\n");
await mkdir(bin);
await mkdir(gate);
await writeFile(
	join(bin, "pi"),
	`#!/bin/sh
out="$(dirname "$PI_HERDR_SUBAGENT_RESULT")"
env > "$out/stub-env.txt"
printf '%s\\n' "$@" > "$out/stub-argv.txt"
cp "$PI_HERDR_SUBAGENT_TASK" "$out/stub-task.txt"
: > "$PI_HERDR_SUBAGENT_RESULT.started"
while [ ! -e "$STUB_GATE/go" ]; do sleep 0.05; done
case "$(cat "$STUB_GATE/mode" 2>/dev/null)" in
  commit) echo feature > feature.txt && git add . && git -c user.email=t@e -c user.name=T commit -qm "add feature" ;;
  dirty) echo wip > wip.txt ;;
esac
printf '{"version":1,"status":"completed","output":"stub done","finishedAt":1}' > "$PI_HERDR_SUBAGENT_RESULT.tmp"
mv "$PI_HERDR_SUBAGENT_RESULT.tmp" "$PI_HERDR_SUBAGENT_RESULT"
[ "$PI_HERDR_SUBAGENT_EXIT_ON_FINISH" = 1 ] || sleep 600
`,
);
await chmod(join(bin, "pi"), 0o755);
// Start the isolated server without the user's tmux.conf (hooks there may rename sessions).
if (hasTmux) execFileSync("tmux", ["-f", "/dev/null", "new-session", "-d", "-s", "holder", "sleep", "600"]);

after(async () => {
	try {
		if (hasTmux) execFileSync("tmux", ["kill-server"], { stdio: "ignore" });
	} catch {
		// No server left.
	}
	await rm(root, { recursive: true, force: true });
});

const { default: extensionImpl } = await import("../subagent.ts");

function tmux(...args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}

function windows(session: string): string[] {
	return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_name}").split("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function harness(sessionId: string, cwd = process.cwd()) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: any[] = [];
	const herdrCalls: string[][] = [];
	extensionImpl({
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		getThinkingLevel: () => "high",
		getAllTools: () => [{ name: "read" }],
		getActiveTools: () => ["read"],
		sendMessage: (message: any) => messages.push(message),
		exec: (command: string, args: string[]) => {
			if (command === "herdr") {
				herdrCalls.push(args);
				return Promise.resolve({ code: 1, stdout: "", stderr: "herdr must not be used", killed: false });
			}
			return new Promise((resolve) =>
				execFile(command, args, { encoding: "utf8" }, (error: any, stdout, stderr) =>
					resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, killed: false }),
				),
			);
		},
	} as any);
	const notes: string[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		model: { provider: "openai-codex", id: "gpt-test" },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => sessionId },
		ui: { addAutocompleteProvider: () => undefined, setWidget: () => undefined, notify: (text: string) => notes.push(text) },
	};
	return { tools, commands, handlers, messages, herdrCalls, notes, ctx };
}

async function runDir(sessionId: string): Promise<string> {
	const { readdir } = await import("node:fs/promises");
	const [run] = await readdir(join(agentDir, "herdr-subagents", sessionId));
	return join(agentDir, "herdr-subagents", sessionId, run!);
}

test("tmux blocking run: window in the parent's session, task via file, HERDR_* scrubbed, only its window closed", { skip: !hasTmux }, async () => {
	await writeFile(join(gate, "go"), "");
	tmux("new-session", "-d", "-s", "parent", "-n", "user-shell", "sleep", "600");
	const socket = tmux("display-message", "-p", "-t", "=parent:", "#{socket_path}");
	process.env.TMUX = `${socket},1,0`;
	process.env.TMUX_PANE = tmux("list-panes", "-s", "-t", "=parent", "-F", "#{pane_id}");
	process.env.PI_SUBAGENT_BACKEND = "tmux";
	try {
		const { tools, ctx, herdrCalls } = harness("blocking");
		const task = `It's "quoted" $(touch ${join(root, "pwned")}) \`id\`\nsecond line`;
		const result = await tools.get("subagent").execute("t1", { agent: "scout", task }, undefined, undefined, ctx);

		assert.equal(result.details.backend, "tmux");
		assert.match(result.content[0].text, /tmux window @\d+ \(pane %\d+\) \(auto-closed\)/);
		assert.match(result.content[0].text, /stub done/);
		const dir = await runDir("blocking");
		const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
		assert.equal(record.handle.session, "parent", "inside tmux, children open in the parent's session");
		assert.equal(await readFile(join(dir, "stub-task.txt"), "utf8"), `${task}\n`);
		const argv = (await readFile(join(dir, "stub-argv.txt"), "utf8")).split("\n");
		assert.deepEqual(argv.slice(0, 4), ["--provider", "openai-codex", "--model", "gpt-test"]);
		assert.ok(!argv.some((arg) => arg.includes("quoted")), "task text never travels in argv");
		assert.equal(existsSync(join(root, "pwned")), false);
		const env = await readFile(join(dir, "stub-env.txt"), "utf8");
		assert.doesNotMatch(env, /^HERDR_/m);
		assert.match(env, /^PI_HERDR_SUBAGENT_CHILD=1$/m);
		assert.deepEqual(windows("parent"), ["user-shell"], "the child window closed; the user's window survived");
		assert.throws(() => execFileSync("tmux", ["has-session", "-t", "=pi-subagents"], { stdio: "ignore" }), "no detached session inside tmux");
	} finally {
		delete process.env.TMUX;
		delete process.env.TMUX_PANE;
		delete process.env.PI_SUBAGENT_BACKEND;
	}
});

test("tmux async run keeps its backend across a setting change and /reload, and delivers one result", { skip: !hasTmux }, async () => {
	await rm(join(gate, "go"), { force: true });
	tmux("new-session", "-d", "-s", "pi-subagents", "-n", "keep", "sleep", "600");
	const first = harness("async");
	await first.commands.get("subagent-backend").handler("tmux", first.ctx);
	const dispatched = await first.tools
		.get("subagent_async")
		.execute("a1", { agent: "scout", task: "background work" }, undefined, undefined, first.ctx);
	assert.equal(dispatched.details.backend, "tmux");
	assert.match(dispatched.details.attachCommand, /^tmux -S \S+ attach-session -t (@\d+) \\; select-window -t \1$/);
	assert.equal(windows("pi-subagents").length, 2, "reuses the existing pi-subagents session");

	await first.handlers.get("session_shutdown")?.({ reason: "reload" }, first.ctx);
	assert.equal(windows("pi-subagents").length, 2, "reload keeps the async child running");
	const second = harness("async");
	await second.commands.get("subagent-backend").handler("herdr", second.ctx);
	await second.handlers.get("session_start")?.({ reason: "reload" }, second.ctx);

	await writeFile(join(gate, "go"), "");
	await waitFor(() => second.messages.length === 1);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(second.messages.length, 1);
	assert.equal(first.messages.length, 0);
	assert.match(second.messages[0].content, /Async subagent "scout" completed[\s\S]*stub done/);
	assert.deepEqual([...first.herdrCalls, ...second.herdrCalls], [], "monitoring and cleanup stayed on tmux");
	assert.deepEqual(windows("pi-subagents"), ["keep"]);
	await second.handlers.get("session_shutdown")?.({ reason: "quit" }, second.ctx);
	await rm(join(agentDir, "subagents.json"));
});

test("tmux worktrees: committed branches are kept, dirty checkouts retained, clean no-op runs removed", { skip: !hasTmux }, async () => {
	await writeFile(join(gate, "go"), "");
	process.env.PI_SUBAGENT_BACKEND = "tmux";
	const repo = join(root, "repo");
	await mkdir(join(repo, "sub"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	await writeFile(join(repo, "sub", "README.md"), "hello\n");
	git("add", ".");
	git("-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "init");
	const { tools, ctx } = harness("worktrees", join(repo, "sub"));
	const run = async (mode: string) => {
		await writeFile(join(gate, "mode"), mode);
		const result = await tools.get("subagent").execute(mode, { agent: "isolated", task: mode }, undefined, undefined, ctx);
		return result.details.worktree as { path: string; branch: string };
	};
	try {
		const committed = await run("commit");
		assert.ok(committed.path.startsWith(join(agentDir, "subagent-worktrees")), committed.path);
		assert.equal(existsSync(committed.path), false, "clean checkout removed");
		assert.match(git("log", "--format=%s", committed.branch), /^add feature/, "branch with commits kept");

		const dirty = await run("dirty");
		assert.equal(existsSync(join(dirty.path, "sub", "wip.txt")), true, "dirty checkout retained, child ran in the subdirectory");

		const noop = await run("noop");
		assert.equal(existsSync(noop.path), false);
		assert.equal(git("branch", "--list", noop.branch), "", "no-commit branch removed");
	} finally {
		delete process.env.PI_SUBAGENT_BACKEND;
		await rm(join(gate, "mode"), { force: true });
	}
});
