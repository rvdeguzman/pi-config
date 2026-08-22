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

import { StringEnum } from "@earendil-works/pi-ai";
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

const CHILD_ENV = "PI_HERDR_SUBAGENT_CHILD";
const RESULT_ENV = "PI_HERDR_SUBAGENT_RESULT";
const RUNS_DIR = "herdr-subagents";
const EXIT_SENTINEL = "__pi_herdr_subagent_exit__";
const POLL_INTERVAL_MS = 500;
/** Poll herdr's agent lifecycle state every N pane polls (it changes slowly). */
const AGENT_STATUS_EVERY = 4;
const PANE_PREVIEW_LINES = 18;
const PANE_READ_LINES = 60;
const CAPTURE_LINES = 200;
const EXIT_GRACE_MS = 1_500;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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

/* -------------------------------------------------------------------------- */
/* herdr CLI                                                                   */
/* -------------------------------------------------------------------------- */

interface HerdrEnvelope {
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

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
	const run = await pi.exec("herdr", args, { timeout: options.timeout ?? 15_000 });
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
		const result = await herdrJson(pi, ["agent", "get", paneId], { timeout: 10_000 });
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
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const result: ChildResult = {
			version: 1,
			status: failed ? "failed" : "completed",
			output: assistant ? textFromAssistant(assistant) : "",
			error:
				fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(
				`[herdr-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
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
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
		`herdr: pane ${details.paneId}, tab ${details.tabId}, agent ${details.agentName}`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
		`Clean up: ${details.killCommand}`,
	];
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

	let queueTail: Promise<void> = Promise.resolve();
	let queueDepth = 0;
	let activeTab: string | undefined;

	const withSerialExecution = async <T>(
		signal: AbortSignal | undefined,
		onQueued: () => void,
		fn: () => Promise<T>,
	): Promise<T> => {
		const queued = queueDepth > 0;
		queueDepth++;
		const previous = queueTail;
		let release!: () => void;
		queueTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		if (queued) onQueued();

		try {
			await previous;
			if (signal?.aborted) throw new Error("Subagent aborted while waiting in the serial queue.");
			return await fn();
		} finally {
			queueDepth--;
			release();
		}
	};

	pi.on("session_shutdown", async () => {
		if (!activeTab) return;
		// Only an unfinished child is still owned by this session; completed
		// children keep their tab so their transcript stays inspectable.
		await pi.exec("herdr", ["tab", "close", activeTab], { timeout: 10_000 });
		activeTab = undefined;
	});

	pi.registerTool({
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description:
			"Run one delegated task in a separate pi process inside a background herdr tab. Calls are serialized: only one child works at a time, even if several calls are requested together. The child inherits the current provider, model, and thinking level unless overridden, appears in the herdr sidebar with live working/blocked status, and its tab stays open afterwards so its transcript can be inspected. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
		promptSnippet: "Run one delegated task in an observable herdr pane",
		promptGuidelines: [
			"Use herdr_subagent once per delegated task; calls are serialized automatically, so prefer multiple simple calls over asking one child to orchestrate other children.",
			"If a run reports that the child is blocked, attach with the printed herdr command and answer it rather than retrying the task.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the child pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
			provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider." })),
			model: Type.Optional(
				Type.String({ description: "Model id or provider/model override. Defaults to the current model." }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "Thinking level override. Defaults to the current thinking level.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const selectedModel = resolveModel(ctx, params.provider, params.model);
			const thinking = params.thinking ?? pi.getThinkingLevel();
			const childSessionId = randomUUID();
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

			return withSerialExecution(
				signal,
				() => {
					const details = detailsFor(spec, "queued");
					onUpdate?.({ content: [{ type: "text", text: "Waiting for the active subagent to finish..." }], details });
				},
				async () => {
					await validateCwd(cwd);

					const version = await pi.exec("herdr", ["--version"], { timeout: 5_000 });
					if (version.code !== 0) {
						throw new Error(`herdr is required for subagents: ${version.stderr.trim() || "herdr not found"}`);
					}

					await mkdir(runDir, { recursive: true, mode: 0o700 });
					const promptPath = path.join(runDir, "task.md");
					const sessionDir = path.join(runDir, "session");
					await mkdir(sessionDir, { recursive: true, mode: 0o700 });
					await writeFile(promptPath, `# Delegated task\n\n${params.task}\n`, { encoding: "utf8", mode: 0o600 });

					const piArgs = [
						...getPiInvocationParts(),
						"--provider",
						selectedModel.provider,
						"--model",
						selectedModel.model,
						"--thinking",
						thinking,
						"--session-dir",
						sessionDir,
						"--session-id",
						childSessionId,
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
					// exited even though the pane is still alive.
					const childCommand = [
						"env",
						`${CHILD_ENV}=1`,
						`${RESULT_ENV}=${shellQuote(resultPath)}`,
						piArgs.map(shellQuote).join(" "),
						`; printf '\\n${EXIT_SENTINEL} %s\\n' "$?"`,
					].join(" ");

					const startedAt = Date.now();
					const created = await createChildPane(pi, cwd, tabLabelFor(params.task));
					spec.workspaceId = created.workspaceId;
					spec.tabId = created.tabId;
					spec.paneId = created.paneId;
					spec.attachCommand = `herdr tab focus ${created.tabId}`;
					spec.captureCommand = `herdr pane read ${created.paneId} --source recent-unwrapped --lines ${CAPTURE_LINES}`;
					spec.killCommand = `herdr tab close ${created.tabId}`;
					activeTab = created.tabId;

					try {
						const initialDetails = detailsFor(spec, "running", { startedAt });
						onUpdate?.({ content: [{ type: "text", text: partialText(initialDetails) }], details: initialDetails });

						await herdrJson(pi, ["pane", "run", created.paneId, childCommand]);

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
								onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details });
							}

							// pi exited without writing a result, or the pane died outright.
							const sawExit = paneText?.includes(EXIT_SENTINEL) ?? false;
							const paneGone = paneText === undefined && !(await paneExists(pi, created.paneId));
							if (sawExit || paneGone) {
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
						let rawOutput = childResult.output.trim();
						if (childResult.status === "failed" && childResult.error?.trim()) {
							rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
						}
						const output = truncateToolText(rawOutput || "(no text output)");
						const details = detailsFor(spec, status, {
							pane: finalPane,
							output,
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
						activeTab = undefined;

						if (childResult.status === "failed") throw new Error(resultText(details));
						return { content: [{ type: "text", text: resultText(details) }], details };
					} catch (error) {
						if (signal?.aborted && activeTab === created.tabId) {
							await pi.exec("herdr", ["tab", "close", created.tabId], { timeout: 10_000 }).catch(() => undefined);
							activeTab = undefined;
						}
						throw error;
					}
				},
			);
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("herdr subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RunDetails | undefined;
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
