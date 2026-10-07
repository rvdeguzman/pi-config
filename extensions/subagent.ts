/**
 * subagent: run blocking or asynchronous delegated tasks in child Pi processes
 * that stay visible in a Herdr tab or tmux window.
 *
 * One backend-neutral runner owns profiles, tool allowlists, model fallback,
 * task and result files, monitoring, async delivery, run records, pruning, and
 * worktree release. A small backend (./lib/subagent-backends.ts) creates,
 * probes, reads, and closes the launch target. Each run resolves its backend
 * once (`/subagent-backend`, PI_SUBAGENT_BACKEND, default auto) and persists
 * it with an opaque handle; fallback attempts, reattachment, and cleanup reuse
 * that persisted backend.
 *
 * Since Pi renders on the alternate screen, pane reads cannot recover scrolled
 * off output. Reported children therefore load this same file in "child mode"
 * and write their final answer to an atomic result file. The parent watches that
 * file (fs.watch plus a slow fallback stat) and probes the backend only every
 * couple of seconds for liveness (and, on Herdr, blocked state). The result
 * file, not pane text, is the source of truth.
 *
 * Every run persists a run.json record as soon as it owns a worktree or a
 * launch target. Async runs survive /reload (monitors re-attach on
 * session_start), and old run directories are pruned automatically.
 */

import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { createAgentRefAutocomplete } from "./lib/agent-ref-autocomplete.ts";
import {
	BACKEND_ENV,
	commandsFor,
	configuredBackend,
	HerdrBackend,
	resolveBackend,
	settingsPath,
	shellQuote,
	TASK_ENV,
	TmuxBackend,
	trimPane,
	type AgentStatus,
	type BackendHandle,
	type BackendName,
	type BackendSetting,
	type SubagentBackend,
} from "./lib/subagent-backends.ts";
import { subagentProfiles, type AgentProfile } from "./lib/subagent-profiles.ts";

const CHILD_ENV = "PI_HERDR_SUBAGENT_CHILD";
const RESULT_ENV = "PI_HERDR_SUBAGENT_RESULT";
/**
 * Set to 0 to retain completed blocking subagent targets for inspection.
 * Blocking subagents otherwise shut down and their tab/window auto-closes as
 * soon as the parent has collected the result.
 */
const EXIT_ON_FINISH_ENV = "PI_HERDR_SUBAGENT_EXIT_ON_FINISH";
/** Days to keep finished run directories (sessions, task, result). 0 disables pruning. */
const RETENTION_ENV = "PI_HERDR_SUBAGENT_RETENTION_DAYS";
const DEFAULT_RETENTION_DAYS = 14;
const RUNS_DIR = "herdr-subagents";
/** Plain Git worktrees for backends without managed checkouts (tmux). Never pruned automatically. */
const WORKTREES_DIR = "subagent-worktrees";
const WORKER_PROFILE = "worker";
const BLOCKING_TOOL = "subagent";
const ASYNC_TOOL = "subagent_async";
const ASYNC_RESULT_TYPE = "subagent-async-result";
const ASYNC_WIDGET_ID = "subagent-async";
const DELEGATION_TOOL_NAMES = new Set([BLOCKING_TOOL, ASYNC_TOOL]);
/** Fallback result-file check; fs.watch normally wakes the monitor first. */
const RESULT_CHECK_MS = 1_000;
/** Backend liveness / blocked-state probe interval. */
const PROBE_INTERVAL_MS = 2_000;
/** Interactive Pi subscribes its renderer after session_start handlers; submit the task file after that. */
const TASK_SUBMIT_DELAY_MS = 250;
const PANE_READ_LINES = 60;
const EXIT_GRACE_MS = 1_500;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

const DelegatedTaskParams = Type.Object({
	agent: Type.String({ description: "Named profile from ~/.pi/agent/agents/*.md" }),
	task: Type.String({ description: "The complete task for the child Pi process" }),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
});

type RunKind = "blocking" | "async";
type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface ChildResult {
	version: 1;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
	failureKind?: "provider" | "tool" | "task" | "abort";
	providerStatus?: number;
}

export interface WorktreeInfo {
	repoRoot: string;
	path: string;
	branch: string;
	base: string;
	/** Herdr-managed worktree workspace. */
	workspaceId?: string;
	/** Checkout state after the run: removed (branch kept), retained, or still in use. */
	state?: "active" | "removed" | "retained";
	commits?: string[];
	diffStat?: string;
	dirty?: boolean;
	note?: string;
}

interface RunDetails {
	status: RunStatus;
	task: string;
	cwd: string;
	backend: BackendName;
	/** Human-readable launch target, e.g. "herdr pane w1:p1, tab w1:t1". */
	target: string;
	agentName: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	runId?: string;
	profile?: string;
	agentStatus?: AgentStatus;
	pane?: string;
	output?: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
	autoClosed?: boolean;
	worktree?: WorktreeInfo;
}

/** Persisted under <run dir>/run.json. */
export interface RunRecord {
	version: 1;
	id: string;
	kind: RunKind;
	profile: string;
	parentSessionId: string;
	task: string;
	sourceCwd: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	tools: string[];
	agentName: string;
	/** Launch host, fixed for the run's lifetime. Legacy records without it are Herdr records. */
	backend?: BackendName;
	/** The current attempt's target; only `backend` interprets it. */
	handle?: BackendHandle;
	/** Legacy Herdr coordinates (pre-backend records). */
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
	resultPath?: string;
	sessionFile?: string;
	worktree?: WorktreeInfo;
	/** "queued" with a handle means launch was interrupted; the next session start cleans it up. */
	status: RunStatus;
	/** Saved before the async result is steered: delivery is at most once. */
	delivered?: boolean;
	startedAt: number;
	finishedAt?: number;
}

interface LiveRun {
	record: RunRecord;
	details: RunDetails;
	controller: AbortController;
	/** The first attempt is running with its task submitted. */
	launched: boolean;
	/** Superseded targets (worktree placeholder, failed attempts) closed once a replacement exists. */
	pending: BackendHandle[];
	/** Set when monitoring stops for /reload; the child keeps running. */
	detached?: boolean;
}

function shortId(id: string): string {
	return id.replace(/-/g, "").slice(0, 8);
}

function backendNameOf(record: RunRecord): BackendName {
	return record.backend ?? "herdr";
}

function handleOf(record: RunRecord): BackendHandle | undefined {
	if (record.handle) return record.handle;
	if (!record.tabId && !record.paneId) return undefined;
	return {
		workspaceId: record.workspaceId ?? "",
		tabId: record.tabId ?? "",
		paneId: record.paneId ?? "",
		agent: record.agentName ?? "",
	};
}

class NonRetryableSubagentError extends Error {}

/* -------------------------------------------------------------------------- */
/* git / worktrees                                                             */
/* -------------------------------------------------------------------------- */

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
	try {
		const run = await pi.exec("git", ["-C", cwd, ...args], { timeout: 20_000 });
		return { ok: run.code === 0, out: run.stdout.trim(), err: run.stderr.trim() };
	} catch (error) {
		return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) };
	}
}

function branchFor(profile: string, runId: string): string {
	const slug = profile.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "agent";
	return `pi/${slug}-${shortId(runId)}`;
}

/**
 * Create an isolated checkout for one run on a fresh branch from committed
 * HEAD. Herdr manages its own worktree workspace; other backends get a plain
 * `git worktree add` under the agent directory. Returns undefined when the
 * working directory is not inside a Git repository.
 */
async function createWorktree(
	pi: ExtensionAPI,
	backend: SubagentBackend,
	sourceCwd: string,
	branch: string,
	label: string,
): Promise<{ info: WorktreeInfo; cwd: string; placeholder?: BackendHandle } | undefined> {
	const top = await git(pi, sourceCwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.out) return undefined;
	const repoRoot = top.out;
	const head = await git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);
	if (!head.ok) {
		throw new Error(`Worktree isolation needs a Git repository with at least one commit: ${repoRoot}`);
	}
	const base = head.out;

	let checkout: string;
	let workspaceId: string | undefined;
	let placeholder: BackendHandle | undefined;
	if (backend.createCheckout) {
		({ path: checkout, workspaceId, placeholder } = await backend.createCheckout({ repoRoot, base, branch, label }));
	} else {
		const repoSlug = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
		checkout = path.join(getAgentDir(), WORKTREES_DIR, `${repoSlug}-${branch.replace(/\//g, "-")}`);
		await mkdir(path.dirname(checkout), { recursive: true, mode: 0o700 });
		const added = await git(pi, repoRoot, ["worktree", "add", "-b", branch, checkout, base]);
		if (!added.ok) throw new Error(`git worktree add failed: ${added.err || "unknown error"}`);
	}
	// --show-prefix survives symlinked paths (macOS /tmp) where path.relative would not.
	const prefix = await git(pi, sourceCwd, ["rev-parse", "--show-prefix"]);
	const cwd = prefix.ok && prefix.out ? path.join(checkout, prefix.out) : checkout;
	return {
		info: { repoRoot, path: checkout, branch, base, workspaceId, state: "active" },
		cwd: existsSync(cwd) ? cwd : checkout,
		placeholder,
	};
}

/** Inspect a finished worktree: commits since base, diffstat, and uncommitted changes. */
async function inspectWorktree(pi: ExtensionAPI, info: WorktreeInfo): Promise<WorktreeInfo> {
	const status = await git(pi, info.path, ["status", "--porcelain"]);
	const log = await git(pi, info.path, ["log", "--format=%h %s", `${info.base}..HEAD`]);
	const diff = await git(pi, info.path, ["diff", "--shortstat", `${info.base}..HEAD`]);
	return {
		...info,
		dirty: status.ok ? status.out.length > 0 : true,
		commits: log.ok && log.out ? log.out.split("\n") : [],
		diffStat: diff.ok ? diff.out || undefined : undefined,
	};
}

/**
 * Remove a clean checkout, keeping its branch when it has commits. A dirty
 * checkout (or one that cannot be inspected) is always retained. Never forced.
 */
async function releaseWorktree(pi: ExtensionAPI, info: WorktreeInfo): Promise<WorktreeInfo> {
	if (info.state === "removed" || !existsSync(info.path)) return info;
	const inspected = await inspectWorktree(pi, info);
	if (inspected.dirty) {
		return { ...inspected, state: "retained", note: "Uncommitted changes; checkout retained for inspection." };
	}
	const removed = await git(pi, inspected.repoRoot, ["worktree", "remove", inspected.path]);
	if (!removed.ok) {
		return { ...inspected, state: "retained", note: `Checkout retained: ${removed.err || "git worktree remove failed"}` };
	}
	if ((inspected.commits?.length ?? 0) === 0) {
		await git(pi, inspected.repoRoot, ["branch", "-D", inspected.branch]);
		return { ...inspected, state: "removed", note: "No commits; checkout and branch removed." };
	}
	return { ...inspected, state: "removed", note: "Checkout removed; branch kept for integration." };
}

function worktreeNote(info: WorktreeInfo): string {
	return [
		"",
		"---",
		`Isolated checkout: you are working in a dedicated Git worktree at ${info.path} on branch ${info.branch}, created from commit ${info.base.slice(0, 12)} of ${info.repoRoot}.`,
		"The parent's uncommitted changes are not present here. Commit your finished changes on this branch before your final answer.",
		"Do not merge, rebase, push, or switch branches; the parent integrates the branch. Report the commit(s) you made.",
	].join("\n");
}

function worktreeText(info: WorktreeInfo): string[] {
	const lines = [`Worktree branch: ${info.branch} (base ${info.base.slice(0, 12)}, repo ${info.repoRoot})`];
	const commits = info.commits ?? [];
	if (commits.length > 0) {
		lines.push(`Commits (${commits.length}):`, ...commits.slice(0, 20).map((line) => `  ${line}`));
		if (commits.length > 20) lines.push(`  … ${commits.length - 20} more`);
	} else if (info.commits) {
		lines.push("Commits: none");
	}
	if (info.diffStat) lines.push(`Diff: ${info.diffStat}`);
	if (info.state === "retained" || info.state === "active") lines.push(`Checkout: ${info.path}`);
	if (info.note) lines.push(info.note);
	if (commits.length > 0) {
		lines.push(`Integrate after review, e.g.: git -C ${shellQuote(info.repoRoot)} merge --no-ff ${info.branch}`);
	}
	return lines;
}

/* -------------------------------------------------------------------------- */
/* child mode                                                                  */
/* -------------------------------------------------------------------------- */

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;
	let pendingResult: ChildResult | undefined;
	let reporting: Promise<void> | undefined;
	let providerStatus: number | undefined;
	let toolFailed = false;

	pi.on("after_provider_response", (event) => {
		providerStatus = event.status;
	});
	pi.on("tool_execution_end", (event) => {
		if (event.isError) toolFailed = true;
	});

	const report = (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return Promise.resolve();
		if (reporting) return reporting;

		if (!pendingResult) {
			const assistant = findLastAssistant(ctx);
			const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
			const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
			const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
			const retryableStatus =
				providerStatus === 401 ||
				providerStatus === 403 ||
				providerStatus === 429 ||
				(providerStatus !== undefined && providerStatus >= 500);
			const providerError =
				stopReason === "error" &&
				(retryableStatus ||
					/rate.?limit|temporar|unavailable|authentication|unauthori[sz]ed|model.*(?:not found|unavailable)/i.test(
						assistantError ?? "",
					));
			pendingResult = {
				version: 1,
				status: failed ? "failed" : "completed",
				output: assistant ? textFromAssistant(assistant) : "",
				error:
					fallbackError ??
					assistantError ??
					(stopReason === "aborted" ? "Interrupted." : undefined) ??
					(!assistant ? "Subagent exited without an assistant response." : undefined),
				stopReason,
				sessionFile: ctx.sessionManager.getSessionFile(),
				provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
				model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
				thinking: pi.getThinkingLevel(),
				finishedAt: Date.now(),
				failureKind:
					stopReason === "aborted" || fallbackError || /\boperation was aborted\b/i.test(assistantError ?? "")
						? "abort"
						: toolFailed
							? "tool"
							: providerError
								? "provider"
								: failed
									? "task"
									: undefined,
				providerStatus,
			};
		}

		reporting = writeJsonAtomic(resultPath, pendingResult)
			.then(() => {
				reported = true;
			})
			.catch((error) => {
				console.error(
					`[subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				reporting = undefined;
			});

		return reporting;
	};

	// agent_settled is newer than some peer type declarations but exists in the
	// runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		await report(ctx);
		// The parent closes the tab/window after collecting the result. Shutting Pi
		// down first gives its session lifecycle a chance to flush cleanly.
		if (process.env[EXIT_ON_FINISH_ENV] === "1") ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// A shutdown can race an in-flight report. Re-check after awaiting it so
		// one transient write failure still gets a final retry during teardown.
		for (let attempt = 0; attempt < 2 && !reported; attempt++) {
			await report(ctx, "Subagent session shut down before the task settled.");
		}
	});
}


/**
 * tmux children read their task from a private file and submit it themselves,
 * so no task text is typed into a terminal or passed through a shell. The
 * started marker tells the parent the task is in; it also keeps a reloaded
 * child from submitting twice.
 */
function registerTaskSubmission(pi: ExtensionAPI, taskPath: string, startedPath: string): void {
	pi.on("session_start", async () => {
		if (existsSync(startedPath)) return;
		const task = (await readFile(taskPath, "utf8")).replace(/\n$/, "");
		setTimeout(() => {
			pi.sendUserMessage(task);
			void writeFile(startedPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 }).catch((error) =>
				console.error(`[subagent] Failed to write start marker: ${error instanceof Error ? error.message : String(error)}`),
			);
		}, TASK_SUBMIT_DELAY_MS);
	});
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents; tmux reuses them as window names. */
function agentNameFor(id: string, prefix = "sub"): string {
	return `${prefix}-${shortId(id)}`;
}

function labelFor(task: string, prefix = "sub"): string {
	const firstLine = task.trim().split("\n", 1)[0] ?? "";
	const compact = firstLine.replace(/\s+/g, " ").trim();
	const label = compact.length > 28 ? `${compact.slice(0, 27)}…` : compact;
	return `${prefix}: ${label || "task"}`;
}

function detailsFromRecord(record: RunRecord, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	const backend = backendNameOf(record);
	const handle = handleOf(record);
	const commands = handle ? commandsFor(backend, handle) : undefined;
	return {
		status,
		task: record.task,
		cwd: record.cwd,
		backend,
		target: commands?.target ?? `${backend} (not launched)`,
		agentName: record.agentName,
		attachCommand: commands?.attach ?? "",
		captureCommand: commands?.capture ?? "",
		killCommand: commands?.close ?? "",
		provider: record.provider,
		model: record.model,
		thinking: record.thinking,
		runId: record.id,
		profile: record.profile,
		worktree: record.worktree,
		startedAt: record.startedAt,
		...extra,
	};
}

const RUN_STATUSES = new Set<RunStatus>(["queued", "running", "completed", "failed", "cancelled"]);
const AGENT_STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "done", "unknown"]);
const RUN_DETAIL_STRINGS = [
	"task",
	"cwd",
	"backend",
	"target",
	"agentName",
	"attachCommand",
	"captureCommand",
	"killCommand",
	"provider",
	"model",
	"thinking",
] as const;
const OPTIONAL_RUN_DETAIL_STRINGS = ["pane", "output", "error", "stopReason", "sessionFile", "runId", "profile"] as const;

export function isRunDetails(value: unknown): value is RunDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Record<string, unknown>;
	if (typeof details.status !== "string" || !RUN_STATUSES.has(details.status as RunStatus)) return false;
	if (RUN_DETAIL_STRINGS.some((key) => typeof details[key] !== "string")) return false;
	if (OPTIONAL_RUN_DETAIL_STRINGS.some((key) => details[key] !== undefined && typeof details[key] !== "string")) {
		return false;
	}
	if (
		details.agentStatus !== undefined &&
		(typeof details.agentStatus !== "string" || !AGENT_STATUSES.has(details.agentStatus as AgentStatus))
	) {
		return false;
	}
	if (details.autoClosed !== undefined && typeof details.autoClosed !== "boolean") return false;
	if (details.worktree !== undefined && (typeof details.worktree !== "object" || details.worktree === null)) return false;
	return [details.startedAt, details.finishedAt].every(
		(value) => value === undefined || (typeof value === "number" && Number.isFinite(value)),
	);
}

/** tmux sees processes, not Pi's state: it cannot tell whether a child is waiting for input. */
const TMUX_BLOCKED_NOTE = "tmux cannot report whether the child is waiting for input; attach if it stops making progress.";

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent ${details.status} in ${details.target}${details.runId ? `, run ${shortId(details.runId)}` : ""}.`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	];
	if (details.worktree) lines.push(`Worktree: ${details.worktree.path} (branch ${details.worktree.branch})`);
	if (details.agentStatus === "blocked") {
		lines.push(`herdr reports the child is BLOCKED and waiting for input. Attach to answer it.`);
	} else if (details.backend === "tmux") {
		lines.push(TMUX_BLOCKED_NOTE);
	}
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

export function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
	];
	if (details.runId) lines.push(`Run: ${shortId(details.runId)}`);
	if (details.stopReason) lines.push(`Stop reason: ${details.stopReason}`);
	if (details.error) lines.push(`Error: ${details.error}`);
	lines.push(
		details.autoClosed ? `${details.target} (auto-closed)` : `${details.target}, agent ${details.agentName}`,
	);
	if (!details.autoClosed) {
		lines.push(
			`Attach: ${details.attachCommand}`,
			`Capture: ${details.captureCommand}`,
			`Clean up: ${details.killCommand}`,
		);
	}
	if (details.worktree) lines.push(...worktreeText(details.worktree));
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined, wake?: { promise: Promise<void> }): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		wake?.promise.then(() => {
			clearTimeout(timer);
			cleanup();
			resolve();
		});
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Final failures advance to the next model; explicit cancellation does not. */
export function isFallbackFailure(value: ChildResult | Error): boolean {
	if (value instanceof Error) return true;
	return value.status === "failed" && value.failureKind !== "abort" && value.stopReason !== "aborted";
}

/** Profile `tools` token that grants every extension-registered tool. */
export const EXTENSION_TOOLS_TOKEN = "extensions";

/** A tool an extension registered (not a Pi built-in or SDK tool) that is active by default. */
function isExtensionTool(tool: { name: string; exposure?: string; sourceInfo?: { path?: string; source?: string } }): boolean {
	const source = tool.sourceInfo;
	if (!source || source.source === "sdk" || source.path === `builtin:${tool.name}`) return false;
	return tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only";
}

export function resolveChildTools(pi: ExtensionAPI, profileTools: string[], profileName: string): string[] {
	const allTools = pi.getAllTools();
	const knownTools = new Map(allTools.map((tool) => [tool.name, tool]));
	const requestedTools = profileTools.flatMap((name) =>
		name === EXTENSION_TOOLS_TOKEN && !knownTools.has(name)
			? allTools.filter(isExtensionTool).map((tool) => tool.name)
			: [name],
	);
	const unknownTools = requestedTools.filter((name) => !knownTools.has(name));
	if (unknownTools.length > 0) {
		throw new Error(`Agent profile ${profileName} has unknown tool(s): ${unknownTools.join(", ")}.`);
	}
	const sdkTools = requestedTools.filter((name) => knownTools.get(name)?.sourceInfo?.source === "sdk");
	if (sdkTools.length > 0) {
		throw new Error(`Agent profile ${profileName} uses SDK-only tool(s) unavailable to child Pi: ${sdkTools.join(", ")}.`);
	}
	return [...new Set(requestedTools.filter((name) => !DELEGATION_TOOL_NAMES.has(name)))];
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const explicitProvider = providerOverride?.trim();
	const explicitModel = modelOverride?.trim();
	let provider = explicitProvider || ctx.model?.provider || "";
	let model = explicitModel || ctx.model?.id || "";

	// A slash in an inherited id can be part of the id itself (OpenRouter's
	// openai/gpt-*). Only treat an explicit model as provider/model when no
	// separate provider was supplied, or when both agree.
	const slashIndex = explicitModel?.indexOf("/") ?? -1;
	if (explicitModel && slashIndex > 0) {
		const modelProvider = explicitModel.slice(0, slashIndex);
		if (!explicitProvider) {
			provider = modelProvider;
			model = explicitModel.slice(slashIndex + 1);
		} else if (explicitProvider === modelProvider) {
			model = explicitModel.slice(slashIndex + 1);
		}
	}

	if (!provider || !model) {
		throw new Error("No model is active. Pass both provider and model to the subagent tool.");
	}
	return { provider, model };
}

function modelCandidates(profile: AgentProfile): Array<string | undefined> {
	return profile.model === undefined ? [undefined] : Array.isArray(profile.model) ? profile.model : [profile.model];
}

async function readResult(resultPath: string): Promise<ChildResult | undefined> {
	try {
		return JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
	} catch {
		return undefined;
	}
}

interface MonitorProgress {
	pane?: string;
	agentStatus?: AgentStatus;
	sessionFile?: string;
}

class ChildExitedError extends Error {}

/**
 * Wait for the child's result file. fs.watch wakes the loop on writes; the
 * backend is probed every PROBE_INTERVAL_MS for liveness and blocked state only.
 */
async function monitorChild(
	backend: SubagentBackend,
	handle: BackendHandle,
	options: {
		resultPath: string;
		signal: AbortSignal;
		readPane: boolean;
		onProgress: (progress: MonitorProgress) => void;
	},
): Promise<{ result: ChildResult; progress: MonitorProgress }> {
	const progress: MonitorProgress = {};
	let wakeResolve: (() => void) | undefined;
	let wake = { promise: new Promise<void>((resolve) => (wakeResolve = resolve)) };
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(path.dirname(options.resultPath), () => wakeResolve?.());
		watcher.on("error", () => undefined);
	} catch {
		// Fallback polling still observes the result file.
	}

	let nextProbe = 0;
	let goneSince: number | undefined;
	try {
		for (;;) {
			if (options.signal.aborted) throw new Error("Subagent aborted.");
			const result = await readResult(options.resultPath);
			if (result) return { result, progress };

			if (Date.now() >= nextProbe) {
				nextProbe = Date.now() + PROBE_INTERVAL_MS;
				const probe = await backend.probe(handle);
				const paneText = options.readPane ? await backend.tail(handle, PANE_READ_LINES) : undefined;
				let changed = false;
				if (probe === "gone") {
					goneSince ??= Date.now();
				} else if (probe !== "unknown") {
					goneSince = undefined;
					if (typeof probe === "object") {
						if (probe.sessionFile) progress.sessionFile = probe.sessionFile;
						if (probe.status !== progress.agentStatus) {
							progress.agentStatus = probe.status;
							changed = true;
						}
					}
				}
				const pane = paneText ? trimPane(paneText) : "";
				if (pane && pane !== progress.pane) {
					progress.pane = pane;
					changed = true;
				}
				if (changed) options.onProgress({ ...progress });

				if (goneSince !== undefined && Date.now() - goneSince >= EXIT_GRACE_MS) {
					const late = await readResult(options.resultPath);
					if (late) return { result: late, progress };
					const finalPane = (await backend.tail(handle, 30)) ?? "";
					throw new ChildExitedError(
						`Child Pi exited before reporting a result.${finalPane ? `\n\n${trimPane(finalPane)}` : ""}`,
					);
				}
			}

			const delay = goneSince !== undefined ? Math.min(RESULT_CHECK_MS, EXIT_GRACE_MS / 2) : RESULT_CHECK_MS;
			await abortableDelay(delay, options.signal, wake);
			wake = { promise: new Promise<void>((resolve) => (wakeResolve = resolve)) };
		}
	} finally {
		watcher?.close();
	}
}

/* -------------------------------------------------------------------------- */
/* run records and pruning                                                     */
/* -------------------------------------------------------------------------- */

function runDirFor(parentSessionId: string, id: string): string {
	return path.join(getAgentDir(), RUNS_DIR, parentSessionId, id);
}

async function saveRecord(record: RunRecord): Promise<void> {
	try {
		await writeJsonAtomic(path.join(runDirFor(record.parentSessionId, record.id), "run.json"), record);
	} catch (error) {
		console.error(`[subagent] Failed to save run record: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadSessionRecords(parentSessionId: string): Promise<RunRecord[]> {
	const directory = path.join(getAgentDir(), RUNS_DIR, parentSessionId);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const records: RunRecord[] = [];
	for (const name of names) {
		try {
			const record = JSON.parse(await readFile(path.join(directory, name, "run.json"), "utf8")) as RunRecord;
			if (record?.version === 1 && record.id === name) records.push(record);
		} catch {
			// Legacy run directory without a record.
		}
	}
	return records;
}

/** Delete run directories older than maxAgeDays. Returns the number removed. */
export async function pruneRunDirs(
	maxAgeDays: number,
	options: { keepSessionId?: string; roots?: string[]; now?: number } = {},
): Promise<number> {
	if (!(maxAgeDays > 0)) return 0;
	const cutoff = (options.now ?? Date.now()) - maxAgeDays * 24 * 60 * 60 * 1000;
	const roots = options.roots ?? [path.join(getAgentDir(), RUNS_DIR)];
	let removed = 0;
	for (const root of roots) {
		let sessions: string[];
		try {
			sessions = await readdir(root);
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (session === options.keepSessionId) continue;
			const sessionDir = path.join(root, session);
			let runs: string[];
			try {
				runs = await readdir(sessionDir);
			} catch {
				continue;
			}
			let remaining = runs.length;
			for (const run of runs) {
				const runDir = path.join(sessionDir, run);
				try {
					const info = await stat(runDir);
					let newest = info.mtimeMs;
					for (const file of ["run.json", "result.json"]) {
						const fileInfo = await stat(path.join(runDir, file)).catch(() => undefined);
						if (fileInfo) newest = Math.max(newest, fileInfo.mtimeMs);
					}
					if (newest >= cutoff) continue;
					await rm(runDir, { recursive: true, force: true });
					removed++;
					remaining--;
				} catch {
					// Leave anything we cannot inspect.
				}
			}
			if (remaining === 0) await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
	return removed;
}

function retentionDays(): number {
	const raw = process.env[RETENTION_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETENTION_DAYS;
}

/* -------------------------------------------------------------------------- */
/* extension                                                                   */
/* -------------------------------------------------------------------------- */

export default function subagentExtension(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		const taskPath = process.env[TASK_ENV];
		if (taskPath) registerTaskSubmission(pi, taskPath, `${resultPath}.started`);
		return;
	}

	const backends: Record<BackendName, SubagentBackend> = {
		herdr: new HerdrBackend(pi),
		tmux: new TmuxBackend(pi),
	};
	const backendFor = (record: RunRecord): SubagentBackend => backends[backendNameOf(record)];

	/** Live async and blocking runs, keyed by run id, from before launch until settled. */
	const liveRuns = new Map<string, LiveRun>();
	let shuttingDown = false;
	let currentCtx: ExtensionContext | undefined;

	const asyncRuns = () => [...liveRuns.values()].filter((run) => run.record.kind === "async" && run.launched);

	const updateAsyncWidget = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI || shuttingDown) return;
		const runs = asyncRuns();
		if (runs.length === 0) {
			ctx.ui.setWidget(ASYNC_WIDGET_ID, undefined);
			return;
		}
		const lines = [`Async subagents (${runs.length})`];
		for (const run of runs) {
			const status =
				run.details.agentStatus === "blocked"
					? "blocked · needs input"
					: run.details.agentStatus && run.details.agentStatus !== "unknown"
						? run.details.agentStatus
						: run.details.status;
			const worktree = run.record.worktree ? ` · ${run.record.worktree.branch}` : "";
			lines.push(`  ${shortId(run.record.id)} ${run.record.profile} · ${status}${worktree} · ${run.details.attachCommand}`);
		}
		ctx.ui.setWidget(ASYNC_WIDGET_ID, lines);
	};

	/** At most once: `delivered` is persisted before the steer, so a crash in between drops rather than repeats it. */
	const deliverAsyncResult = async (run: LiveRun, details: RunDetails): Promise<void> => {
		if (shuttingDown || run.controller.signal.aborted || run.record.delivered) return;
		const outcome = details.status === "completed" ? "completed" : "failed";
		run.record.delivered = true;
		await saveRecord(run.record);
		pi.sendMessage(
			{
				customType: ASYNC_RESULT_TYPE,
				content: truncateToolText(`Async subagent "${run.record.profile}" ${outcome}.\n\n${resultText(details)}`),
				display: true,
				details: { ...details, runId: run.record.id, profile: run.record.profile },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	/** Close one target through its run's backend; true once it is known to be gone. Idempotent. */
	const closedTargets = new Set<string>();
	const closeTarget = async (
		backend: SubagentBackend,
		handle: BackendHandle | undefined,
		options?: { verify?: boolean },
	): Promise<boolean> => {
		if (!handle) return true;
		const key = `${backend.name}:${JSON.stringify(handle)}`;
		if (closedTargets.has(key)) return true;
		try {
			await backend.close(handle, options);
			closedTargets.add(key);
			return true;
		} catch {
			return false;
		}
	};

	const closePending = async (run: LiveRun): Promise<void> => {
		const backend = backendFor(run.record);
		for (const handle of run.pending.splice(0)) await closeTarget(backend, handle);
	};

	/**
	 * Final bookkeeping for a settled child: close its target, release any
	 * worktree, and build the reported details.
	 */
	const settle = async (
		record: RunRecord,
		outcome: { result?: ChildResult; error?: string; progress: MonitorProgress },
		options: { autoClose: boolean; verifyClose?: boolean },
	): Promise<RunDetails> => {
		const backend = backendFor(record);
		const result = outcome.result;
		const status: RunStatus = result ? (result.status === "completed" ? "completed" : "failed") : "failed";
		let worktree = record.worktree;
		let autoClosed = false;
		const liveWorktree = worktree && worktree.state !== "removed" && existsSync(worktree.path);
		if (options.autoClose) {
			// A dirty worktree keeps its target so the checkout stays one attach away.
			if (worktree && liveWorktree) {
				const inspected = await inspectWorktree(pi, worktree);
				if (inspected.dirty) {
					worktree = { ...inspected, state: "retained", note: "Uncommitted changes; checkout and tab retained for inspection." };
				} else {
					autoClosed = await closeTarget(backend, handleOf(record), { verify: options.verifyClose });
					worktree = autoClosed
						? await releaseWorktree(pi, worktree)
						: { ...inspected, state: "retained", note: "Child target could not be confirmed closed; checkout retained." };
				}
			} else {
				autoClosed = await closeTarget(backend, handleOf(record), { verify: options.verifyClose });
			}
		} else if (worktree && liveWorktree) {
			worktree = { ...(await inspectWorktree(pi, worktree)), state: "active" };
		}

		record.status = status;
		record.finishedAt = result?.finishedAt ?? Date.now();
		record.sessionFile = result?.sessionFile ?? outcome.progress.sessionFile ?? record.sessionFile;
		record.worktree = worktree;
		if (result?.provider) record.provider = result.provider;
		if (result?.model) record.model = result.model;
		if (result?.thinking) record.thinking = result.thinking;
		await saveRecord(record);

		return detailsFromRecord(record, status, {
			pane: outcome.progress.pane,
			output: result ? truncateToolText(result.output.trim() || "(no text output)") : undefined,
			error: result?.error?.trim() || outcome.error || undefined,
			stopReason: result?.stopReason,
			agentStatus: outcome.progress.agentStatus,
			sessionFile: record.sessionFile,
			finishedAt: record.finishedAt,
			autoClosed,
		});
	};

	interface ExecuteOptions {
		kind: "blocking" | "async";
		profile: AgentProfile;
		task: string;
		sourceCwd: string;
		ctx: ExtensionContext;
		signal: AbortSignal;
		/** Owns the run; aborted on session shutdown or /reload detach. */
		controller: AbortController;
		autoClose: boolean;
		readPane: boolean;
		onLaunched?: (run: LiveRun) => void;
		onProgress?: (details: RunDetails) => void;
	}

	/**
	 * Launch a child (with ordered model fallback), wait for its result, and
	 * settle it. Shared by blocking and async runs. Errors before the first
	 * successful launch propagate; later failures resolve as failed details.
	 */
	const runJobs = new Set<Promise<unknown>>();
	const executeRun = (options: ExecuteOptions): Promise<{ details: RunDetails; record: RunRecord }> => {
		const job = executeRunNow(options);
		runJobs.add(job);
		void job.then(
			() => runJobs.delete(job),
			() => runJobs.delete(job),
		);
		return job;
	};

	const executeRunNow = async (options: ExecuteOptions): Promise<{ details: RunDetails; record: RunRecord }> => {
		const { profile, ctx } = options;
		const thinking = profile.thinking ?? pi.getThinkingLevel();
		const childTools = resolveChildTools(pi, profile.tools ?? pi.getActiveTools(), profile.name);
		const candidates = modelCandidates(profile);
		// Resolved once, before any side effect; every attempt and cleanup reuses it.
		const backend = await resolveBackend(backends, (await configuredBackend()).setting);
		const parentSessionId = ctx.sessionManager.getSessionId();
		const id = randomUUID();
		const runDir = runDirFor(parentSessionId, id);
		const sessionDir = path.join(runDir, "session");
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		const trusted = isSameOrDescendant(path.resolve(ctx.cwd), options.sourceCwd) && ctx.isProjectTrusted();
		const prefix = options.kind === "async" ? "async" : "sub";

		const record: RunRecord = {
			version: 1,
			id,
			kind: options.kind,
			profile: profile.name,
			parentSessionId,
			task: options.task,
			sourceCwd: options.sourceCwd,
			cwd: options.sourceCwd,
			provider: "",
			model: "",
			thinking,
			tools: childTools,
			agentName: agentNameFor(id, prefix),
			backend: backend.name,
			status: "queued",
			startedAt: Date.now(),
		};
		const live: LiveRun = {
			record,
			details: detailsFromRecord(record, "queued"),
			controller: options.controller,
			launched: false,
			pending: [],
		};
		liveRuns.set(id, live);
		const signal = AbortSignal.any([options.signal, options.controller.signal]);

		let isolationNote = "";
		try {
			if (profile.worktree) {
				const created = await createWorktree(pi, backend, options.sourceCwd, branchFor(profile.name, id), labelFor(options.task, profile.name));
				if (created) {
					record.worktree = created.info;
					record.cwd = created.cwd;
					if (created.placeholder) live.pending.push(created.placeholder);
					await saveRecord(record);
				} else {
					isolationNote = "Note: worktree isolation was requested but the directory is not a Git repository; ran in place.";
				}
			}
			const worktree = record.worktree;
			const task = worktree ? `${options.task}${worktreeNote(worktree)}` : options.task;
			const taskPath = path.join(runDir, "task.md");
			await writeFile(taskPath, `${task}\n`, { encoding: "utf8", mode: 0o600 });

			for (let index = 0; index < candidates.length; index++) {
				const selected = resolveModel(ctx, undefined, candidates[index]);
				const resultPath = path.join(runDir, index === 0 ? "result.json" : `result.${index}.json`);
				record.provider = selected.provider;
				record.model = selected.model;
				record.resultPath = resultPath;
				record.agentName = agentNameFor(index === 0 ? id : randomUUID(), prefix);
				record.handle = undefined;

				const piArgs = [
					"--provider",
					selected.provider,
					"--model",
					selected.model,
					"--thinking",
					thinking,
					...(childTools.length > 0 ? ["--tools", childTools.join(",")] : ["--no-tools"]),
					"--session-dir",
					sessionDir,
					"--name",
					record.agentName,
					trusted ? "--approve" : "--no-approve",
					"--extension",
					EXTENSION_PATH,
				];

				signal.throwIfAborted();
				let result: ChildResult | undefined;
				let failure: Error | undefined;
				let progress: MonitorProgress = {};
				try {
					await backend.launch(
						{
							runId: id,
							agentName: record.agentName,
							label: labelFor(options.task, prefix),
							cwd: record.cwd,
							env: {
								[CHILD_ENV]: "1",
								[RESULT_ENV]: resultPath,
								[EXIT_ON_FINISH_ENV]: options.autoClose ? "1" : "0",
							},
							piArgs,
							task,
							taskPath,
							startedPath: `${resultPath}.started`,
							workspaceId: worktree?.workspaceId,
							signal,
						},
						async (handle) => {
							// Persist the target before startup so shutdown and the next
							// session start can find and close it.
							record.handle = handle;
							live.details = detailsFromRecord(record, "queued");
							await saveRecord(record);
							// A worktree workspace closes with its last tab: retire
							// superseded targets only once this one exists.
							await closePending(live);
						},
					);
					signal.throwIfAborted();
					record.status = "running";
					await saveRecord(record);
					live.details = detailsFromRecord(record, "running");
					if (!live.launched) {
						live.launched = true;
						options.onLaunched?.(live);
					}
					options.onProgress?.(live.details);
					const monitored = await monitorChild(backend, record.handle!, {
						resultPath,
						signal,
						readPane: options.readPane,
						onProgress: (update) => {
							progress = update;
							live.details = detailsFromRecord(record, "running", {
								pane: update.pane,
								agentStatus: update.agentStatus,
							});
							options.onProgress?.(live.details);
						},
					});
					result = monitored.result;
					progress = monitored.progress;
				} catch (error) {
					if (signal.aborted) {
						// Session shutdown closes its own targets; a reload keeps async ones running.
						if (!live.detached) await closeTarget(backend, record.handle);
						throw error;
					}
					failure = error instanceof Error ? error : new Error(String(error));
				}

				const hasNext = index + 1 < candidates.length;
				// The child reports only after Pi settles, including its internal retries.
				// Do not add retries here: any final failure advances one model candidate.
				const shouldFallback = hasNext &&
					(result ? isFallbackFailure(result) : failure !== undefined && isFallbackFailure(failure));
				if (shouldFallback) {
					if (record.handle) {
						if (worktree) live.pending.push(record.handle);
						else await closeTarget(backend, record.handle);
					}
					continue;
				}
				if (!live.launched && failure) {
					await closeTarget(backend, record.handle);
					throw failure;
				}
				const settled = await settle(record, { result, error: failure?.message, progress }, {
					autoClose: options.autoClose,
				});
				if (isolationNote) settled.error = settled.error ? `${settled.error}\n${isolationNote}` : isolationNote;
				live.details = settled;
				return { details: settled, record };
			}
			throw new Error("Every model candidate failed.");
		} catch (error) {
			if (!live.detached) {
				await closePending(live);
				// Launch failure or abort: drop a clean checkout (dirty ones are retained).
				if (record.worktree) record.worktree = await releaseWorktree(pi, record.worktree);
				if (record.status === "queued" || record.status === "running") {
					record.status = signal.aborted ? "cancelled" : "failed";
					record.finishedAt = Date.now();
				}
				await saveRecord(record);
			}
			throw error;
		} finally {
			if (!live.detached) liveRuns.delete(id);
			updateAsyncWidget(currentCtx);
		}
	};

	/** Start an async run in the background and return once its first child is live. */
	const startAsync = async (
		profile: AgentProfile,
		task: string,
		sourceCwd: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<LiveRun> => {
		const background = new AbortController();
		let launched: ((run: LiveRun) => void) | undefined;
		const launchedPromise = new Promise<LiveRun>((resolve) => (launched = resolve));
		// The dispatching tool call's signal only guards launch, not the background run.
		const onAbort = () => background.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let liveRun: LiveRun | undefined;
		const job = executeRun({
			kind: "async",
			profile,
			task,
			sourceCwd,
			ctx,
			signal: background.signal,
			controller: background,
			autoClose: true,
			readPane: false,
			onLaunched: (run) => {
				liveRun = run;
				signal?.removeEventListener("abort", onAbort);
				updateAsyncWidget(ctx);
				launched?.(run);
			},
			onProgress: () => updateAsyncWidget(ctx),
		});
		job
			.then(async ({ details }) => {
				if (liveRun && !liveRun.detached) await deliverAsyncResult(liveRun, details);
			})
			.catch(async (error) => {
				if (!liveRun || liveRun.detached || shuttingDown || background.signal.aborted) return;
				const details = detailsFromRecord(liveRun.record, "failed", {
					error: error instanceof Error ? error.message : String(error),
					finishedAt: Date.now(),
				});
				liveRun.record.status = "failed";
				await deliverAsyncResult(liveRun, details);
			});
		return Promise.race([
			launchedPromise,
			job.then(
				() => launchedPromise,
				(error) => {
					signal?.removeEventListener("abort", onAbort);
					if (liveRun) return liveRun;
					throw error;
				},
			),
		]);
	};

	/** Close the target and release the checkout of a run whose owner died mid-flight (crash during launch or a blocking call). */
	const cleanUpInterrupted = async (record: RunRecord): Promise<void> => {
		// Target ids may have been reused since the crash: close only what is provably this run's.
		if (!(await closeTarget(backendFor(record), handleOf(record), { verify: true }))) return;
		if (record.worktree) record.worktree = await releaseWorktree(pi, record.worktree);
		record.status = "cancelled";
		record.delivered = true;
		record.finishedAt ??= Date.now();
		await saveRecord(record);
	};

	/** Re-attach monitors to async runs that survived /reload (or a crash), using each run's own backend. */
	const reattach = async (ctx: ExtensionContext): Promise<void> => {
		const records = await loadSessionRecords(ctx.sessionManager.getSessionId());
		for (const record of records) {
			if (liveRuns.has(record.id)) continue;
			const interrupted =
				record.status === "queued" || (record.kind === "blocking" && record.status === "running");
			if (interrupted && (handleOf(record) || record.worktree)) {
				await cleanUpInterrupted(record);
				continue;
			}
			if (record.kind !== "async" || record.delivered) continue;
			if (record.status !== "running" && record.status !== "completed" && record.status !== "failed") continue;
			const handle = handleOf(record);
			const run: LiveRun = {
				record,
				details: detailsFromRecord(record, "running"),
				controller: new AbortController(),
				launched: true,
				pending: [],
			};
			liveRuns.set(record.id, run);
			void (async () => {
				let details: RunDetails;
				try {
					if (!record.resultPath || !handle) throw new Error("Run record is incomplete.");
					const monitored = await monitorChild(backendFor(record), handle, {
						resultPath: record.resultPath,
						signal: run.controller.signal,
						readPane: false,
						onProgress: (update) => {
							run.details = detailsFromRecord(record, "running", { agentStatus: update.agentStatus });
							updateAsyncWidget(currentCtx);
						},
					});
					details = await settle(
						record,
						{ result: monitored.result, progress: monitored.progress },
						{ autoClose: true, verifyClose: true },
					);
				} catch (error) {
					if (run.controller.signal.aborted) return;
					details = await settle(
						record,
						{ error: error instanceof Error ? error.message : String(error), progress: {} },
						{ autoClose: true, verifyClose: true },
					);
				} finally {
					if (!run.detached) liveRuns.delete(record.id);
					updateAsyncWidget(currentCtx);
				}
				await deliverAsyncResult(run, details);
			})();
		}
		updateAsyncWidget(ctx);
	};

	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false;
		currentCtx = ctx;
		ctx.ui.addAutocompleteProvider((current) => createAgentRefAutocomplete(current, subagentProfiles));
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (ctx.sessionManager?.getSessionId) {
			await reattach(ctx).catch((error) =>
				console.error(`[subagent] Re-attach failed: ${error instanceof Error ? error.message : String(error)}`),
			);
			if (reason === "startup") {
				void pruneRunDirs(retentionDays(), { keepSessionId: ctx.sessionManager.getSessionId() }).catch(() => undefined);
			}
		}
		updateAsyncWidget(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const profiles = await subagentProfiles.list();
		if (profiles.length === 0) return;
		const isolated = profiles.filter((profile) => profile.worktree).map((profile) => profile.name);
		event.systemPromptOptions.sections.agent_profiles =
			`A valid &name reference is the user's explicit request to delegate asynchronously with that profile. Route every valid &name through ${ASYNC_TOOL}, including &worker. Compose a complete, self-contained task for every child. Do not add model, thinking, or tool overrides; the profile owns them. The caller controls the number and ordering of calls unless the user explicitly requests references or parallelism. Use ${BLOCKING_TOOL} only for a parent-selected blocking dependency.` +
			(isolated.length
				? ` Profiles ${isolated.join(", ")} run in isolated Git worktrees on their own branch and do not see uncommitted parent changes; review the reported commits, then integrate the branch yourself.`
				: "");
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | undefined)?.reason;
		shuttingDown = true;
		const closes: Array<Promise<unknown>> = [];
		for (const run of liveRuns.values()) {
			if (reason === "reload" && run.record.kind === "async" && run.launched) {
				// Keep launched async children running; the reloaded extension re-attaches.
				run.detached = true;
				run.controller.abort();
				continue;
			}
			// Blocking calls and unfinished launches have no owner after shutdown.
			run.controller.abort();
			run.record.status = "cancelled";
			run.record.delivered = true;
			run.record.finishedAt = Date.now();
			await saveRecord(run.record);
			const backend = backendFor(run.record);
			closes.push(closeTarget(backend, handleOf(run.record)), ...run.pending.splice(0).map((handle) => closeTarget(backend, handle)));
		}
		liveRuns.clear();
		// Let in-flight launches persist and close targets created after cancellation before runtime invalidation.
		await Promise.allSettled([...closes, ...runJobs]);
		if (ctx?.hasUI) ctx.ui.setWidget(ASYNC_WIDGET_ID, undefined);
	});

	pi.registerCommand?.("subagent-prune", {
		description: `Delete subagent run directories older than N days (default ${DEFAULT_RETENTION_DAYS}, or $${RETENTION_ENV})`,
		handler: async (args: string, ctx: ExtensionContext) => {
			const days = args.trim() ? Number(args.trim()) : retentionDays() || DEFAULT_RETENTION_DAYS;
			if (!Number.isFinite(days) || days < 0) {
				ctx.ui.notify("Usage: /subagent-prune [days]", "error");
				return;
			}
			const removed = await pruneRunDirs(days === 0 ? Number.MIN_VALUE : days, {
				keepSessionId: ctx.sessionManager.getSessionId(),
			});
			ctx.ui.notify(`Removed ${removed} subagent run director${removed === 1 ? "y" : "ies"}.`, "info");
		},
	});

	const BACKEND_CHOICES: BackendSetting[] = ["auto", "herdr", "tmux"];
	pi.registerCommand?.("subagent-backend", {
		description: "Show or set the subagent launch backend for new runs: auto, herdr, or tmux",
		getArgumentCompletions: (prefix: string) =>
			BACKEND_CHOICES.filter((choice) => choice.startsWith(prefix.trim())).map((choice) => ({ value: choice, label: choice })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const requested = args.trim();
			if (!requested) {
				let text: string;
				try {
					const { setting, source } = await configuredBackend();
					const from = source === "env" ? BACKEND_ENV : source === "file" ? settingsPath() : "default";
					const resolved = await resolveBackend(backends, setting).then(
						(backend) => backend.name,
						(error: unknown) => `unavailable (${error instanceof Error ? error.message : String(error)})`,
					);
					text = `Subagent backend: ${setting} (${from}); new runs use ${resolved}.`;
				} catch (error) {
					text = error instanceof Error ? error.message : String(error);
				}
				ctx.ui.notify(text, "info");
				return;
			}
			if (!BACKEND_CHOICES.includes(requested as BackendSetting)) {
				ctx.ui.notify("Usage: /subagent-backend [auto|herdr|tmux]", "error");
				return;
			}
			let existing: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(await readFile(settingsPath(), "utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
			} catch {
				// Missing or unreadable: start fresh.
			}
			await writeJsonAtomic(settingsPath(), { ...existing, backend: requested });
			const override = process.env[BACKEND_ENV]?.trim();
			ctx.ui.notify(
				`Subagent backend set to ${requested} for new runs.${override ? ` ${BACKEND_ENV}=${override} still overrides it in this process.` : ""}`,
				override ? "warning" : "info",
			);
		},
	});

	const allProfileNames = subagentProfiles.listSync().map((profile) => profile.name);
	const availableProfileNames = allProfileNames.filter((name) => name.toLowerCase() !== WORKER_PROFILE);

	const asyncTool = {
		name: ASYNC_TOOL,
		label: "Subagent Async",
		description: `Dispatch one asynchronous delegated task using a named agent profile. Available profiles: ${allProfileNames.length ? allProfileNames.join(", ") : "(none)"}. Returns the run id and attach/capture commands once the child is running in a Herdr tab or tmux window, monitors it in the background, and automatically steers its bounded final result back into this session. Ordered model fallback applies. Profiles marked worktree run on their own Git branch. Async runs survive /reload and are cancelled when the parent session ends.`,
		promptSnippet: "Dispatch a background subagent whose result returns automatically",
		promptGuidelines: [
			`Route every explicit &name agent reference through ${ASYNC_TOOL}, including &worker.`,
			`Use ${ASYNC_TOOL} when delegated work can run independently while the parent continues useful work.`,
			`Provide ${ASYNC_TOOL} a named agent profile and a complete, self-contained task.`,
			`Do not poll a ${ASYNC_TOOL} run; its completion or failure is automatically steered into the parent session.`,
		],
		parameters: DelegatedTaskParams,

		async execute(
			_toolCallId: string,
			params: { agent: string; task: string; cwd?: string },
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			if (!params.task.trim()) throw new Error("Async subagent task must not be empty.");
			if (signal?.aborted) throw new Error("Async subagent dispatch aborted.");
			const profile = await subagentProfiles.get(params.agent);
			const sourceCwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			await validateCwd(sourceCwd);
			currentCtx ??= ctx;

			const run = await startAsync(profile, params.task, sourceCwd, signal, ctx);
			const details = run.details;
			const text = [
				`Async ${profile.name} dispatched in ${details.target} (run ${shortId(run.record.id)}).`,
				"Its completion or failure will be delivered automatically; do not poll it.",
				`Attach: ${details.attachCommand}`,
				`Capture: ${details.captureCommand}`,
				...(run.record.worktree
					? [`Worktree: ${run.record.worktree.path} (branch ${run.record.worktree.branch})`]
					: []),
				...(details.backend === "tmux" ? [TMUX_BLOCKED_NOTE] : []),
			].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { ...details, runId: run.record.id, profile: profile.name },
			};
		},

		renderCall(args: { agent?: string; task?: string }, theme: any) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			return new Text(
				theme.fg("toolTitle", theme.bold(`subagent async ${args.agent || ""} `)) + theme.fg("dim", preview),
				0,
				0,
			);
		},

		renderResult(result: any, _options: any, theme: any) {
			const details = result.details as (RunDetails & { profile?: string }) | undefined;
			if (!details?.attachCommand) {
				const content = result.content.find((part: any) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const id = details.runId ? ` ${shortId(details.runId)}` : "";
			return new Text(
				`${theme.fg("success", "↗")} ${theme.fg("toolTitle", theme.bold(details.profile || details.agentName))}${theme.fg("muted", `${id} · running asynchronously`)}\n  ${theme.fg("accent", details.attachCommand)}`,
				0,
				0,
			);
		},
	} satisfies ToolDefinition<typeof DelegatedTaskParams> & Record<string, unknown>;
	pi.registerTool(asyncTool as unknown as ToolDefinition<typeof DelegatedTaskParams>);

	const blockingTool = {
		name: BLOCKING_TOOL,
		label: "Subagent",
		description: `Run one parent-selected blocking dependency in a separate Pi process using a named non-worker agent profile. Available blocking profiles: ${availableProfileNames.length ? availableProfileNames.join(", ") : "(none)"}. Use ${ASYNC_TOOL} for explicit &name references and for the worker profile. Profiles are refreshed at call time; sibling calls may run concurrently. Each child is visible and inspectable in a Herdr tab or tmux window while running, then its target auto-closes after the result is collected; output is capped at 50KB or 2000 lines.`,
		promptSnippet: "Run one blocking delegated task in an observable Herdr tab or tmux window",
		promptGuidelines: [
			`Use ${BLOCKING_TOOL} only when the parent selects a blocking dependency and needs its result before continuing.`,
			`Provide ${BLOCKING_TOOL} one non-worker profile and a complete, self-contained task; route explicit &name references through ${ASYNC_TOOL} instead.`,
			`Never pass worker to ${BLOCKING_TOOL}; use ${ASYNC_TOOL} with the worker profile instead.`,
			"If a run reports that the child is blocked, attach with the printed command and answer it rather than retrying the task.",
		],
		parameters: DelegatedTaskParams,

		async execute(
			_toolCallId: string,
			params: { agent: string; task: string; cwd?: string },
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			if (params.agent.trim().toLowerCase() === WORKER_PROFILE) {
				throw new Error(
					`The worker profile is not available to blocking ${BLOCKING_TOOL}. Use ${ASYNC_TOOL} with agent worker.`,
				);
			}
			const profile = await subagentProfiles.get(params.agent);
			const sourceCwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			await validateCwd(sourceCwd);
			currentCtx ??= ctx;

			const { details } = await executeRun({
				kind: "blocking",
				profile,
				task: params.task,
				sourceCwd,
				ctx,
				signal: signal ?? new AbortController().signal,
				controller: new AbortController(),
				autoClose: process.env[EXIT_ON_FINISH_ENV] !== "0",
				readPane: true,
				onProgress: (progress) =>
					onUpdate?.({ content: [{ type: "text", text: partialText(progress) }], details: progress }),
			});
			if (details.status !== "completed") throw new NonRetryableSubagentError(resultText(details));
			return { content: [{ type: "text" as const, text: resultText(details) }], details };
		},

		renderCall(args: { agent?: string; task?: string }, theme: any) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			return new Text(theme.fg("toolTitle", theme.bold(`subagent ${args.agent || ""} `)) + theme.fg("dim", preview), 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
			const details = isRunDetails(result.details) ? result.details : undefined;
			if (!details) {
				const content = result.content.find((part: any) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const running = isPartial || details.status === "queued" || details.status === "running";
			const blocked = running && details.agentStatus === "blocked";
			const icon = blocked
				? theme.fg("error", "?")
				: running
					? theme.fg("warning", details.status === "queued" ? "◦" : "●")
					: details.status === "completed"
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
			const duration = formatDuration(details.startedAt, details.finishedAt);
			const label = details.agentName || "subagent";
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))}`;
			const state = blocked ? "blocked · needs input" : details.status;
			text += theme.fg("muted", ` · ${state}${duration ? ` · ${duration}` : ""}`);
			text += details.autoClosed
				? `\n  ${theme.fg("dim", `${details.backend} target auto-closed`)}`
				: `\n  ${theme.fg("accent", details.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;
			if (details.worktree) text += `\n  ${theme.fg("dim", `branch ${details.worktree.branch}`)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				if (!details.autoClosed) {
					text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
					text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	} satisfies ToolDefinition<typeof DelegatedTaskParams> & Record<string, unknown>;
	pi.registerTool(blockingTool as unknown as ToolDefinition<typeof DelegatedTaskParams>);
}
