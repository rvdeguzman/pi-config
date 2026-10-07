/**
 * Launch hosts for delegated child Pi processes. A backend creates a visible
 * target (Herdr tab or tmux window), starts Pi there, and later probes, reads,
 * and closes only that target. Everything else (profiles, model fallback,
 * result files, monitoring, run records, worktree release) lives in the
 * backend-neutral runner in ../subagent.ts.
 *
 * Every run persists its backend name and opaque handle; probes, fallback
 * attempts, reattachment, and cleanup always use the persisted backend.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BACKEND_NAMES = ["herdr", "tmux"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];
export type BackendSetting = "auto" | BackendName;
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
/** Opaque, JSON-serializable target identity; only its own backend interprets it. */
export type BackendHandle = Record<string, string>;
export type Probe = "alive" | "gone" | "unknown" | { status: AgentStatus; sessionFile?: string };

export const BACKEND_ENV = "PI_SUBAGENT_BACKEND";
/** Child mode reads its task from this private file instead of having it typed into the terminal. */
export const TASK_ENV = "PI_HERDR_SUBAGENT_TASK";
export const SETTINGS_FILE = "subagents.json";
/** tmux session that hosts children when the parent is not itself inside tmux. */
export const TMUX_SESSION = "pi-subagents";
const TMUX_RUN_OPTION = "@pi_subagent_run";
/** Marks the detached session this extension created. */
const TMUX_SESSION_OPTION = "@pi_subagents";

const START_TIMEOUT_MS = 45_000;
const PROMPT_TIMEOUT_MS = 20_000;
const CAPTURE_LINES = 200;

export interface LaunchRequest {
	runId: string;
	/** Unique per attempt; Herdr agent name and tmux window name. */
	agentName: string;
	label: string;
	cwd: string;
	/** Child-mode environment (result path, task path, exit-on-finish). */
	env: Record<string, string>;
	piArgs: string[];
	/** Herdr submits this text with `agent prompt`. */
	task: string;
	/** tmux children read the task from this file (TASK_ENV) and write `startedPath` once submitted. */
	taskPath: string;
	startedPath: string;
	/** Herdr worktree workspace to place the child in. */
	workspaceId?: string;
	/** Stops waiting for startup; the caller closes the created target. */
	signal?: AbortSignal;
}

export interface TargetCommands {
	target: string;
	attach: string;
	capture: string;
	close: string;
}

export interface CreatedCheckout {
	path: string;
	workspaceId?: string;
	/** A backend target created alongside the checkout, closed once the child target exists. */
	placeholder?: BackendHandle;
}

export interface SubagentBackend {
	readonly name: BackendName;
	/** Fails with an actionable message when this backend cannot launch here. */
	preflight(): Promise<void>;
	/**
	 * Create the target and start Pi with its task. `onCreated` runs as soon as
	 * the target exists, before startup completes, so the caller can persist and
	 * clean it up. Resolves once the task is submitted.
	 */
	launch(request: LaunchRequest, onCreated: (handle: BackendHandle) => Promise<void>): Promise<BackendHandle>;
	probe(handle: BackendHandle): Promise<Probe>;
	tail(handle: BackendHandle, lines: number): Promise<string | undefined>;
	/**
	 * Close the run's target. With `verify`, close only a target the backend can
	 * still prove belongs to the run (used for crash cleanup of stale handles).
	 */
	close(handle: BackendHandle, options?: { verify?: boolean }): Promise<"closed" | "already_gone">;
	commands(handle: BackendHandle): TargetCommands;
	/** Backend-managed checkout. Without it, the runner adds a plain Git worktree. */
	createCheckout?(options: { repoRoot: string; base: string; branch: string; label: string }): Promise<CreatedCheckout>;
}

/** Pi never became ready (bad model/provider, auth, crash): eligible for model fallback. */
export class ChildStartupError extends Error {}

export class HerdrError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

export function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_@%+:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function trimPane(output: string, maxLines = 18): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-maxLines).join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(record: unknown, key: string): unknown {
	return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
}

function pickString(record: unknown, key: string): string | undefined {
	const value = pick(record, key);
	return typeof value === "string" ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Herdr                                                                       */
/* -------------------------------------------------------------------------- */

interface HerdrEnvelope {
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

function parseEnvelope(raw: string): HerdrEnvelope | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as HerdrEnvelope;
	} catch {
		return undefined;
	}
}

/** Run a herdr CLI command that answers with a JSON envelope on stdout. */
async function herdrJson(
	pi: ExtensionAPI,
	args: string[],
	options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
	const run = await pi.exec("herdr", args, { timeout: options.timeout ?? 15_000, signal: options.signal });
	const envelope = parseEnvelope(run.stdout.trim()) ?? parseEnvelope(run.stderr.trim());
	if (envelope?.error) {
		throw new HerdrError(envelope.error.message || "herdr command failed", envelope.error.code);
	}
	if (run.code !== 0 || !envelope?.result) {
		const detail = run.stderr.trim() || run.stdout.trim() || `exit code ${run.code}`;
		throw new HerdrError(`herdr ${args.slice(0, 3).join(" ")} failed: ${detail}`);
	}
	return envelope.result;
}

/** Run a herdr CLI command whose success contract is exit 0, with no JSON output required. */
export async function herdrOk(pi: ExtensionAPI, args: string[], options: { timeout?: number } = {}): Promise<void> {
	const run = await pi.exec("herdr", args, { timeout: options.timeout ?? 15_000 });
	if (run.code === 0) return;
	for (const raw of [run.stderr.trim(), run.stdout.trim()]) {
		const envelope = parseEnvelope(raw);
		if (envelope?.error) {
			throw new HerdrError(envelope.error.message || "herdr command failed", envelope.error.code);
		}
	}
	const detail = run.stderr.trim() || run.stdout.trim() || `exit code ${run.code}`;
	throw new HerdrError(`herdr ${args.slice(0, 3).join(" ")} failed: ${detail}`);
}

/** `herdr pane read` answers with plain text, not JSON. */
async function herdrPaneRead(pi: ExtensionAPI, paneId: string, lines: number): Promise<string | undefined> {
	try {
		const run = await pi.exec(
			"herdr",
			["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
			{ timeout: 10_000 },
		);
		return run.code === 0 ? run.stdout : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Herdr launch protocol (Herdr >= 0.9):
 *
 *   tab create --env K=V --no-focus     a background tab whose shell carries the
 *                                       child-mode environment
 *   agent start <name> --kind pi -- …   Herdr launches Pi and returns only once it
 *                                       recognizes an interactive, ready agent
 *   agent prompt <pane> <task>          ordered paste + Enter; waits until Herdr
 *                                       observes the turn start
 */
export class HerdrBackend implements SubagentBackend {
	readonly name = "herdr" as const;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	async preflight(): Promise<void> {
		const ok = await this.pi
			.exec("herdr", ["--version"], { timeout: 5_000 })
			.then((run) => run.code === 0)
			.catch(() => false);
		if (!ok) throw new Error("The herdr CLI is not available.");
	}

	async createCheckout(options: { repoRoot: string; base: string; branch: string; label: string }): Promise<CreatedCheckout> {
		const result = await herdrJson(
			this.pi,
			[
				"worktree",
				"create",
				"--cwd",
				options.repoRoot,
				"--branch",
				options.branch,
				"--label",
				options.label,
				"--no-focus",
				"--base",
				options.base,
			],
			{ timeout: 60_000 },
		);
		const workspace = pick(result, "workspace");
		const checkout = pickString(pick(result, "worktree"), "path") ?? pickString(pick(workspace, "worktree"), "checkout_path");
		if (!checkout) throw new Error("herdr worktree create did not return a checkout path.");
		const workspaceId = pickString(workspace, "workspace_id");
		const rootTab = pickString(pick(result, "tab"), "tab_id");
		return {
			path: checkout,
			workspaceId,
			placeholder: rootTab ? { workspaceId: workspaceId ?? "", tabId: rootTab, paneId: "" } : undefined,
		};
	}

	async launch(request: LaunchRequest, onCreated: (handle: BackendHandle) => Promise<void>): Promise<BackendHandle> {
		const handle = { ...(await this.createTab(request)), agent: request.agentName };
		await onCreated(handle);
		await this.startChild(handle.paneId!, request);
		return handle;
	}

	/** Create a background tab whose shell carries the child environment. */
	private async createTab(request: LaunchRequest): Promise<BackendHandle> {
		const env = Object.entries(request.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
		const workspaceId = request.workspaceId ?? this.env.HERDR_WORKSPACE_ID;
		if (workspaceId) {
			const result = await herdrJson(this.pi, [
				"tab",
				"create",
				"--workspace",
				workspaceId,
				"--cwd",
				request.cwd,
				"--label",
				request.label,
				...env,
				"--no-focus",
			]);
			const paneId = pickString(pick(result, "root_pane"), "pane_id");
			const tabId = pickString(pick(result, "tab"), "tab_id");
			if (!paneId || !tabId) throw new Error("herdr tab create did not return a pane id.");
			return { workspaceId, tabId, paneId };
		}

		// Not running inside a herdr pane: park children in their own workspace.
		const result = await herdrJson(this.pi, [
			"workspace",
			"create",
			"--cwd",
			request.cwd,
			"--label",
			request.label,
			...env,
			"--no-focus",
		]);
		const paneId = pickString(pick(result, "root_pane"), "pane_id");
		const tabId = pickString(pick(result, "tab"), "tab_id");
		const createdWorkspaceId = pickString(pick(result, "workspace"), "workspace_id");
		if (!paneId || !tabId || !createdWorkspaceId) throw new Error("herdr workspace create did not return a pane id.");
		return { workspaceId: createdWorkspaceId, tabId, paneId };
	}

	/**
	 * Start Pi in a fresh pane and submit the task. Herdr's `agent start` verifies
	 * the agent is up before returning, so there is no type-into-shell race.
	 */
	private async startChild(paneId: string, request: LaunchRequest): Promise<void> {
		const pi = this.pi;
		const startAbort = new AbortController();
		let started = false;
		let exitedEarly = false;
		// Herdr only reports a failed start at its timeout. Watch the pane's
		// foreground process instead: once Pi has run and the shell is back in the
		// foreground, Pi exited during startup (bad model, auth, crash).
		const watchStartup = async (): Promise<void> => {
			let sawChild = false;
			let shellPolls = 0;
			for (;;) {
				await sleep(1_000);
				if (started || startAbort.signal.aborted) return;
				try {
					const info = pick(
						await herdrJson(pi, ["pane", "process-info", "--pane", paneId], { timeout: 5_000 }),
						"process_info",
					);
					const foreground = pick(info, "foreground_process_group_id");
					const shell = pick(info, "shell_pid");
					if (typeof foreground !== "number" || typeof shell !== "number") continue;
					if (foreground !== shell) {
						sawChild = true;
						shellPolls = 0;
						continue;
					}
					// A Pi that dies instantly may never be observed; consecutive
					// shell-foreground polls after launch mean the same thing.
					shellPolls++;
					if ((sawChild || shellPolls >= 3) && !started) {
						exitedEarly = true;
						startAbort.abort();
						return;
					}
				} catch {
					// Older Herdr or a transient error: rely on agent start's own timeout.
				}
			}
		};
		const watcher = watchStartup();
		try {
			await herdrJson(
				pi,
				[
					"agent",
					"start",
					request.agentName,
					"--kind",
					"pi",
					"--pane",
					paneId,
					"--timeout",
					String(START_TIMEOUT_MS),
					"--",
					...request.piArgs,
				],
				{ timeout: START_TIMEOUT_MS + 10_000, signal: request.signal ? AbortSignal.any([startAbort.signal, request.signal]) : startAbort.signal },
			);
			if (exitedEarly) throw new Error("Pi exited during startup.");
			started = true;
		} catch (error) {
			started = true;
			const pane = await herdrPaneRead(pi, paneId, 30);
			const message = exitedEarly ? "Pi exited during startup." : error instanceof Error ? error.message : String(error);
			throw new ChildStartupError(`Child Pi did not start: ${message}${pane ? `\n\n${trimPane(pane)}` : ""}`);
		} finally {
			startAbort.abort();
			void watcher;
		}
		await herdrJson(
			pi,
			[
				"agent",
				"prompt",
				paneId,
				request.task,
				"--wait",
				"--until",
				"working",
				"--until",
				"blocked",
				"--timeout",
				String(PROMPT_TIMEOUT_MS),
			],
			{ timeout: PROMPT_TIMEOUT_MS + 10_000 },
		);
	}

	async probe(handle: BackendHandle): Promise<Probe> {
		try {
			const result = await herdrJson(this.pi, ["agent", "get", handle.paneId ?? ""], { timeout: 10_000 });
			const agent = pick(result, "agent");
			// A recycled pane id hosting someone else's agent is not this run's child.
			const name = pickString(agent, "name");
			if (handle.agent && name && name !== handle.agent) return "gone";
			const status = (pickString(agent, "agent_status") ?? "unknown") as AgentStatus;
			const session = pick(agent, "agent_session");
			const sessionFile = pickString(session, "kind") === "path" ? pickString(session, "value") : undefined;
			return { status, sessionFile };
		} catch (error) {
			if (error instanceof HerdrError && (error.code === "agent_not_found" || error.code === "pane_not_found")) {
				return "gone";
			}
			return "unknown";
		}
	}

	tail(handle: BackendHandle, lines: number): Promise<string | undefined> {
		return herdrPaneRead(this.pi, handle.paneId ?? "", lines);
	}

	async close(handle: BackendHandle, options: { verify?: boolean } = {}): Promise<"closed" | "already_gone"> {
		if (!handle.tabId) return "already_gone";
		// Herdr can only prove ownership while the named agent still runs in the pane.
		if (options.verify) {
			if (!handle.agent) throw new Error("Herdr target ownership is unknown.");
			let pane: unknown;
			try {
				pane = pick(await herdrJson(this.pi, ["pane", "get", handle.paneId ?? ""], { timeout: 10_000 }), "pane");
			} catch (error) {
				if (error instanceof HerdrError && error.code === "pane_not_found") return "already_gone";
				throw error;
			}
			// Pane ids are not reused. A finished child leaves its shell; another agent in the pane is not ours.
			if (pickString(pane, "tab_id") !== handle.tabId) return "already_gone";
			if (pick(pane, "agent") && pickString(pane, "agent_name") !== handle.agent) return "already_gone";
		}
		try {
			await herdrOk(this.pi, ["tab", "close", handle.tabId], { timeout: 10_000 });
			return "closed";
		} catch (error) {
			if (error instanceof HerdrError && error.code === "tab_not_found") return "already_gone";
			throw error;
		}
	}

	commands(handle: BackendHandle): TargetCommands {
		return herdrCommands(handle);
	}
}

function herdrCommands(handle: BackendHandle): TargetCommands {
	return {
		target: `herdr pane ${handle.paneId}, tab ${handle.tabId}`,
		attach: handle.tabId ? `herdr tab focus ${handle.tabId}` : "",
		capture: handle.paneId ? `herdr pane read ${handle.paneId} --source recent-unwrapped --lines ${CAPTURE_LINES}` : "",
		close: handle.tabId ? `herdr tab close ${handle.tabId}` : "",
	};
}

/* -------------------------------------------------------------------------- */
/* tmux                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Drops every inherited HERDR_* variable (from the parent or the tmux server's
 * global environment) so Herdr integrations stay inactive, then execs Pi with
 * its argv untouched. The script is constant; no task text passes through a shell.
 */
export const TMUX_SCRUB_SCRIPT =
	"for v in $(env | sed -n 's/^\\(HERDR_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done; exec \"$@\"";

const TMUX_FORMAT = "#{socket_path}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}";

/**
 * tmux launch: a background window (in the parent's session when inside tmux,
 * otherwise in a detached `pi-subagents` session) runs Pi directly from argv.
 * The child reads its task from a private file and writes a started marker.
 * tmux cannot observe Pi's blocked state, so probes report liveness only.
 */
export class TmuxBackend implements SubagentBackend {
	readonly name = "tmux" as const;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	private async tmux(socket: string | undefined, args: string[], timeout = 10_000) {
		return this.pi.exec("tmux", socket ? ["-S", socket, ...args] : args, { timeout });
	}

	async preflight(): Promise<void> {
		const ok = await this.pi
			.exec("tmux", ["-V"], { timeout: 5_000 })
			.then((run) => run.code === 0)
			.catch(() => false);
		if (!ok) throw new Error("The tmux CLI is not available.");
	}

	async launch(request: LaunchRequest, onCreated: (handle: BackendHandle) => Promise<void>): Promise<BackendHandle> {
		const insidePane = this.env.TMUX && this.env.TMUX_PANE ? this.env.TMUX_PANE : undefined;
		const parentSocket = insidePane ? this.env.TMUX!.split(",")[0] || undefined : undefined;
		const options = [
			"-d",
			"-P",
			"-F",
			TMUX_FORMAT,
			"-n",
			request.agentName,
			"-c",
			request.cwd,
			...Object.entries({ ...request.env, [TASK_ENV]: request.taskPath }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		];
		const command = ["--", "sh", "-c", TMUX_SCRUB_SCRIPT, "pi-subagent", "pi", ...request.piArgs];

		let run;
		let sessionId: string | undefined;
		if (insidePane) {
			const session = await this.tmux(parentSocket, ["display-message", "-p", "-t", insidePane, "#{session_id}"]);
			sessionId = session.stdout.trim();
			if (session.code !== 0 || !sessionId) {
				throw new Error(`tmux could not resolve the current session: ${session.stderr.trim() || session.stdout.trim()}`);
			}
			run = await this.tmux(parentSocket, ["new-window", "-t", `${sessionId}:`, ...options, ...command]);
		} else {
			// Find our detached session by tag, not name: tmux hooks may rename sessions.
			const sessions = await this.tmux(undefined, ["list-sessions", "-F", `#{session_id}\t#{${TMUX_SESSION_OPTION}}`]);
			sessionId =
				sessions.code === 0
					? sessions.stdout
							.split("\n")
							.find((line) => line.endsWith("\t1"))
							?.split("\t")[0]
					: undefined;
			run = sessionId
				? await this.tmux(undefined, ["new-window", "-t", `${sessionId}:`, ...options, ...command])
				: await this.tmux(undefined, ["new-session", "-s", TMUX_SESSION, ...options, ...command]);
			if (!sessionId && run.code !== 0 && /duplicate session/i.test(run.stderr)) {
				run = await this.tmux(undefined, ["new-window", "-t", `=${TMUX_SESSION}:`, ...options, ...command]);
			}
		}
		const [socket, createdIn, session, window, pane] = run.stdout.trim().split("\t");
		if (run.code !== 0 || !socket || !createdIn || !window || !pane) {
			throw new Error(`tmux could not create the child window: ${run.stderr.trim() || run.stdout.trim() || `exit ${run.code}`}`);
		}
		if (!insidePane) await this.tmux(socket, ["set-option", "-t", createdIn, TMUX_SESSION_OPTION, "1"]);
		const handle: BackendHandle = {
			socket,
			session: session ?? "",
			window,
			pane,
			run: request.runId,
			inside: insidePane ? "1" : "0",
		};
		// Keep a dead pane's output for startup diagnostics, and tag the window so
		// later probes and closes never touch a window this run did not create.
		await this.tmux(socket, ["set-option", "-w", "-t", window, "remain-on-exit", "on"]);
		const tagged = await this.tmux(socket, ["set-option", "-w", "-t", window, TMUX_RUN_OPTION, request.runId]);
		await onCreated(handle);
		if (tagged.code !== 0) {
			throw new ChildStartupError(`Child Pi did not start: tmux window ${window} vanished during launch.`);
		}

		const deadline = Date.now() + START_TIMEOUT_MS;
		for (;;) {
			request.signal?.throwIfAborted();
			if (existsSync(request.startedPath)) return handle;
			if ((await this.probe(handle)) === "gone") {
				const pane = await this.tail(handle, 30);
				throw new ChildStartupError(`Child Pi did not start: Pi exited during startup.${pane ? `\n\n${trimPane(pane)}` : ""}`);
			}
			if (Date.now() >= deadline) {
				throw new ChildStartupError(`Child Pi did not start within ${START_TIMEOUT_MS / 1000}s.`);
			}
			await sleep(250);
		}
	}

	/** The pane's state, but only when it still belongs to this run. */
	private async owned(handle: BackendHandle): Promise<"alive" | "dead" | "gone" | "unknown"> {
		let run;
		try {
			run = await this.tmux(handle.socket, [
				"display-message",
				"-p",
				"-t",
				handle.pane ?? "",
				`#{pane_id}\t#{pane_dead}\t#{${TMUX_RUN_OPTION}}`,
			]);
		} catch {
			return "unknown";
		}
		if (run.code !== 0) {
			return /no server running|can't find|error connecting|no such file/i.test(run.stderr) ? "gone" : "unknown";
		}
		// tmux answers an unknown pane target with empty output and exit 0.
		const [pane, dead, owner] = run.stdout.replace(/\n$/, "").split("\t");
		if (pane !== handle.pane || owner !== handle.run) return "gone";
		return dead === "1" ? "dead" : "alive";
	}

	async probe(handle: BackendHandle): Promise<Probe> {
		const state = await this.owned(handle);
		return state === "dead" ? "gone" : state;
	}

	async tail(handle: BackendHandle, lines: number): Promise<string | undefined> {
		try {
			const run = await this.tmux(handle.socket, ["capture-pane", "-p", "-t", handle.pane ?? "", "-S", `-${lines}`]);
			return run.code === 0 ? run.stdout : undefined;
		} catch {
			return undefined;
		}
	}

	/** Always verified: only a window tagged with this run id is ever killed. */
	async close(handle: BackendHandle): Promise<"closed" | "already_gone"> {
		const state = await this.owned(handle);
		if (state === "gone") return "already_gone";
		if (state === "unknown") throw new Error(`tmux could not inspect window ${handle.window}.`);
		const run = await this.tmux(handle.socket, ["kill-window", "-t", handle.window ?? ""]);
		if (run.code === 0) return "closed";
		if (/can't find|no server running/i.test(run.stderr)) return "already_gone";
		throw new Error(`tmux kill-window failed: ${run.stderr.trim() || `exit ${run.code}`}`);
	}

	commands(handle: BackendHandle): TargetCommands {
		return tmuxCommands(handle);
	}
}

function tmuxCommands(handle: BackendHandle): TargetCommands {
	const tmux = `tmux -S ${shellQuote(handle.socket ?? "")}`;
	return {
		target: `tmux window ${handle.window} (pane ${handle.pane})`,
		// Window ids survive session renames; attach-session resolves a window id to its session.
		attach:
			handle.inside === "1"
				? `${tmux} select-window -t ${handle.window}`
				: `${tmux} attach-session -t ${handle.window} \\; select-window -t ${handle.window}`,
		capture: `${tmux} capture-pane -p -t ${handle.pane} -S -${CAPTURE_LINES}`,
		close: `${tmux} kill-window -t ${handle.window}`,
	};
}

/** Attach/capture/close commands for a persisted handle, without touching the backend. */
export function commandsFor(backend: BackendName, handle: BackendHandle): TargetCommands {
	return backend === "tmux" ? tmuxCommands(handle) : herdrCommands(handle);
}

/* -------------------------------------------------------------------------- */
/* selection                                                                   */
/* -------------------------------------------------------------------------- */

export function settingsPath(): string {
	return path.join(getAgentDir(), SETTINGS_FILE);
}

function parseSetting(value: unknown, source: string): BackendSetting {
	if (value === "auto" || value === "herdr" || value === "tmux") return value;
	throw new Error(`Invalid subagent backend ${JSON.stringify(value)} in ${source}; use auto, herdr, or tmux.`);
}

/** The configured backend: PI_SUBAGENT_BACKEND, then subagents.json, then auto. */
export async function configuredBackend(
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ setting: BackendSetting; source: "env" | "file" | "default" }> {
	const fromEnv = env[BACKEND_ENV]?.trim();
	if (fromEnv) return { setting: parseSetting(fromEnv, BACKEND_ENV), source: "env" };
	let raw: string;
	try {
		raw = await readFile(settingsPath(), "utf8");
	} catch {
		return { setting: "auto", source: "default" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${settingsPath()} is not valid JSON.`);
	}
	const value = pick(parsed, "backend");
	return value === undefined ? { setting: "auto", source: "default" } : { setting: parseSetting(value, settingsPath()), source: "file" };
}

/**
 * Resolve the backend for one new run, before any launch side effect. Explicit
 * choices fail closed; auto prefers Herdr inside a Herdr pane, then tmux.
 */
export async function resolveBackend(
	backends: Record<BackendName, SubagentBackend>,
	setting: BackendSetting,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SubagentBackend> {
	if (setting !== "auto") {
		const backend = backends[setting];
		try {
			await backend.preflight();
		} catch (error) {
			throw new Error(
				`Subagent backend ${setting} is unavailable: ${error instanceof Error ? error.message : String(error)} Choose another with /subagent-backend or ${BACKEND_ENV}.`,
			);
		}
		return backend;
	}
	const reasons: string[] = [];
	if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
		try {
			await backends.herdr.preflight();
			return backends.herdr;
		} catch (error) {
			reasons.push(error instanceof Error ? error.message : String(error));
		}
	} else {
		reasons.push("Pi is not running in a Herdr pane.");
	}
	try {
		await backends.tmux.preflight();
		return backends.tmux;
	} catch (error) {
		reasons.push(error instanceof Error ? error.message : String(error));
	}
	throw new Error(
		`No subagent backend is available: ${reasons.join(" ")} Install tmux or run Pi inside Herdr, or choose a backend with /subagent-backend.`,
	);
}
