/**
 * herdr-subagent: run one delegated task in a child pi process living in a
 * real herdr pane, observable in the herdr UI while it works.
 *
 * Adapted from mitsuhiko/agent-stuff `extensions/subagent.ts` (tmux backend).
 * The tmux plumbing maps onto herdr as follows:
 *
 *   tmux new-session -d -c cwd   ->  herdr tab create --no-focus --cwd
 *   tmux send-keys -l + Enter    ->  herdr pane run <pane> <command>
 *   tmux capture-pane -p -J      ->  herdr pane read <pane> --source recent-unwrapped
 *   #{pane_dead}                 ->  herdr pane get <pane> (pane_not_found) + exit sentinel
 *   tmux kill-session            ->  herdr tab close <tab>
 *   pi --attach-subagent <id>    ->  herdr tab focus <tab>   (no custom flag needed)
 *
 * herdr also recognizes pi as an agent kind, so the child reports
 * idle/working/blocked into the UI and this tool can tell you when a child is
 * stuck on a question instead of just looking slow.
 *
 * Since pi renders on the alternate screen, pane reads cannot recover scrolled
 * off output. The child therefore loads this same file as an extension in
 * "child mode" and writes its final answer to result.json, which the parent
 * polls. That file, not the pane text, is the source of truth.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { createAgentRefAutocomplete } from "./lib/agent-ref-autocomplete.ts";
import { subagentProfiles } from "./lib/subagent-profiles.ts";

const CHILD_ENV = "PI_HERDR_SUBAGENT_CHILD";
const RESULT_ENV = "PI_HERDR_SUBAGENT_RESULT";
/**
 * Set to 1 to make the child pi shut down as soon as it reports its result.
 * Default (0) leaves the child running in its pane so you can attach and keep
 * talking to it; the parent tool call still returns as soon as result.json
 * lands, and `herdr tab close <tab>` is the cleanup.
 */
const EXIT_ON_FINISH_ENV = "PI_HERDR_SUBAGENT_EXIT_ON_FINISH";
const RUNS_DIR = "herdr-subagents";
const EXIT_SENTINEL_PREFIX = "__pi_herdr_subagent_exit__";
const POLL_INTERVAL_MS = 500;
/** Poll herdr's agent lifecycle state every N pane polls (it changes slowly). */
const AGENT_STATUS_EVERY = 4;
const PANE_PREVIEW_LINES = 18;
const PANE_READ_LINES = 60;
const CAPTURE_LINES = 200;
const EXIT_GRACE_MS = 1_500;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

type RunStatus = "queued" | "running" | "completed" | "failed";
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
	agentStatus?: AgentStatus;
	pane?: string;
	output?: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
}

interface RunSpec {
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
	trusted: boolean;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function exitSentinelFor(runId: string): string {
	return `${EXIT_SENTINEL_PREFIX}${runId.replace(/-/g, "")}`;
}

/** Return the exit code only when the pane contains a complete sentinel line. */
export function parseChildExitCode(output: string, sentinel: string): number | undefined {
	const prefix = `${sentinel} `;
	for (const line of output.replace(/\r/g, "").split("\n")) {
		if (!line.startsWith(prefix)) continue;
		const code = line.slice(prefix.length);
		if (/^\d+$/.test(code)) return Number(code);
	}
	return undefined;
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

/** Run a herdr CLI command that answers with a JSON envelope on stdout. */
async function herdrJson(
	pi: ExtensionAPI,
	args: string[],
	options: { timeout?: number } = {},
): Promise<Record<string, unknown>> {
	const run = await pi.exec("herdr", args, {
		timeout: options.timeout ?? 15_000,
	});
	const raw = run.stdout.trim();
	let envelope: HerdrEnvelope | undefined;
	if (raw) {
		try {
			envelope = JSON.parse(raw) as HerdrEnvelope;
		} catch {
			// Fall through to the generic error below.
		}
	}
	if (envelope?.error) {
		throw new HerdrError(envelope.error.message || "herdr command failed", envelope.error.code);
	}
	if (run.code !== 0 || !envelope?.result) {
		const detail = run.stderr.trim() || raw || `exit code ${run.code}`;
		throw new HerdrError(`herdr ${args.join(" ")} failed: ${detail}`);
	}
	return envelope.result;
}

/** Run a herdr CLI command whose success contract is exit 0, with no JSON output required. */
export async function herdrOk(pi: ExtensionAPI, args: string[], options: { timeout?: number } = {}): Promise<void> {
	const run = await pi.exec("herdr", args, {
		timeout: options.timeout ?? 15_000,
	});
	if (run.code === 0) return;

	for (const raw of [run.stderr.trim(), run.stdout.trim()]) {
		if (!raw) continue;
		try {
			const envelope = JSON.parse(raw) as HerdrEnvelope;
			if (envelope.error) {
				throw new HerdrError(envelope.error.message || "herdr command failed", envelope.error.code);
			}
		} catch (error) {
			if (error instanceof HerdrError) throw error;
			// Preserve non-JSON CLI diagnostics below.
		}
	}

	const detail = run.stderr.trim() || run.stdout.trim() || `exit code ${run.code}`;
	throw new HerdrError(`herdr ${args.slice(0, 3).join(" ")} failed: ${detail}`);
}

/** `herdr pane read` answers with plain text, not JSON. */
async function herdrPaneRead(pi: ExtensionAPI, paneId: string, lines: number): Promise<string | undefined> {
	const run = await pi.exec(
		"herdr",
		["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
		{ timeout: 10_000 },
	);
	if (run.code !== 0) return undefined;
	return run.stdout;
}

function pick(record: unknown, key: string): unknown {
	return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
}

function pickString(record: unknown, key: string): string | undefined {
	const value = pick(record, key);
	return typeof value === "string" ? value : undefined;
}

/** Current agent lifecycle state plus the child's session file, if herdr sees one. */
async function readAgentInfo(
	pi: ExtensionAPI,
	paneId: string,
): Promise<{ status: AgentStatus; sessionFile?: string } | undefined> {
	try {
		const result = await herdrJson(pi, ["agent", "get", paneId], {
			timeout: 10_000,
		});
		const agent = pick(result, "agent");
		const status = pickString(agent, "agent_status");
		const session = pick(agent, "agent_session");
		const sessionFile = pickString(session, "kind") === "path" ? pickString(session, "value") : undefined;
		if (!status) return undefined;
		return { status: status as AgentStatus, sessionFile };
	} catch {
		// No agent detected in the pane (yet), or the pane is gone.
		return undefined;
	}
}

async function paneExists(pi: ExtensionAPI, paneId: string): Promise<boolean> {
	try {
		await herdrJson(pi, ["pane", "get", paneId], { timeout: 10_000 });
		return true;
	} catch (error) {
		if (error instanceof HerdrError && error.code === "pane_not_found") return false;
		// Treat transient failures as "still alive"; the result file decides.
		return true;
	}
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
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
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
					(!assistant ? "Subagent exited without an assistant response." : undefined),
				stopReason,
				sessionFile: ctx.sessionManager.getSessionFile(),
				provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
				model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
				thinking: pi.getThinkingLevel(),
				finishedAt: Date.now(),
				failureKind:
					stopReason === "aborted" || fallbackError
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
		// Opt-in: by default the child stays alive in its pane after reporting so
		// the run can be inspected and continued interactively.
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

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) return [process.execPath, currentScript];
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return [process.execPath];
	return ["pi"];
}

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
function agentNameFor(sessionId: string): string {
	return `sub-${sessionId.replace(/-/g, "").slice(0, 8)}`;
}

function tabLabelFor(task: string): string {
	const firstLine = task.trim().split("\n", 1)[0] ?? "";
	const compact = firstLine.replace(/\s+/g, " ").trim();
	const label = compact.length > 28 ? `${compact.slice(0, 27)}…` : compact;
	return `sub: ${label || "task"}`;
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	return {
		status,
		task: spec.task,
		cwd: spec.cwd,
		workspaceId: spec.workspaceId,
		tabId: spec.tabId,
		paneId: spec.paneId,
		agentName: spec.agentName,
		attachCommand: spec.attachCommand,
		captureCommand: spec.captureCommand,
		killCommand: spec.killCommand,
		provider: spec.provider,
		model: spec.model,
		thinking: spec.thinking,
		...extra,
	};
}

const RUN_STATUSES = new Set<RunStatus>(["queued", "running", "completed", "failed"]);
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
const OPTIONAL_RUN_DETAIL_STRINGS = ["pane", "output", "error", "stopReason", "sessionFile"] as const;

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
	return [details.startedAt, details.finishedAt].every(
		(value) => value === undefined || (typeof value === "number" && Number.isFinite(value)),
	);
}

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent ${details.status} in herdr pane ${details.paneId} (tab ${details.tabId}).`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	];
	if (details.agentStatus === "blocked") {
		lines.push(`herdr reports the child is BLOCKED and waiting for input. Attach to answer it.`);
	}
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

export function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
	];
	if (details.stopReason) lines.push(`Stop reason: ${details.stopReason}`);
	if (details.error) lines.push(`Error: ${details.error}`);
	lines.push(
		`herdr: pane ${details.paneId}, tab ${details.tabId}, agent ${details.agentName}`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
		`Clean up: ${details.killCommand}`,
	);
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
	return /(?:\b401\b|\b403\b|\b429\b|\b5\d\d\b|rate.?limit|temporar(?:y|ily)|provider.*(?:startup|unavailable)|authentication|unauthori[sz]ed|model.*(?:not found|unavailable)|connection (?:refused|reset)|timed? out)/i.test(
		message,
	);
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

/** Create the pane the child will live in: a background tab in the caller's workspace. */
async function createChildPane(
	pi: ExtensionAPI,
	cwd: string,
	label: string,
): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (workspaceId) {
		const result = await herdrJson(pi, [
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			cwd,
			"--label",
			label,
			"--no-focus",
		]);
		const pane = pick(result, "root_pane");
		const tab = pick(result, "tab");
		const paneId = pickString(pane, "pane_id");
		const tabId = pickString(tab, "tab_id");
		if (!paneId || !tabId) throw new Error("herdr tab create did not return a pane id.");
		return { workspaceId, tabId, paneId };
	}

	// Not running inside a herdr pane: park children in their own workspace.
	const result = await herdrJson(pi, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
	const pane = pick(result, "root_pane");
	const tab = pick(result, "tab");
	const workspace = pick(result, "workspace");
	const paneId = pickString(pane, "pane_id");
	const tabId = pickString(tab, "tab_id");
	const createdWorkspaceId = pickString(workspace, "workspace_id");
	if (!paneId || !tabId || !createdWorkspaceId) {
		throw new Error("herdr workspace create did not return a pane id.");
	}
	return { workspaceId: createdWorkspaceId, tabId, paneId };
}

/* -------------------------------------------------------------------------- */
/* extension                                                                   */
/* -------------------------------------------------------------------------- */

export default function herdrSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[herdr-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		return;
	}

	const activeTabs = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createAgentRefAutocomplete(current, subagentProfiles));
	});

	pi.on("before_agent_start", async (event) => {
		const profiles = await subagentProfiles.list();
		if (profiles.length === 0) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nAgent profiles: A valid &name reference is the user's explicit request to delegate with that profile. Compose a complete, self-contained task for every child. Do not add model, thinking, or tool overrides; the profile owns them. The caller controls the number and ordering of calls unless the user explicitly requests references or parallelism.",
		};
	});

	pi.on("session_shutdown", async () => {
		const tabs = [...activeTabs];
		activeTabs.clear();
		await Promise.allSettled(tabs.map((tab) => pi.exec("herdr", ["tab", "close", tab], { timeout: 10_000 })));
	});

	const availableProfileNames = subagentProfiles.listSync().map((profile) => profile.name);

	pi.registerTool({
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description: `Run one delegated task in a separate pi process using a named agent profile. Available profiles: ${availableProfileNames.length ? availableProfileNames.join(", ") : "(none)"}. Profiles are refreshed at call time; sibling calls may run concurrently. Each child remains visible and inspectable in Herdr; output is capped at 50KB or 2000 lines.`,
		promptSnippet: "Run one delegated task in an observable herdr pane",
		promptGuidelines: [
			"Use herdr_subagent once per delegated task and provide the selected agent profile plus a complete, self-contained task.",
			"If a run reports that the child is blocked, attach with the printed herdr command and answer it rather than retrying the task.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: "Named profile from ~/.pi/agent/agents/*.md",
			}),
			task: Type.String({
				description: "The complete task for the child pi process",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory. Defaults to the current project.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			const profile = await subagentProfiles.get(params.agent);
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const thinking = profile.thinking ?? pi.getThinkingLevel();
			const modelRefs =
				profile.model === undefined ? [undefined] : Array.isArray(profile.model) ? profile.model : [profile.model];
			const allTools = pi.getAllTools();
			const knownTools = new Map(allTools.map((tool) => [tool.name, tool]));
			const requestedTools = profile.tools ?? pi.getActiveTools();
			const unknownTools = requestedTools.filter((name) => !knownTools.has(name));
			if (unknownTools.length > 0)
				throw new Error(`Agent profile ${profile.name} has unknown tool(s): ${unknownTools.join(", ")}.`);
			const sdkTools = requestedTools.filter((name) => knownTools.get(name)?.sourceInfo?.source === "sdk");
			if (sdkTools.length > 0)
				throw new Error(`Agent profile ${profile.name} uses SDK-only tool(s) unavailable to child Pi: ${sdkTools.join(", ")}.`);
			const childTools = [...new Set(requestedTools.filter((name) => name !== "herdr_subagent"))];
			await validateCwd(cwd);
			const version = await pi.exec("herdr", ["--version"], { timeout: 5_000 });
			if (version.code !== 0)
				throw new Error(`herdr is required for subagents: ${version.stderr.trim() || "herdr not found"}`);

			for (let candidateIndex = 0; candidateIndex < modelRefs.length; candidateIndex++) {
				const selectedModel = resolveModel(ctx, undefined, modelRefs[candidateIndex]);
				const childSessionId = randomUUID();
				const exitSentinel = exitSentinelFor(childSessionId);
				const runDir = path.join(getAgentDir(), RUNS_DIR, ctx.sessionManager.getSessionId(), childSessionId);
				const resultPath = path.join(runDir, "result.json");
				const spec: RunSpec = {
					task: params.task,
					cwd,
					workspaceId: "",
					tabId: "",
					paneId: "",
					agentName: agentNameFor(childSessionId),
					attachCommand: "",
					captureCommand: "",
					killCommand: "",
					provider: selectedModel.provider,
					model: selectedModel.model,
					thinking,
					trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
				};

				await mkdir(runDir, { recursive: true, mode: 0o700 });
				const promptPath = path.join(runDir, "task.md");
				const sessionDir = path.join(runDir, "session");
				await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				await writeFile(promptPath, `# Delegated task\n\n${params.task}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});

				const piArgs = [
					...getPiInvocationParts(),
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
					spec.agentName,
					spec.trusted ? "--approve" : "--no-approve",
					"--extension",
					EXTENSION_PATH,
					`@${promptPath}`,
				];
				// No `exec`: the pane's shell must outlive pi, otherwise herdr
				// closes the pane (and its tab) the moment the child exits and the
				// transcript is gone. The sentinel tells the poll loop that pi
				// exited even though the pane is still alive. With the default
				// (no exit on finish) the child never exits on its own, so the
				// sentinel only fires on crashes or manual quits.
				const childCommand = [
					"env",
					`${CHILD_ENV}=1`,
					`${RESULT_ENV}=${shellQuote(resultPath)}`,
					`${EXIT_ON_FINISH_ENV}=${process.env[EXIT_ON_FINISH_ENV] === "1" ? "1" : "0"}`,
					piArgs.map(shellQuote).join(" "),
					`; printf '\\n${exitSentinel} %s\\n' "$?"`,
				].join(" ");

				const startedAt = Date.now();
				const created = await createChildPane(pi, cwd, tabLabelFor(params.task));
				spec.workspaceId = created.workspaceId;
				spec.tabId = created.tabId;
				spec.paneId = created.paneId;
				spec.attachCommand = `herdr tab focus ${created.tabId}`;
				spec.captureCommand = `herdr pane read ${created.paneId} --source recent-unwrapped --lines ${CAPTURE_LINES}`;
				spec.killCommand = `herdr tab close ${created.tabId}`;
				activeTabs.add(created.tabId);

				try {
					const initialDetails = detailsFor(spec, "running", { startedAt });
					onUpdate?.({
						content: [{ type: "text", text: partialText(initialDetails) }],
						details: initialDetails,
					});

					await herdrOk(pi, ["pane", "run", created.paneId, childCommand]);

					let lastPane = "";
					let lastAgentStatus: AgentStatus | undefined;
					let herdrSessionFile: string | undefined;
					let renamed = false;
					let exitSeenAt: number | undefined;
					let childResult: ChildResult | undefined;
					let tick = 0;

					while (!childResult) {
						if (signal?.aborted) throw new Error("Subagent aborted.");
						try {
							childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
							break;
						} catch {
							// The result file is created atomically when the child settles.
						}

						const paneText = await herdrPaneRead(pi, created.paneId, PANE_READ_LINES);
						// herdr releases the agent when pi exits, so a missing agent late
						// in the run is normal; keep the last observed status instead.
						const agentInfo = tick++ % AGENT_STATUS_EVERY === 0 ? await readAgentInfo(pi, created.paneId) : undefined;
						if (agentInfo?.sessionFile) herdrSessionFile = agentInfo.sessionFile;

						// Give the child a stable, addressable name once herdr sees it.
						if (agentInfo && !renamed) {
							renamed = true;
							await pi
								.exec("herdr", ["agent", "rename", created.paneId, spec.agentName], { timeout: 10_000 })
								.catch(() => undefined);
						}

						const pane = paneText === undefined ? "" : trimPane(paneText);
						const statusChanged = agentInfo !== undefined && agentInfo.status !== lastAgentStatus;
						if ((pane && pane !== lastPane) || statusChanged) {
							lastPane = pane || lastPane;
							if (agentInfo) lastAgentStatus = agentInfo.status;
							const details = detailsFor(spec, "running", {
								pane: lastPane,
								agentStatus: lastAgentStatus,
								startedAt,
							});
							onUpdate?.({
								content: [{ type: "text", text: partialText(details) }],
								details,
							});
						}

						// pi exited without writing a result, or the pane died outright.
						const exitCode = paneText === undefined ? undefined : parseChildExitCode(paneText, exitSentinel);
						const paneGone = paneText === undefined && !(await paneExists(pi, created.paneId));
						if (exitCode !== undefined || paneGone) {
							exitSeenAt ??= Date.now();
							if (Date.now() - exitSeenAt >= EXIT_GRACE_MS) {
								try {
									childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
									break;
								} catch {
									throw new Error(
										`Child pi exited before reporting a result.\n\n${lastPane || "No pane output."}\n\n` +
											`Inspect: ${spec.captureCommand}`,
									);
								}
							}
						}

						await abortableDelay(POLL_INTERVAL_MS, signal);
					}

					const finalPaneText = await herdrPaneRead(pi, created.paneId, PANE_READ_LINES);
					const finalPane = finalPaneText === undefined ? lastPane : trimPane(finalPaneText);
					const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
					const output = truncateToolText(childResult.output.trim() || "(no text output)");
					const details = detailsFor(spec, status, {
						pane: finalPane,
						output,
						error: childResult.error?.trim() || undefined,
						stopReason: childResult.stopReason,
						agentStatus: lastAgentStatus,
						sessionFile: childResult.sessionFile ?? herdrSessionFile,
						provider: childResult.provider ?? spec.provider,
						model: childResult.model ?? spec.model,
						thinking: childResult.thinking ?? spec.thinking,
						startedAt,
						finishedAt: childResult.finishedAt,
					});

					// The child settled: hand its tab over to the user instead of
					// closing it on session shutdown.
					activeTabs.delete(created.tabId);

					if (childResult.status === "failed") {
						if (isRetryableProviderFailure(childResult) && candidateIndex + 1 < modelRefs.length && !signal?.aborted) {
							await pi
								.exec("herdr", ["tab", "close", created.tabId], {
									timeout: 10_000,
								})
								.catch(() => undefined);
							continue;
						}
						throw new NonRetryableSubagentError(resultText(details));
					}
					return {
						content: [{ type: "text", text: resultText(details) }],
						details,
					};
				} catch (error) {
					if (
						signal?.aborted ||
						(!(error instanceof NonRetryableSubagentError) &&
							candidateIndex + 1 < modelRefs.length &&
							isRetryableProviderFailure(error instanceof Error ? error : String(error)))
					) {
						await pi
							.exec("herdr", ["tab", "close", created.tabId], {
								timeout: 10_000,
							})
							.catch(() => undefined);
						activeTabs.delete(created.tabId);
						if (!signal?.aborted) continue;
					}
					throw error;
				}
			}
			throw new Error("Every model candidate failed.");
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold(`herdr ${args.agent || "subagent"} `)) + theme.fg("dim", preview);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = isRunDetails(result.details) ? result.details : undefined;
			if (!details) {
				const content = result.content.find((part) => part.type === "text");
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
			text += `\n  ${theme.fg("accent", details.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
				text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
