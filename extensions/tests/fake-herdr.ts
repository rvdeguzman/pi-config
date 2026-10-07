import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FakeLaunch {
	workspaceId: string;
	tabId: string;
	paneId: string;
	cwd: string;
	env: Record<string, string>;
	name?: string;
	argv?: string[];
	prompt?: string;
	exited: boolean;
	status: "idle" | "working" | "blocked" | "done";
	keys: string[];
}

export interface FakeHerdrOptions {
	/** Called after a prompt is accepted. Default: complete successfully after a short delay. */
	onPrompt?: (launch: FakeLaunch, herdr: FakeHerdr) => void | Promise<void>;
	/** Called when keys are sent to an agent. */
	onKeys?: (launch: FakeLaunch, keys: string[], herdr: FakeHerdr) => void | Promise<void>;
	/** Return an error message to make `agent start` fail for this launch. */
	startError?: (launch: FakeLaunch) => string | undefined;
}

export interface FakeHerdr {
	exec: (command: string, args: string[], options?: unknown) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
	launches: FakeLaunch[];
	calls: string[][];
	closedTabs: string[];
	worktrees: Array<{ path: string; branch: string; workspaceId: string }>;
	complete(launch: FakeLaunch, result?: Record<string, unknown>, options?: { exit?: boolean }): Promise<void>;
}

const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false });
const fail = (code: string, message = code) => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ error: { code, message } }),
	killed: false,
});

function flagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) if (args[index] === flag) values.push(args[index + 1] ?? "");
	return values;
}

export function createFakeHerdr(options: FakeHerdrOptions = {}): FakeHerdr {
	let workspaces = 0;
	const tabsPerWorkspace = new Map<string, number>();
	const launches: FakeLaunch[] = [];
	const calls: string[][] = [];
	const closedTabs: string[] = [];
	const worktrees: FakeHerdr["worktrees"] = [];

	const newTab = (workspaceId: string, cwd: string, env: Record<string, string>): FakeLaunch => {
		const next = (tabsPerWorkspace.get(workspaceId) ?? 0) + 1;
		tabsPerWorkspace.set(workspaceId, next);
		const launch: FakeLaunch = {
			workspaceId,
			tabId: `${workspaceId}:t${next}`,
			paneId: `${workspaceId}:p${next}`,
			cwd,
			env,
			exited: false,
			status: "idle",
			keys: [],
		};
		launches.push(launch);
		return launch;
	};
	const byPane = (pane: string) => launches.find((launch) => launch.paneId === pane || launch.name === pane);
	const envFrom = (args: string[]) =>
		Object.fromEntries(flagValues(args, "--env").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

	const herdr: FakeHerdr = {
		launches,
		calls,
		closedTabs,
		worktrees,
		async complete(launch, result = {}, completeOptions = {}) {
			const resultPath = launch.env.PI_HERDR_SUBAGENT_RESULT;
			if (!resultPath) throw new Error("launch has no result path");
			await mkdir(dirname(resultPath), { recursive: true });
			await writeFile(
				resultPath,
				JSON.stringify({ version: 1, status: "completed", output: "done", finishedAt: Date.now(), ...result }),
			);
			launch.status = "done";
			if (completeOptions.exit ?? launch.env.PI_HERDR_SUBAGENT_EXIT_ON_FINISH === "1") launch.exited = true;
		},
		async exec(command, args) {
			if (command === "git") {
				try {
					const { stdout, stderr } = await execFileAsync("git", args);
					return { code: 0, stdout, stderr, killed: false };
				} catch (error: any) {
					return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), killed: false };
				}
			}
			calls.push(args);
			if (args[0] === "--version") return { code: 0, stdout: "herdr 0.9.3\n", stderr: "", killed: false };
			const [group, action] = args;
			if (group === "workspace" && action === "create") {
				const workspaceId = `w${++workspaces}`;
				const launch = newTab(workspaceId, flagValues(args, "--cwd")[0] ?? "", envFrom(args));
				return ok({
					workspace: { workspace_id: workspaceId },
					tab: { tab_id: launch.tabId },
					root_pane: { pane_id: launch.paneId },
				});
			}
			if (group === "tab" && action === "create") {
				const workspaceId = flagValues(args, "--workspace")[0] ?? "w0";
				const launch = newTab(workspaceId, flagValues(args, "--cwd")[0] ?? "", envFrom(args));
				return ok({ tab: { tab_id: launch.tabId }, root_pane: { pane_id: launch.paneId } });
			}
			if (group === "tab" && action === "close") {
				closedTabs.push(args[2] ?? "");
				const launch = launches.find((candidate) => candidate.tabId === args[2]);
				if (launch) launch.exited = true;
				return ok({ type: "ok" });
			}
			if (group === "worktree" && action === "create") {
				const repo = flagValues(args, "--cwd")[0]!;
				const branch = flagValues(args, "--branch")[0]!;
				const base = flagValues(args, "--base")[0];
				const path = `${repo}-wt-${branch.replace(/\//g, "-")}`;
				const gitArgs = base
					? ["-C", repo, "worktree", "add", "-b", branch, path, base]
					: ["-C", repo, "worktree", "add", path, branch];
				await execFileAsync("git", gitArgs);
				const workspaceId = `w${++workspaces}`;
				const root = newTab(workspaceId, path, {});
				worktrees.push({ path, branch, workspaceId });
				return ok({
					workspace: { workspace_id: workspaceId, worktree: { checkout_path: path } },
					tab: { tab_id: root.tabId },
					root_pane: { pane_id: root.paneId },
					worktree: { path, branch },
				});
			}
			if (group === "agent" && action === "start") {
				const pane = flagValues(args, "--pane")[0]!;
				const launch = byPane(pane);
				if (!launch) return fail("pane_not_found");
				launch.name = args[2];
				const separator = args.indexOf("--");
				launch.argv = separator >= 0 ? args.slice(separator + 1) : [];
				const error = options.startError?.(launch);
				if (error) {
					launch.exited = true;
					return fail("timeout", error);
				}
				return ok({ agent: { pane_id: pane, agent_status: "idle" } });
			}
			if (group === "agent" && action === "prompt") {
				const launch = byPane(args[2]!);
				if (!launch || launch.exited) return fail("agent_not_found");
				launch.prompt = args[3];
				launch.status = "working";
				const onPrompt =
					options.onPrompt ?? ((target: FakeLaunch) => void setTimeout(() => void herdr.complete(target), 50));
				await onPrompt(launch, herdr);
				return ok({ agent: { pane_id: launch.paneId, agent_status: "working" } });
			}
			if (group === "agent" && action === "get") {
				const launch = byPane(args[2]!);
				if (!launch || launch.exited || !launch.name) return fail("agent_not_found", `agent target ${args[2]} not found`);
				return ok({ agent: { pane_id: launch.paneId, agent_status: launch.status } });
			}
			if (group === "agent" && action === "send-keys") {
				const launch = byPane(args[2]!);
				if (!launch || launch.exited) return fail("agent_not_found");
				const keys = args.slice(3);
				launch.keys.push(...keys);
				await options.onKeys?.(launch, keys, herdr);
				return ok({ type: "ok" });
			}
			if (group === "pane" && action === "read") {
				const launch = byPane(args[2]!);
				return { code: launch ? 0 : 1, stdout: launch ? `pane ${launch.paneId}\n` : "", stderr: "", killed: false };
			}
			throw new Error(`unexpected herdr args: ${args.join(" ")}`);
		},
	};
	return herdr;
}
