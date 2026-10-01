/**
 * herdr-subagent: run blocking, asynchronous, or fire-and-forget delegated
 * tasks in child Pi processes living in real Herdr panes.
 *
 * Launch protocol (Herdr >= 0.9):
 *
 *   tab create --env K=V --no-focus     a background tab whose shell carries the
 *                                       child-mode environment
 *   agent start <name> --kind pi -- …   Herdr launches Pi and returns only once it
 *                                       recognizes an interactive, ready agent
 *   agent prompt <pane> <task>          ordered paste + Enter; waits until Herdr
 *                                       observes the turn start
 *
 * Profiles with `worktree: true` first create a Herdr-managed Git worktree
 * workspace on a fresh branch and run the child there.
 *
 * Since Pi renders on the alternate screen, pane reads cannot recover scrolled
 * off output. Reported children therefore load this same file in "child mode"
 * and write their final answer to an atomic result file. The parent watches that
 * file (fs.watch plus a slow fallback stat) and probes Herdr only every couple
 * of seconds for blocked state and liveness. The result file, not pane text, is
 * the source of truth.
 *
 * Every run persists a run.json record. Async runs survive /reload (monitors
 * re-attach on session_start), finished runs can be continued with herdr_send
 * (the child session is resumed in a fresh pane), live runs can be interrupted
 * with herdr_interrupt, and old run directories are pruned automatically.
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
import { subagentProfiles, type AgentProfile } from "./lib/subagent-profiles.ts";

const CHILD_ENV = "PI_HERDR_SUBAGENT_CHILD";
const WORKER_CHILD_ENV = "PI_HERDR_WORKER_CHILD";
const RESULT_ENV = "PI_HERDR_SUBAGENT_RESULT";
/**
 * Set to 0 to retain completed blocking subagent tabs for inspection.
 * Blocking subagents otherwise shut down and their Herdr tabs auto-close as
 * soon as the parent has collected the result. Fire-and-forget workers are
 * unaffected and remain open until explicitly closed.
 */
const EXIT_ON_FINISH_ENV = "PI_HERDR_SUBAGENT_EXIT_ON_FINISH";
/** Days to keep finished run directories (sessions, task, result). 0 disables pruning. */
const RETENTION_ENV = "PI_HERDR_SUBAGENT_RETENTION_DAYS";
const DEFAULT_RETENTION_DAYS = 14;
const RUNS_DIR = "herdr-subagents";
const WORKER_RUNS_DIR = "herdr-workers";
const WORKER_PROFILE = "worker";
const ASYNC_RESULT_TYPE = "herdr-async-result";
const ASYNC_WIDGET_ID = "herdr-async";
const DELEGATION_TOOL_NAMES = new Set([
	"herdr_subagent",
	"herdr_worker",
	"herdr_async",
	"herdr_send",
	"herdr_interrupt",
]);
/** Fallback result-file check; fs.watch normally wakes the monitor first. */
const RESULT_CHECK_MS = 1_000;
/** Herdr liveness / blocked-state probe interval. */
const PROBE_INTERVAL_MS = 2_000;
const START_TIMEOUT_MS = 45_000;
const PROMPT_TIMEOUT_MS = 20_000;
const PANE_PREVIEW_LINES = 18;
const PANE_READ_LINES = 60;
const CAPTURE_LINES = 200;
const EXIT_GRACE_MS = 1_500;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

const DelegatedTaskParams = Type.Object({
	agent: Type.String({ description: "Named profile from ~/.pi/agent/agents/*.md" }),
	task: Type.String({ description: "The complete task for the child Pi process" }),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
});
const RunRefParams = Type.Object({
	run: Type.String({ description: "Run id (or unique prefix) reported by a previous herdr_async/herdr_subagent result" }),
});
const SendParams = Type.Object({
	run: Type.String({ description: "Run id (or unique prefix) of a finished herdr_async/herdr_subagent run" }),
	task: Type.String({ description: "The complete follow-up message for the resumed child session" }),
});

type RunKind = "blocking" | "async" | "worker";
type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "dispatched";
type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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
	workspaceId: string;
	tabId: string;
	paneId: string;
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
	resumedFrom?: string;
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
	workspaceId: string;
	tabId: string;
	paneId: string;
	resultPath?: string;
	sessionFile?: string;
	worktree?: WorktreeInfo;
	status: RunStatus;
	delivered?: boolean;
	resumedFrom?: string;
	startedAt: number;
	finishedAt?: number;
}

interface LiveRun {
	record: RunRecord;
	details: RunDetails;
	controller: AbortController;
	/** Set when monitoring stops for /reload; the child keeps running. */
	detached?: boolean;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shortId(id: string): string {
	return id.replace(/-/g, "").slice(0, 8);
}

/* -------------------------------------------------------------------------- */
/* herdr CLI                                                                   */
/* -------------------------------------------------------------------------- */

interface HerdrEnvelope {
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

class NonRetryableSubagentError extends Error {}

class HerdrError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
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

function pick(record: unknown, key: string): unknown {
	return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
}

function pickString(record: unknown, key: string): string | undefined {
	const value = pick(record, key);
	return typeof value === "string" ? value : undefined;
}

type AgentProbe =
	| { state: "alive"; status: AgentStatus; sessionFile?: string }
	| { state: "gone" }
	| { state: "unknown" };

/** Herdr's view of the pane occupant: alive (with lifecycle state), gone, or unknown (transient error). */
async function probeAgent(pi: ExtensionAPI, paneId: string): Promise<AgentProbe> {
	try {
		const result = await herdrJson(pi, ["agent", "get", paneId], { timeout: 10_000 });
		const agent = pick(result, "agent");
		const status = (pickString(agent, "agent_status") ?? "unknown") as AgentStatus;
		const session = pick(agent, "agent_session");
		const sessionFile = pickString(session, "kind") === "path" ? pickString(session, "value") : undefined;
		return { state: "alive", status, sessionFile };
	} catch (error) {
		if (error instanceof HerdrError && (error.code === "agent_not_found" || error.code === "pane_not_found")) {
			return { state: "gone" };
		}
		return { state: "unknown" };
	}
}

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
 * Create a Herdr-managed worktree workspace for one run. Returns undefined when
 * the working directory is not inside a Git repository.
 */
async function createWorktree(
	pi: ExtensionAPI,
	sourceCwd: string,
	branch: string,
	label: string,
	options: { existingBranch?: boolean } = {},
): Promise<{ info: WorktreeInfo; cwd: string; rootTabId?: string } | undefined> {
	const top = await git(pi, sourceCwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.out) return undefined;
	const repoRoot = top.out;
	let base: string;
	let existingBranch = false;
	if (options.existingBranch) {
		const head = await git(pi, repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
		existingBranch = head.ok;
		base = head.out;
	}
	if (!existingBranch) {
		const head = await git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);
		if (!head.ok) {
			throw new Error(`Worktree isolation needs a Git repository with at least one commit: ${repoRoot}`);
		}
		base = head.out;
	}

	const args = ["worktree", "create", "--cwd", repoRoot, "--branch", branch, "--label", label, "--no-focus"];
	if (!existingBranch) args.push("--base", base!);
	const result = await herdrJson(pi, args, { timeout: 60_000 });
	const worktree = pick(result, "worktree");
	const workspace = pick(result, "workspace");
	const tab = pick(result, "tab");
	const checkout = pickString(worktree, "path") ?? pickString(pick(workspace, "worktree"), "checkout_path");
	if (!checkout) throw new Error("herdr worktree create did not return a checkout path.");
	const relative = path.relative(repoRoot, sourceCwd);
	const cwd = relative && !relative.startsWith("..") ? path.join(checkout, relative) : checkout;
	return {
		info: {
			repoRoot,
			path: checkout,
			branch,
			base: base!,
			workspaceId: pickString(workspace, "workspace_id"),
			state: "active",
		},
		cwd: existsSync(cwd) ? cwd : checkout,
		rootTabId: pickString(tab, "tab_id"),
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
 * checkout (or one that cannot be inspected) is always retained.
 */
async function releaseWorktree(pi: ExtensionAPI, info: WorktreeInfo): Promise<WorktreeInfo> {
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
					`[herdr-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
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
		// The parent closes the Herdr tab after collecting the result. Shutting Pi
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

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents. */
function agentNameFor(id: string, prefix = "sub"): string {
	return `${prefix}-${shortId(id)}`;
}

function tabLabelFor(task: string, prefix = "sub"): string {
	const firstLine = task.trim().split("\n", 1)[0] ?? "";
	const compact = firstLine.replace(/\s+/g, " ").trim();
	const label = compact.length > 28 ? `${compact.slice(0, 27)}…` : compact;
	return `${prefix}: ${label || "task"}`;
}

function detailsFromRecord(record: RunRecord, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	return {
		status,
		task: record.task,
		cwd: record.cwd,
		workspaceId: record.workspaceId,
		tabId: record.tabId,
		paneId: record.paneId,
		agentName: record.agentName,
		attachCommand: record.tabId ? `herdr tab focus ${record.tabId}` : "",
		captureCommand: record.paneId
			? `herdr pane read ${record.paneId} --source recent-unwrapped --lines ${CAPTURE_LINES}`
			: "",
		killCommand: record.tabId ? `herdr tab close ${record.tabId}` : "",
		provider: record.provider,
		model: record.model,
		thinking: record.thinking,
		runId: record.id,
		profile: record.profile,
		worktree: record.worktree,
		resumedFrom: record.resumedFrom,
		startedAt: record.startedAt,
		...extra,
	};
}

const RUN_STATUSES = new Set<RunStatus>(["queued", "running", "completed", "failed", "cancelled", "dispatched"]);
const AGENT_STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "done", "unknown"]);
const RUN_DETAIL_STRINGS = [
	"task",
	"cwd",
	"workspaceId",
	"tabId",
	"paneId",
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

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent ${details.status} in herdr pane ${details.paneId} (tab ${details.tabId})${details.runId ? `, run ${shortId(details.runId)}` : ""}.`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	];
	if (details.worktree) lines.push(`Worktree: ${details.worktree.path} (branch ${details.worktree.branch})`);
	if (details.agentStatus === "blocked") {
		lines.push(`herdr reports the child is BLOCKED and waiting for input. Attach to answer it.`);
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
	if (details.runId) {
		lines.push(
			`Run: ${shortId(details.runId)}${details.resumedFrom ? ` (continues ${shortId(details.resumedFrom)})` : ""} — continue with herdr_send`,
		);
	}
	if (details.stopReason) lines.push(`Stop reason: ${details.stopReason}`);
	if (details.error) lines.push(`Error: ${details.error}`);
	lines.push(
		details.autoClosed
			? `herdr: pane ${details.paneId}, tab ${details.tabId} (auto-closed)`
			: `herdr: pane ${details.paneId}, tab ${details.tabId}, agent ${details.agentName}`,
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

export function isRetryableProviderFailure(value: ChildResult | Error | string): boolean {
	if (typeof value === "object" && value !== null && !(value instanceof Error)) {
		return value.failureKind === "provider";
	}
	const message = typeof value === "string" ? value : value.message;
	return /(?:\b401\b|\b403\b|\b429\b|\b5\d\d\b|rate.?limit|temporar(?:y|ily)|provider.*(?:startup|unavailable)|unknown (?:provider|model)|authentication|unauthori[sz]ed|model.*(?:not found|unavailable)|connection (?:refused|reset)|timed? out)/i.test(
		message,
	);
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

/** Create a background tab whose shell carries the child environment. */
async function createChildTab(
	pi: ExtensionAPI,
	options: { workspaceId?: string; cwd: string; label: string; env: Record<string, string> },
): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
	const env = Object.entries(options.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	const workspaceId = options.workspaceId ?? process.env.HERDR_WORKSPACE_ID;
	if (workspaceId) {
		const result = await herdrJson(pi, [
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			options.cwd,
			"--label",
			options.label,
			...env,
			"--no-focus",
		]);
		const paneId = pickString(pick(result, "root_pane"), "pane_id");
		const tabId = pickString(pick(result, "tab"), "tab_id");
		if (!paneId || !tabId) throw new Error("herdr tab create did not return a pane id.");
		return { workspaceId, tabId, paneId };
	}

	// Not running inside a herdr pane: park children in their own workspace.
	const result = await herdrJson(pi, [
		"workspace",
		"create",
		"--cwd",
		options.cwd,
		"--label",
		options.label,
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
async function startChild(
	pi: ExtensionAPI,
	paneId: string,
	agentName: string,
	piArgs: string[],
	task: string,
	submit = true,
): Promise<void> {
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
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			if (started || startAbort.signal.aborted) return;
			try {
				const info = pick(await herdrJson(pi, ["pane", "process-info", "--pane", paneId], { timeout: 5_000 }), "process_info");
				const foreground = pick(info, "foreground_process_group_id");
				const shell = pick(info, "shell_pid");
				if (typeof foreground !== "number" || typeof shell !== "number") continue;
				if (foreground !== shell) {
					sawChild = true;
					shellPolls = 0;
					continue;
				}
				// A Pi that dies instantly may never be observed; two consecutive
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
			["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--timeout", String(START_TIMEOUT_MS), "--", ...piArgs],
			{ timeout: START_TIMEOUT_MS + 10_000, signal: startAbort.signal },
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
	if (!submit) return;
	await herdrJson(
		pi,
		[
			"agent",
			"prompt",
			paneId,
			task,
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
/** Pi never became ready (bad model/provider, auth, crash): eligible for model fallback. */
class ChildStartupError extends Error {}

/**
 * Wait for the child's result file. fs.watch wakes the loop on writes; Herdr is
 * probed every PROBE_INTERVAL_MS for blocked state and liveness only.
 */
async function monitorChild(
	pi: ExtensionAPI,
	options: {
		resultPath: string;
		paneId: string;
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
				const probe = await probeAgent(pi, options.paneId);
				const paneText = options.readPane ? await herdrPaneRead(pi, options.paneId, PANE_READ_LINES) : undefined;
				let changed = false;
				if (probe.state === "alive") {
					goneSince = undefined;
					if (probe.sessionFile) progress.sessionFile = probe.sessionFile;
					if (probe.status !== progress.agentStatus) {
						progress.agentStatus = probe.status;
						changed = true;
					}
				} else if (probe.state === "gone") {
					goneSince ??= Date.now();
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
					const finalPane = (await herdrPaneRead(pi, options.paneId, 30)) ?? "";
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

function runRoot(kind: RunKind): string {
	return path.join(getAgentDir(), kind === "worker" ? WORKER_RUNS_DIR : RUNS_DIR);
}

function runDirFor(kind: RunKind, parentSessionId: string, id: string): string {
	return path.join(runRoot(kind), parentSessionId, id);
}

async function saveRecord(record: RunRecord): Promise<void> {
	try {
		await writeJsonAtomic(path.join(runDirFor(record.kind, record.parentSessionId, record.id), "run.json"), record);
	} catch (error) {
		console.error(`[herdr-subagent] Failed to save run record: ${error instanceof Error ? error.message : String(error)}`);
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
	const roots = options.roots ?? [path.join(getAgentDir(), RUNS_DIR), path.join(getAgentDir(), WORKER_RUNS_DIR)];
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

export default function herdrSubagentExtension(pi: ExtensionAPI): void {
	// Fire-and-forget workers load this extension only so it can suppress all
	// parent-only delegation tools in the child process.
	if (process.env[WORKER_CHILD_ENV] === "1") return;

	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[herdr-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		return;
	}

	/** Blocking-run tabs; always closed on shutdown because their tool call is gone. */
	const blockingTabs = new Set<string>();
	/** Live async and blocking runs, keyed by run id. */
	const liveRuns = new Map<string, LiveRun>();
	/** Records known to this session (finished runs are kept for herdr_send). */
	const knownRecords = new Map<string, RunRecord>();
	let shuttingDown = false;
	let currentCtx: ExtensionContext | undefined;

	const asyncRuns = () => [...liveRuns.values()].filter((run) => run.record.kind === "async");

	const updateAsyncWidget = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI || shuttingDown) return;
		const runs = asyncRuns();
		if (runs.length === 0) {
			ctx.ui.setWidget(ASYNC_WIDGET_ID, undefined);
			return;
		}
		const lines = [`Async Herdr subagents (${runs.length})`];
		for (const run of runs) {
			const status =
				run.details.agentStatus === "blocked"
					? "blocked · needs input"
					: (run.details.agentStatus ?? run.details.status);
			const worktree = run.record.worktree ? ` · ${run.record.worktree.branch}` : "";
			lines.push(`  ${shortId(run.record.id)} ${run.record.profile} · ${status}${worktree} · ${run.details.attachCommand}`);
		}
		ctx.ui.setWidget(ASYNC_WIDGET_ID, lines);
	};

	const remember = (record: RunRecord): void => {
		knownRecords.set(record.id, record);
	};

	const findRecord = (ref: string): RunRecord => {
		const needle = ref.trim().toLowerCase().replace(/-/g, "");
		if (!needle) throw new Error("A run id is required.");
		const matches = [...knownRecords.values()].filter((record) => record.id.replace(/-/g, "").startsWith(needle));
		if (matches.length === 1) return matches[0]!;
		const available = [...knownRecords.values()]
			.slice(-10)
			.map((record) => `${shortId(record.id)} (${record.profile}, ${record.status})`)
			.join(", ");
		if (matches.length > 1) throw new Error(`Run id "${ref}" is ambiguous. Known runs: ${available}.`);
		throw new Error(`Unknown run "${ref}". Known runs in this session: ${available || "(none)"}.`);
	};

	const deliverAsyncResult = async (run: LiveRun, details: RunDetails): Promise<void> => {
		if (shuttingDown || run.controller.signal.aborted || run.record.delivered) return;
		const outcome = details.status === "completed" ? "completed" : "failed";
		run.record.delivered = true;
		await saveRecord(run.record);
		pi.sendMessage(
			{
				customType: ASYNC_RESULT_TYPE,
				content: truncateToolText(`Async Herdr subagent "${run.record.profile}" ${outcome}.\n\n${resultText(details)}`),
				display: true,
				details: { ...details, runId: run.record.id, profile: run.record.profile },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	/** Close a run's tab; true once the tab is known to be gone. */
	const closeTab = async (tabId: string): Promise<boolean> => {
		if (!tabId) return true;
		try {
			await herdrOk(pi, ["tab", "close", tabId], { timeout: 10_000 });
			blockingTabs.delete(tabId);
			return true;
		} catch (error) {
			if (error instanceof HerdrError && error.code === "tab_not_found") {
				blockingTabs.delete(tabId);
				return true;
			}
			return false;
		}
	};

	/**
	 * Final bookkeeping for a settled child: close its tab, release any worktree,
	 * and build the reported details.
	 */
	const settle = async (
		record: RunRecord,
		outcome: { result?: ChildResult; error?: string; progress: MonitorProgress },
		options: { autoClose: boolean },
	): Promise<RunDetails> => {
		const result = outcome.result;
		const status: RunStatus = result ? (result.status === "completed" ? "completed" : "failed") : "failed";
		let worktree = record.worktree;
		let autoClosed = false;
		const liveWorktree = worktree && worktree.state !== "removed" && existsSync(worktree.path);
		if (options.autoClose) {
			// A dirty worktree keeps its tab so the checkout stays one click away.
			if (worktree && liveWorktree) {
				const inspected = await inspectWorktree(pi, worktree);
				if (inspected.dirty) {
					worktree = { ...inspected, state: "retained", note: "Uncommitted changes; checkout and tab retained for inspection." };
				} else {
					autoClosed = await closeTab(record.tabId);
					worktree = await releaseWorktree(pi, worktree);
				}
			} else {
				autoClosed = await closeTab(record.tabId);
			}
		} else {
			blockingTabs.delete(record.tabId); // Hand the settled tab over to the user.
			if (worktree && liveWorktree) worktree = { ...(await inspectWorktree(pi, worktree)), state: "active" };
		}

		record.status = status;
		record.finishedAt = result?.finishedAt ?? Date.now();
		record.sessionFile = result?.sessionFile ?? outcome.progress.sessionFile ?? record.sessionFile;
		record.worktree = worktree;
		if (result?.provider) record.provider = result.provider;
		if (result?.model) record.model = result.model;
		if (result?.thinking) record.thinking = result.thinking;
		await saveRecord(record);
		remember(record);

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
		autoClose: boolean;
		readPane: boolean;
		resume?: RunRecord;
		onLaunched?: (run: LiveRun) => void;
		onProgress?: (details: RunDetails) => void;
	}

	/**
	 * Launch a child (with ordered model fallback), wait for its result, and
	 * settle it. Shared by blocking and async runs. Errors before the first
	 * successful launch propagate; later failures resolve as failed details.
	 */
	const executeRun = async (options: ExecuteOptions): Promise<{ details: RunDetails; record: RunRecord }> => {
		const { profile, ctx } = options;
		const thinking = profile.thinking ?? pi.getThinkingLevel();
		const childTools = resolveChildTools(pi, profile.tools ?? pi.getActiveTools(), profile.name);
		const candidates = options.resume ? [`${options.resume.provider}/${options.resume.model}`] : modelCandidates(profile);
		const parentSessionId = ctx.sessionManager.getSessionId();
		const id = randomUUID();
		const runDir = runDirFor(options.kind, parentSessionId, id);
		const sessionDir = path.join(runDir, "session");
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		const trusted = isSameOrDescendant(path.resolve(ctx.cwd), options.sourceCwd) && ctx.isProjectTrusted();

		// Isolation: a fresh worktree per run, or the previous run's branch on resume.
		let worktree: WorktreeInfo | undefined;
		let cwd = options.sourceCwd;
		let worktreeRootTab: string | undefined;
		let isolationNote = "";
		const previousWorktree = options.resume?.worktree;
		if (previousWorktree && existsSync(previousWorktree.path)) {
			worktree = { ...previousWorktree, state: "active", note: undefined, workspaceId: undefined };
			cwd = existsSync(options.resume!.cwd) ? options.resume!.cwd : previousWorktree.path;
		} else if (previousWorktree || (!options.resume && profile.worktree)) {
			const branch = previousWorktree?.branch ?? branchFor(profile.name, id);
			const created = await createWorktree(
				pi,
				previousWorktree?.repoRoot ?? options.sourceCwd,
				branch,
				tabLabelFor(options.task, profile.name),
				{ existingBranch: Boolean(previousWorktree) },
			);
			if (created) {
				worktree = previousWorktree ? { ...created.info, base: previousWorktree.base } : created.info;
				cwd = created.cwd;
				worktreeRootTab = created.rootTabId;
			} else {
				isolationNote = "Note: worktree isolation was requested but the directory is not a Git repository; ran in place.";
			}
		}
		const task = worktree && !options.resume ? `${options.task}${worktreeNote(worktree)}` : options.task;
		await writeFile(path.join(runDir, "task.md"), `${task}\n`, { encoding: "utf8", mode: 0o600 });

		const record: RunRecord = {
			version: 1,
			id,
			kind: options.kind,
			profile: profile.name,
			parentSessionId,
			task: options.task,
			sourceCwd: options.sourceCwd,
			cwd,
			provider: "",
			model: "",
			thinking,
			tools: childTools,
			agentName: agentNameFor(id, options.kind === "async" ? "async" : "sub"),
			workspaceId: "",
			tabId: "",
			paneId: "",
			worktree,
			status: "queued",
			resumedFrom: options.resume?.id,
			startedAt: Date.now(),
		};

		let live: LiveRun | undefined;
		let launchedOnce = false;
		/** A failed attempt's tab, closed only after its replacement exists (a worktree workspace closes with its last tab). */
		let staleTab: string | undefined;
		try {
			for (let index = 0; index < candidates.length; index++) {
				const selected = resolveModel(ctx, undefined, candidates[index]);
				const resultPath = path.join(runDir, index === 0 ? "result.json" : `result.${index}.json`);
				record.provider = selected.provider;
				record.model = selected.model;
				record.resultPath = resultPath;
				record.agentName = agentNameFor(index === 0 ? id : randomUUID(), options.kind === "async" ? "async" : "sub");

				const piArgs = [
					"--provider",
					selected.provider,
					"--model",
					selected.model,
					"--thinking",
					thinking,
					...(childTools.length > 0 ? ["--tools", childTools.join(",")] : ["--no-tools"]),
					...(options.resume?.sessionFile ? ["--session", options.resume.sessionFile] : ["--session-dir", sessionDir]),
					"--name",
					record.agentName,
					trusted ? "--approve" : "--no-approve",
					"--extension",
					EXTENSION_PATH,
				];

				options.signal.throwIfAborted();
				const created = await createChildTab(pi, {
					workspaceId: worktree?.workspaceId,
					cwd,
					label: tabLabelFor(options.task, options.kind === "async" ? "async" : "sub"),
					env: {
						[CHILD_ENV]: "1",
						[RESULT_ENV]: resultPath,
						[EXIT_ON_FINISH_ENV]: options.autoClose ? "1" : "0",
					},
				});
				for (const tab of [worktreeRootTab, staleTab]) if (tab) await closeTab(tab);
				worktreeRootTab = undefined;
				staleTab = undefined;
				record.workspaceId = created.workspaceId;
				record.tabId = created.tabId;
				record.paneId = created.paneId;
				record.status = "running";
				if (options.kind === "blocking") blockingTabs.add(created.tabId);

				const details = () => live?.details ?? detailsFromRecord(record, "running");
				let result: ChildResult | undefined;
				let failure: Error | undefined;
				let progress: MonitorProgress = {};
				try {
					await startChild(pi, created.paneId, record.agentName, piArgs, task);
					options.signal.throwIfAborted();
					await saveRecord(record);
					remember(record);
					if (!live) {
						live = {
							record,
							details: detailsFromRecord(record, "running"),
							controller: new AbortController(),
						};
						liveRuns.set(id, live);
					} else {
						live.details = detailsFromRecord(record, "running");
					}
					if (!launchedOnce) {
						launchedOnce = true;
						options.onLaunched?.(live);
					}
					options.onProgress?.(details());
					const combined = AbortSignal.any([options.signal, live.controller.signal]);
					const monitored = await monitorChild(pi, {
						resultPath,
						paneId: created.paneId,
						signal: combined,
						readPane: options.readPane,
						onProgress: (update) => {
							progress = update;
							live!.details = detailsFromRecord(record, "running", {
								pane: update.pane,
								agentStatus: update.agentStatus,
							});
							options.onProgress?.(live!.details);
						},
					});
					result = monitored.result;
					progress = monitored.progress;
				} catch (error) {
					if (options.signal.aborted || live?.controller.signal.aborted) {
						// Session shutdown closes its own tabs; a reload keeps them running.
						if (!live?.detached && !shuttingDown) await closeTab(created.tabId);
						throw error;
					}
					failure = error instanceof Error ? error : new Error(String(error));
				}

				const hasNext = index + 1 < candidates.length;
				const retryable =
					hasNext &&
					(result
						? result.status === "failed" && isRetryableProviderFailure(result)
						: failure instanceof ChildStartupError ||
							(failure !== undefined && !(failure instanceof ChildExitedError) && isRetryableProviderFailure(failure)));
				if (retryable) {
					if (worktree?.workspaceId) staleTab = created.tabId;
					else await closeTab(created.tabId);
					continue;
				}
				if (!launchedOnce && failure) {
					await closeTab(created.tabId);
					throw failure;
				}
				const settled = await settle(record, { result, error: failure?.message, progress }, {
					autoClose: options.autoClose,
				});
				if (isolationNote) settled.error = settled.error ? `${settled.error}\n${isolationNote}` : isolationNote;
				if (live) live.details = settled;
				return { details: settled, record };
			}
			throw new Error("Every model candidate failed.");
		} catch (error) {
			if (staleTab) await closeTab(staleTab);
			if (worktree && !live?.detached) {
				// Launch failure or abort: drop a clean checkout (dirty ones are retained).
				if (worktreeRootTab) await closeTab(worktreeRootTab);
				record.worktree = await releaseWorktree(pi, worktree);
				if (launchedOnce) await saveRecord(record);
			}
			throw error;
		} finally {
			if (live && !live.detached) liveRuns.delete(id);
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
		resume?: RunRecord,
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
			autoClose: true,
			readPane: false,
			resume,
			onLaunched: (run) => {
				liveRun = run;
				run.controller = background;
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

	/** Re-attach monitors to async runs that survived /reload (or a crash). */
	const reattach = async (ctx: ExtensionContext): Promise<void> => {
		const records = await loadSessionRecords(ctx.sessionManager.getSessionId());
		for (const record of records) {
			remember(record);
			if (record.kind !== "async" || record.delivered || liveRuns.has(record.id)) continue;
			if (record.status !== "running" && record.status !== "completed" && record.status !== "failed") continue;
			const run: LiveRun = {
				record,
				details: detailsFromRecord(record, "running"),
				controller: new AbortController(),
			};
			liveRuns.set(record.id, run);
			void (async () => {
				let details: RunDetails;
				try {
					if (!record.resultPath || !record.paneId) throw new Error("Run record is incomplete.");
					const monitored = await monitorChild(pi, {
						resultPath: record.resultPath,
						paneId: record.paneId,
						signal: run.controller.signal,
						readPane: false,
						onProgress: (update) => {
							run.details = detailsFromRecord(record, "running", { agentStatus: update.agentStatus });
							updateAsyncWidget(currentCtx);
						},
					});
					details = await settle(record, { result: monitored.result, progress: monitored.progress }, { autoClose: true });
				} catch (error) {
					if (run.controller.signal.aborted) return;
					details = await settle(
						record,
						{ error: error instanceof Error ? error.message : String(error), progress: {} },
						{ autoClose: true },
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
				console.error(`[herdr-subagent] Re-attach failed: ${error instanceof Error ? error.message : String(error)}`),
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
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nAgent profiles: A valid &name reference is the user's explicit request to delegate asynchronously with that profile. Route every valid &name through herdr_async, including &worker. Compose a complete, self-contained task for every child. Do not add model, thinking, or tool overrides; the profile owns them. The caller controls the number and ordering of calls unless the user explicitly requests references or parallelism. Use herdr_subagent only for a parent-selected blocking dependency, and herdr_worker only when no automatic result is wanted. Continue a finished run's conversation with herdr_send (using its run id) instead of re-explaining context to a fresh child; stop a live run's current turn with herdr_interrupt." +
				(isolated.length
					? ` Profiles ${isolated.join(", ")} run in isolated Git worktrees on their own branch and do not see uncommitted parent changes; review the reported commits, then integrate the branch yourself.`
					: ""),
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | undefined)?.reason;
		shuttingDown = true;
		if (reason === "reload") {
			// Keep async children running; the reloaded extension re-attaches.
			for (const run of liveRuns.values()) {
				if (run.record.kind !== "async") continue;
				run.detached = true;
				run.controller.abort();
			}
		} else {
			for (const run of liveRuns.values()) {
				if (run.record.kind !== "async") continue;
				run.controller.abort();
				run.record.status = "cancelled";
				run.record.delivered = true;
				await saveRecord(run.record);
				await closeTab(run.record.tabId);
			}
		}
		liveRuns.clear();
		if (ctx?.hasUI) ctx.ui.setWidget(ASYNC_WIDGET_ID, undefined);
		const tabs = [...blockingTabs];
		blockingTabs.clear();
		await Promise.allSettled(tabs.map((tab) => pi.exec("herdr", ["tab", "close", tab], { timeout: 10_000 })));
	});

	pi.registerCommand?.("herdr-prune", {
		description: `Delete Herdr subagent run directories older than N days (default ${DEFAULT_RETENTION_DAYS}, or $${RETENTION_ENV})`,
		handler: async (args: string, ctx: ExtensionContext) => {
			const days = args.trim() ? Number(args.trim()) : retentionDays() || DEFAULT_RETENTION_DAYS;
			if (!Number.isFinite(days) || days < 0) {
				ctx.ui.notify("Usage: /herdr-prune [days]", "error");
				return;
			}
			const removed = await pruneRunDirs(days === 0 ? Number.MIN_VALUE : days, {
				keepSessionId: ctx.sessionManager.getSessionId(),
			});
			ctx.ui.notify(`Removed ${removed} Herdr subagent run director${removed === 1 ? "y" : "ies"}.`, "info");
		},
	});

	const allProfileNames = subagentProfiles.listSync().map((profile) => profile.name);
	const availableProfileNames = allProfileNames.filter((name) => name.toLowerCase() !== WORKER_PROFILE);

	pi.registerTool({
		name: "herdr_worker",
		label: "Herdr Worker",
		description:
			"Dispatch one implementation task to the fixed worker profile in a separate Pi process. Fire-and-forget: returns the Herdr tab, pane, attach, capture, and cleanup commands (plus worktree branch when the profile is isolated) as soon as the child is running, without waiting for or polling the result.",
		promptSnippet: "Dispatch an implementation task to a fire-and-forget worker in Herdr",
		promptGuidelines: [
			"Use herdr_worker only when a self-contained implementation task needs no automatic completion result.",
			"Prefer herdr_async with the worker profile when the parent should receive and process the worker's final result.",
			"herdr_worker returns immediately and does not retrieve the worker result; use its attach or capture command to inspect the child.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete implementation task for the worker Pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Worker task must not be empty.");
			if (signal?.aborted) throw new Error("Worker dispatch aborted.");

			const profile = await subagentProfiles.get(WORKER_PROFILE);
			const sourceCwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const thinking = profile.thinking ?? pi.getThinkingLevel();
			const selectedModel = resolveModel(ctx, undefined, modelCandidates(profile)[0]);
			const childTools = resolveChildTools(pi, profile.tools ?? pi.getActiveTools(), profile.name);
			await validateCwd(sourceCwd);

			const id = randomUUID();
			const parentSessionId = ctx.sessionManager.getSessionId();
			const runDir = runDirFor("worker", parentSessionId, id);
			const sessionDir = path.join(runDir, "session");
			await mkdir(sessionDir, { recursive: true, mode: 0o700 });

			let cwd = sourceCwd;
			let worktree: WorktreeInfo | undefined;
			let rootTab: string | undefined;
			if (profile.worktree) {
				const created = await createWorktree(pi, sourceCwd, branchFor(profile.name, id), tabLabelFor(params.task, "worker"));
				if (created) {
					worktree = created.info;
					cwd = created.cwd;
					rootTab = created.rootTabId;
				}
			}
			const task = worktree ? `${params.task}${worktreeNote(worktree)}` : params.task;
			await writeFile(path.join(runDir, "task.md"), `${task}\n`, { encoding: "utf8", mode: 0o600 });

			const agentName = agentNameFor(id, "worker");
			const trusted = isSameOrDescendant(path.resolve(ctx.cwd), sourceCwd) && ctx.isProjectTrusted();
			const piArgs = [
				"--provider",
				selectedModel.provider,
				"--model",
				selectedModel.model,
				"--thinking",
				thinking,
				...(childTools.length > 0 ? ["--tools", childTools.join(",")] : ["--no-tools"]),
				"--session-dir",
				sessionDir,
				"--name",
				agentName,
				trusted ? "--approve" : "--no-approve",
				"--extension",
				EXTENSION_PATH,
			];

			const created = await createChildTab(pi, {
				workspaceId: worktree?.workspaceId,
				cwd,
				label: tabLabelFor(params.task, "worker"),
				env: { [WORKER_CHILD_ENV]: "1" },
			});
			if (rootTab) await closeTab(rootTab);
			try {
				await startChild(pi, created.paneId, agentName, piArgs, task);
			} catch (error) {
				await closeTab(created.tabId);
				if (worktree) await releaseWorktree(pi, worktree);
				throw error;
			}

			const record: RunRecord = {
				version: 1,
				id,
				kind: "worker",
				profile: profile.name,
				parentSessionId,
				task: params.task,
				sourceCwd,
				cwd,
				provider: selectedModel.provider,
				model: selectedModel.model,
				thinking,
				tools: childTools,
				agentName,
				workspaceId: created.workspaceId,
				tabId: created.tabId,
				paneId: created.paneId,
				worktree,
				status: "dispatched",
				startedAt: Date.now(),
			};
			await saveRecord(record);

			const details = detailsFromRecord(record, "dispatched");
			const text = [
				`Worker dispatched in Herdr tab ${created.tabId}, pane ${created.paneId}.`,
				`Attach: ${details.attachCommand}`,
				`Capture: ${details.captureCommand}`,
				`Clean up: ${details.killCommand}`,
				...(worktree
					? [`Worktree: ${worktree.path} (branch ${worktree.branch}); remove it yourself once integrated.`]
					: []),
			].join("\n");
			return { content: [{ type: "text", text }], details };
		},
	});

	const asyncTool = {
		name: "herdr_async",
		label: "Herdr Async",
		description: `Dispatch one asynchronous delegated task using a named agent profile. Available profiles: ${allProfileNames.length ? allProfileNames.join(", ") : "(none)"}. Returns Herdr coordinates and a run id once the child is running, monitors it in the background, and automatically steers its bounded final result back into this session. Ordered model fallback applies. Profiles marked worktree run on their own Git branch. Async runs survive /reload and are cancelled when the parent session ends.`,
		promptSnippet: "Dispatch a background Herdr subagent whose result returns automatically",
		promptGuidelines: [
			"Route every explicit &name agent reference through herdr_async, including &worker.",
			"Use herdr_async when delegated work can run independently while the parent continues useful work.",
			"Provide herdr_async a named agent profile and a complete, self-contained task.",
			"Do not poll a herdr_async run; its completion or failure is automatically steered into the parent session.",
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
				`Async ${profile.name} dispatched in Herdr tab ${details.tabId}, pane ${details.paneId} (run ${shortId(run.record.id)}).`,
				"Its completion or failure will be delivered automatically; do not poll it.",
				`Attach: ${details.attachCommand}`,
				`Capture: ${details.captureCommand}`,
				`Interrupt: herdr_interrupt run=${shortId(run.record.id)}`,
				...(run.record.worktree
					? [`Worktree: ${run.record.worktree.path} (branch ${run.record.worktree.branch})`]
					: []),
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
				theme.fg("toolTitle", theme.bold(`herdr async ${args.agent || "subagent"} `)) + theme.fg("dim", preview),
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

	pi.registerTool({
		name: "herdr_send",
		label: "Herdr Send",
		description:
			"Continue a finished herdr_async or herdr_subagent run: resumes that child's Pi session (same profile, model, and worktree branch) in a fresh Herdr pane, submits the follow-up message, and delivers the result asynchronously like herdr_async.",
		promptSnippet: "Send a follow-up to a finished Herdr subagent run, resuming its session",
		promptGuidelines: [
			"Use herdr_send to ask a finished subagent run for corrections or more detail instead of starting a fresh child that lacks its context.",
		],
		parameters: SendParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Follow-up message must not be empty.");
			currentCtx ??= ctx;
			const previous = findRecord(params.run);
			if (liveRuns.has(previous.id)) {
				throw new Error(`Run ${shortId(previous.id)} is still running. Wait for its result or use herdr_interrupt.`);
			}
			if (previous.kind === "worker") throw new Error("Fire-and-forget worker runs cannot be continued with herdr_send.");
			if (!previous.sessionFile || !existsSync(previous.sessionFile)) {
				throw new Error(`Run ${shortId(previous.id)} has no child session file to resume.`);
			}
			const profile = await subagentProfiles.get(previous.profile).catch(() => ({ name: previous.profile }) as AgentProfile);
			const resumeProfile: AgentProfile = { ...profile, thinking: previous.thinking as AgentProfile["thinking"] };
			const run = await startAsync(resumeProfile, params.task, previous.sourceCwd, signal, ctx, previous);
			const text = [
				`Follow-up dispatched to ${previous.profile} as run ${shortId(run.record.id)} (continues ${shortId(previous.id)}) in Herdr tab ${run.details.tabId}.`,
				"Its result will be delivered automatically; do not poll it.",
				`Attach: ${run.details.attachCommand}`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { ...run.details, runId: run.record.id } };
		},
	});

	pi.registerTool({
		name: "herdr_interrupt",
		label: "Herdr Interrupt",
		description:
			"Interrupt the current turn of a live herdr_async/herdr_subagent run (sends Escape to the child Pi). The child then settles and its partial result is delivered as an interrupted run.",
		promptSnippet: "Interrupt a running Herdr subagent's current turn",
		promptGuidelines: ["Use herdr_interrupt to stop a live subagent that is off track; its partial result still arrives."],
		parameters: RunRefParams,
		async execute(_toolCallId, params) {
			const record = findRecord(params.run);
			const live = liveRuns.get(record.id);
			if (!live) throw new Error(`Run ${shortId(record.id)} is not running (status: ${record.status}).`);
			await herdrOk(pi, ["agent", "send-keys", live.record.paneId, "esc"]);
			return {
				content: [
					{
						type: "text",
						text: `Interrupt sent to run ${shortId(record.id)} (pane ${live.record.paneId}). Its partial result will be delivered when it settles.`,
					},
				],
				details: { runId: record.id, paneId: live.record.paneId },
			};
		},
	});

	const blockingTool = {
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description: `Run one parent-selected blocking dependency in a separate Pi process using a named non-worker agent profile. Available blocking profiles: ${availableProfileNames.length ? availableProfileNames.join(", ") : "(none)"}. Use herdr_async for explicit &name references and asynchronous worker results; use herdr_worker only for no-result worker dispatch. Profiles are refreshed at call time; sibling calls may run concurrently. Each child is visible and inspectable in Herdr while running, then its tab auto-closes after the result is collected; output is capped at 50KB or 2000 lines.`,
		promptSnippet: "Run one blocking delegated task in an observable herdr pane",
		promptGuidelines: [
			"Use herdr_subagent only when the parent selects a blocking dependency and needs its result before continuing.",
			"Provide herdr_subagent one non-worker profile and a complete, self-contained task; route explicit &name references through herdr_async instead.",
			"Never pass worker to herdr_subagent; use herdr_async with the worker profile for automatic results or herdr_worker for no-result dispatch.",
			"If a run reports that the child is blocked, attach with the printed herdr command and answer it rather than retrying the task.",
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
					"The worker profile is not available to blocking herdr_subagent. Use herdr_async with agent worker for an automatic result, or herdr_worker for no-result dispatch.",
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
			return new Text(theme.fg("toolTitle", theme.bold(`herdr ${args.agent || "subagent"} `)) + theme.fg("dim", preview), 0, 0);
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
			const label = details.agentName || details.paneId || "subagent";
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))}`;
			const state = blocked ? "blocked · needs input" : details.status;
			text += theme.fg("muted", ` · ${state}${duration ? ` · ${duration}` : ""}`);
			text += details.autoClosed
				? `\n  ${theme.fg("dim", "Herdr pane auto-closed")}`
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
