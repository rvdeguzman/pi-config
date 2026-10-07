/**
 * Euler goals. `/goal <objective> --until "<check>"` keeps the agent working
 * across runs until the check passes, the agent reports it is blocked, or the
 * iteration budget runs out. The check, not the agent's own report, ends a
 * goal that has one.
 *
 * State lives on the session branch: a start entry, Pi's iteration messages,
 * goal_checkpoint tool results, and an end entry. A goal is live only while
 * this process is running it: a run that settles without ending it (Esc, an
 * invalid continuation) ends it as interrupted, and a goal rebuilt from history
 * (tree navigation, a crash mid-run) is never live. `/goal resume` restarts it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const GOAL_TYPE = "euler-goal";
export const CHECKPOINT_TOOL = "goal_checkpoint";
const ASK_TOOL = "ask_user_question";
const SECTION = "euler-goal";
const STATUS_KEY = "euler-goal";
const CHECK_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;
const MAX_LIMIT = 100;
const USAGE = 'Usage: /goal <objective> [--until "<check command>"] [--max N] [--away] · /goal status | stop | resume';

type EndReason = "done" | "blocked" | "capped" | "stopped" | "interrupted" | "failed";
type CheckpointStatus = "continue" | "done" | "blocked";

export interface CheckResult {
	/** Exit code; -1 when the check ended by a signal, timeout, or abort. Only 0 passes. */
	code: number;
	timedOut?: boolean;
	signal?: string;
	tail: string;
}

interface Checkpoint {
	status: CheckpointStatus;
	note: string;
}

interface Iteration {
	checkpoint?: Checkpoint;
	check?: CheckResult;
}

export interface GoalSpec {
	objective: string;
	check?: string;
	max: number;
	away: boolean;
}

interface StartData extends GoalSpec {
	action: "start";
	id: string;
	/** ask_user_question was active before an away goal hid it. */
	restoreAsk?: boolean;
}

interface EndData {
	action: "end";
	id: string;
	reason: EndReason;
	note?: string;
	check?: CheckResult;
}

export interface GoalState extends StartData {
	active: boolean;
	end?: EndData;
	/** One record per iteration so far; the last is the current one. */
	iterations: Iteration[];
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; toolName?: string; details?: unknown };
}

/** The latest goal on this branch, rebuilt from its entries. */
export function readGoal(branch: readonly BranchEntry[]): GoalState | undefined {
	let startIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === GOAL_TYPE && (entry.data as StartData)?.action === "start") {
			startIndex = index;
			break;
		}
	}
	if (startIndex < 0) return undefined;
	const start = branch[startIndex]!.data as StartData;
	const iterations: Iteration[] = [{}];
	let end: EndData | undefined;
	for (const entry of branch.slice(startIndex + 1)) {
		if (entry.type === "custom" && entry.customType === GOAL_TYPE) {
			const data = entry.data as EndData;
			if (data?.action === "end" && data.id === start.id) end = data;
		} else if (entry.type === "custom_message" && entry.customType === GOAL_TYPE) {
			const details = entry.details as { goalId?: string; kind?: string; check?: CheckResult } | undefined;
			if (details?.goalId !== start.id || details.kind !== "iteration") continue;
			iterations.at(-1)!.check = details.check;
			iterations.push({});
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === CHECKPOINT_TOOL) {
			const details = entry.message.details as (Checkpoint & { goalId?: string }) | undefined;
			if (details?.goalId === start.id) iterations.at(-1)!.checkpoint = { status: details.status, note: details.note };
		}
	}
	if (end?.check) iterations.at(-1)!.check = end.check;
	return { ...start, active: !end, end, iterations };
}

/**
 * Parse `/goal` arguments. Flags follow the objective; an unquoted `--until`
 * value runs to the next flag or the end of the input.
 */
export function parseGoalArgs(input: string): (Partial<GoalSpec> & { objective: string; away: boolean }) | { error: string } {
	let rest = ` ${input} `;
	let check: string | undefined;
	let max: number | undefined;
	let away = false;
	rest = rest.replace(/\s--until\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+?))(?=\s+--(?:max|away)\b|\s*$)/, (_m, dq, sq, bare) => {
		check = (dq !== undefined ? dq.replace(/\\(.)/g, "$1") : (sq ?? bare)).trim();
		return " ";
	});
	rest = rest.replace(/\s--max\s+(\S+)/, (_m, value: string) => {
		max = /^\d+$/.test(value) ? Number(value) : Number.NaN;
		return " ";
	});
	rest = rest.replace(/\s--away(?=\s)/, () => {
		away = true;
		return " ";
	});
	const objective = rest.replace(/\s+/g, " ").trim();
	if (/(^|\s)--(until|max|away)\b/.test(objective)) return { error: `Could not read the flags. ${USAGE}` };
	if (check === "") return { error: "--until needs a command." };
	if (max !== undefined && !(max >= 1 && max <= MAX_LIMIT)) return { error: `--max must be a whole number from 1 to ${MAX_LIMIT}.` };
	return { objective, check, max, away };
}

function tail(output: string): string {
	const lines = output.trimEnd().split("\n");
	const kept = lines.slice(-TAIL_LINES).join("\n");
	return kept.length > TAIL_CHARS ? `…${kept.slice(-TAIL_CHARS)}` : kept;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function checkOutcome(check: string, result: CheckResult): string {
	if (result.code === 0) return `\`${check}\` passes`;
	if (result.timedOut) return `\`${check}\` timed out`;
	if (result.signal) return `\`${check}\` was killed by ${result.signal}`;
	return result.code < 0 ? `\`${check}\` was stopped` : `\`${check}\` failed (exit ${result.code})`;
}

/**
 * Run a check in its own process group. It passes only on a normal exit with
 * code 0; a timeout or abort sends SIGTERM to the group, then SIGKILL after a
 * grace period, so a check that ignores SIGTERM cannot hang the goal.
 */
export function runCheck(
	command: string,
	options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; killGraceMs?: number },
): Promise<CheckResult> {
	const { cwd, signal, timeoutMs = CHECK_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS } = options;
	return new Promise((resolve) => {
		let output = "";
		let stopped: "timeout" | "abort" | undefined;
		let force: NodeJS.Timeout | undefined;
		let settled = false;
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const append = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > 200_000) output = output.slice(-100_000);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const signalGroup = (name: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, name);
			} catch {
				// The group is already gone.
			}
		};
		const stop = (why: "timeout" | "abort") => {
			if (stopped || settled) return;
			stopped = why;
			signalGroup("SIGTERM");
			force = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
		};
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const onAbort = () => stop("abort");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(force);
			signal?.removeEventListener("abort", onAbort);
			// Background processes the check started do not outlive it.
			signalGroup(stopped ? "SIGKILL" : "SIGTERM");
			const passed = code === 0 && exitSignal === null && !stopped;
			resolve({
				code: passed ? 0 : code !== null && code !== 0 && !stopped ? code : -1,
				...(stopped === "timeout" ? { timedOut: true } : {}),
				...(exitSignal && !stopped ? { signal: exitSignal } : {}),
				tail: tail(output),
			});
		};
		child.on("error", (error) => {
			output += `\n${error.message}`;
			finish(127, null);
		});
		// Exit decides the result; give inherited pipes a moment to flush.
		child.on("exit", (code, exitSignal) => {
			const done = () => finish(code, exitSignal);
			child.once("close", done);
			setTimeout(done, 200);
		});
	});
}

function logLines(goal: GoalState): string[] {
	return goal.iterations.map((iteration, index) => {
		const note = iteration.checkpoint ? `${iteration.checkpoint.status}: ${iteration.checkpoint.note}` : "no checkpoint";
		const check = !iteration.check ? "" : iteration.check.code === 0 ? " · check passed" : ` · check exit ${iteration.check.code}`;
		return `${index + 1}. ${note}${check}`;
	});
}

function endHeadline(goal: GoalState, end: Omit<EndData, "action" | "id">): string {
	const count = goal.iterations.length;
	switch (end.reason) {
		case "done":
			return goal.check
				? `Goal done after ${plural(count, "iteration")}: \`${goal.check}\` passes.`
				: `Goal done after ${plural(count, "iteration")}, as reported by the agent (no check configured).`;
		case "capped":
			return `Goal stopped at its ${plural(goal.max, "iteration")} budget${
				goal.check && end.check ? `; ${checkOutcome(goal.check, end.check)}` : ""
			}.`;
		case "blocked":
			return `Goal blocked at iteration ${count}: ${end.note ?? "no reason given"}`;
		case "failed":
			return `Goal ended by a model or provider error at iteration ${count}.`;
		case "interrupted":
			return `Goal interrupted at iteration ${count}. /goal resume starts it again.`;
		case "stopped":
			return `Goal stopped at iteration ${count}.`;
	}
}

function endSummary(goal: GoalState, end: Omit<EndData, "action" | "id">): string {
	const lines = [endHeadline(goal, end), ...logLines({ ...goal, iterations: withFinalCheck(goal, end.check) })];
	if (end.reason === "capped" && end.check && end.check.code !== 0 && end.check.tail) {
		lines.push("", "```", end.check.tail, "```");
	}
	return lines.join("\n");
}

function withFinalCheck(goal: GoalState, check: CheckResult | undefined): Iteration[] {
	if (!check) return goal.iterations;
	return [...goal.iterations.slice(0, -1), { ...goal.iterations.at(-1), check }];
}

/** The `/goal status` text. */
function describeGoal(goal: GoalState | undefined, live: boolean): string {
	if (!goal) return `No goal on this branch.\n${USAGE}`;
	const state = live
		? `active, iteration ${goal.iterations.length}/${goal.max}`
		: `${goal.end?.reason ?? "interrupted"} after ${plural(goal.iterations.length, "iteration")}`;
	return [
		`Goal (${state}${goal.away ? ", away" : ""}): ${goal.objective}`,
		goal.check ? `Done when \`${goal.check}\` exits 0.` : "Done when the agent reports done (no check).",
		...logLines(goal),
	].join("\n");
}

export interface GoalOptions {
	/** Directory holding goal.md and away.md. */
	skillDir: string;
	/** Turn Euler on for the branch; a goal is Euler work. */
	enableEuler(ctx: ExtensionContext): void;
}

export function registerGoal(pi: ExtensionAPI, options: GoalOptions): void {
	const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as BranchEntry[];
	const readPolicy = (name: string) => readFileSync(join(options.skillDir, name), "utf8").trim();

	/** The goal this process is running. A goal rebuilt from the branch is live only if it matches. */
	let liveId: string | undefined;
	/** An away goal's run is in progress: ask_user_question stays blocked until it settles, report turn included. */
	let awayRun = false;
	/** A goal that ended inside a run; its tools are restored once the run settles. */
	let pendingRestore: StartData | undefined;
	/** Cancels the running check (startup or iteration): Esc in the TUI, /goal stop, or shutdown. */
	let checkAbort: AbortController | undefined;
	let shuttingDown = false;

	const liveGoal = (ctx: ExtensionContext) => {
		const goal = readGoal(branchOf(ctx));
		return goal && !goal.end && goal.id === liveId ? goal : undefined;
	};

	const showStatus = (ctx: ExtensionContext, goal = liveGoal(ctx), suffix = "") => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, goal ? `goal ${goal.iterations.length}/${goal.max}${goal.away ? " away" : ""}${suffix}` : undefined);
	};

	/** While a goal runs, goal_checkpoint is active, and an away goal hides ask_user_question. */
	const applyGoalTools = (goal: StartData) => {
		const current = pi.getActiveTools().filter((name) => name !== CHECKPOINT_TOOL && !(goal.away && name === ASK_TOOL));
		pi.setActiveTools([...current, CHECKPOINT_TOOL]);
	};

	const restoreTools = (goal: StartData | undefined) => {
		const current = pi.getActiveTools();
		const ask = goal?.restoreAsk && !current.includes(ASK_TOOL) ? [ASK_TOOL] : [];
		if (!current.includes(CHECKPOINT_TOOL) && ask.length === 0) return;
		pi.setActiveTools([...current.filter((name) => name !== CHECKPOINT_TOOL), ...ask]);
	};

	/** End a goal outside an agent boundary: commands, settled runs, session start. */
	const endNow = (ctx: ExtensionContext, goal: GoalState, reason: EndReason) => {
		if (goal.id === liveId) liveId = undefined;
		awayRun = false;
		pi.appendEntry(GOAL_TYPE, { action: "end", id: goal.id, reason } satisfies EndData);
		restoreTools(goal);
		showStatus(ctx, undefined);
		pi.sendMessage(
			{ customType: GOAL_TYPE, content: endSummary(goal, { reason }), display: true, details: { goalId: goal.id, kind: "end" } },
			{ triggerTurn: false },
		);
	};

	/** Run a check that Esc, /goal stop, or shutdown can cancel. */
	const cancellableCheck = async (ctx: ExtensionContext, command: string) => {
		const abort = (checkAbort = new AbortController());
		const unwatch = ctx.hasUI
			? ctx.ui.onTerminalInput((data) => {
					if (matchesKey(data, "escape")) abort.abort();
					return undefined;
				})
			: undefined;
		try {
			const result = await runCheck(command, { cwd: ctx.cwd, signal: abort.signal });
			return { result, cancelled: abort.signal.aborted };
		} finally {
			unwatch?.();
			if (checkAbort === abort) checkAbort = undefined;
		}
	};

	const start = async (ctx: ExtensionContext, spec: Partial<GoalSpec> & { objective: string; away: boolean }) => {
		if (!spec.objective) return ctx.ui.notify(USAGE, "warning");
		if (!ctx.isIdle() || checkAbort) return ctx.ui.notify("Finish or interrupt the current run before starting a goal.", "warning");
		if (spec.away && !spec.check) {
			return ctx.ui.notify('An away goal needs a check: /goal --away <objective> --until "<command>".', "warning");
		}
		if (spec.check) {
			ctx.ui.notify(`Running \`${spec.check}\` to confirm it fails before the goal starts (Esc cancels)…`, "info");
			const { result, cancelled } = await cancellableCheck(ctx, spec.check);
			if (shuttingDown) return;
			if (cancelled) return ctx.ui.notify("Goal not started.", "info");
			if (result.code === 0) {
				return ctx.ui.notify(
					`\`${spec.check}\` already passes, so it cannot tell when this goal is done. Use a check that fails until the goal is met.`,
					"warning",
				);
			}
			if (!ctx.isIdle()) return ctx.ui.notify("Another run started during the check, so the goal did not start.", "warning");
		}
		if (spec.away) {
			const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 10_000 });
			if (status.code === 0 && status.stdout.trim()) {
				ctx.ui.notify("This checkout has uncommitted changes; the away run will work alongside them.", "warning");
			}
		}
		const previous = liveGoal(ctx);
		if (previous) endNow(ctx, previous, "stopped");

		const data: StartData = {
			action: "start",
			id: randomUUID(),
			objective: spec.objective,
			check: spec.check,
			max: spec.max ?? (spec.check ? 10 : 5),
			away: spec.away,
			...(spec.away ? { restoreAsk: pi.getActiveTools().includes(ASK_TOOL) } : {}),
		};
		pi.appendEntry(GOAL_TYPE, data);
		liveId = data.id;
		awayRun = data.away;
		applyGoalTools(data);
		options.enableEuler(ctx);
		showStatus(ctx);
		pi.sendUserMessage(spec.objective);
	};

	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Goal checkpoint",
		description:
			"Record the end of a goal iteration: what you changed or decided, and the evidence. Use done when you believe the goal is met, blocked only when the user must decide or act, otherwise continue.",
		promptSnippet: "Record a goal iteration: what changed, the evidence, and whether the goal is done or blocked",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("continue"), Type.Literal("done"), Type.Literal("blocked")]),
			note: Type.String({ description: "One line: what you changed or decided, and the evidence for it." }),
		}),
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const goal = liveGoal(ctx);
			if (!goal) throw new Error("No goal is active.");
			const note = params.note.replace(/\s+/g, " ").trim();
			const text =
				params.status === "done" && goal.check
					? `Recorded. Pi runs \`${goal.check}\` when you stop; the goal ends only if it passes.`
					: params.status === "blocked"
						? "Recorded. The goal stops when you end this reply."
						: "Recorded.";
			return {
				content: [{ type: "text" as const, text }],
				details: { goalId: goal.id, status: params.status, note },
			};
		},
	});

	pi.registerMessageRenderer(GOAL_TYPE, (message, renderOptions, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const [head = "", ...rest] = text.split("\n").filter((line) => !line.startsWith("```"));
		const body = renderOptions.expanded ? rest : rest.slice(0, 8);
		if (body.length < rest.length) body.push(`… ${rest.length - body.length} more lines`);
		return new Text(
			[theme.fg("accent", `◆ ${head}`), ...body.map((line) => theme.fg("dim", `  ${line}`))].join("\n"),
			renderOptions.outputPad,
			0,
		);
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		// A goal with no end entry was cut off mid-run (crash, kill): record that and restore its tools.
		const goal = readGoal(branchOf(ctx));
		if (goal && !goal.end && goal.id !== liveId) endNow(ctx, goal, "interrupted");
		else restoreTools(undefined); // e.g. a subagent child that inherited goal_checkpoint
		showStatus(ctx);
	});

	// Navigating to a point inside an old goal never revives it; /goal resume does.
	pi.on("session_tree", (_event, ctx) => showStatus(ctx));

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		checkAbort?.abort();
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Still live here means the run stopped without ending the goal: Esc, or an invalid continuation.
		const goal = liveGoal(ctx);
		if (goal) endNow(ctx, goal, "interrupted");
		else if (pendingRestore) restoreTools(pendingRestore);
		pendingRestore = undefined;
		awayRun = false;
		showStatus(ctx);
	});

	// The objective's run never started (for example, missing auth): a later prompt must not join the goal.
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension" && liveId && ctx.isIdle()) {
			const goal = liveGoal(ctx);
			if (goal) endNow(ctx, goal, "interrupted");
			liveId = undefined;
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const goal = liveGoal(ctx);
		if (!goal) return;
		const done = goal.check
			? `Done when \`${goal.check}\` exits 0. Pi runs it after each iteration; your checkpoint alone does not end the goal.`
			: "Done when you report done. No check is configured, so make the evidence in your checkpoints concrete.";
		event.systemPromptOptions.sections[SECTION] = [
			readPolicy("goal.md"),
			"## This goal",
			`Objective: ${goal.objective}`,
			done,
			`Iteration budget: ${goal.max}.`,
			// A --tools allowlist can keep the checkpoint tool from activating.
			...(pi.getActiveTools().includes(CHECKPOINT_TOOL)
				? []
				: [`${CHECKPOINT_TOOL} is not available in this session; end each reply with the same one-line status instead.`]),
			...(goal.away ? [readPolicy("away.md")] : []),
		].join("\n\n");
	});

	// Hiding the tool is not enough: deferred or codemode tools stay callable through executeTool().
	pi.on("tool_call", (event) => {
		if (event.toolName !== ASK_TOOL || !awayRun) return;
		return {
			block: true,
			reason: "The user is away. Choose the reversible option that best fits their intent, record it in goal_checkpoint, and continue.",
		};
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.continue) return;
		const goal = liveGoal(ctx);
		if (!goal) return;

		const finish = (reason: EndReason, extra: { note?: string; check?: CheckResult } = {}) => {
			const end: EndData = { action: "end", id: goal.id, reason, ...extra };
			const report = goal.away && (reason === "done" || reason === "capped" || reason === "blocked");
			const content = report
				? `${endSummary(goal, end)}\n\nThe goal has ended. Write the report for the user's return, as the Away section describes.`
				: endSummary(goal, end);
			liveId = undefined;
			// Tools come back when the run settles, after any away report turn.
			pendingRestore = goal;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			return {
				entries: [
					...event.entries,
					{ type: "custom" as const, customType: GOAL_TYPE, data: end },
					{ type: "custom_message" as const, customType: GOAL_TYPE, content, display: true, details: { goalId: goal.id, kind: "end" } },
				],
				continue: report,
			};
		};

		if (event.outcome !== "completed") return finish(event.outcome === "aborted" ? "interrupted" : "failed");
		const checkpoint = goal.iterations.at(-1)!.checkpoint;
		if (checkpoint?.status === "blocked") return finish("blocked", { note: checkpoint.note });

		let check: CheckResult | undefined;
		if (goal.check) {
			showStatus(ctx, goal, " · checking");
			const { result, cancelled } = await cancellableCheck(ctx, goal.check);
			// Esc or /goal stop during the check: settle without continuing; agent_settled records an Esc.
			if (cancelled || !liveGoal(ctx)) return;
			check = result;
			if (check.code === 0) return finish("done", { check });
		} else if (checkpoint?.status === "done") {
			return finish("done");
		}

		const iteration = goal.iterations.length;
		if (iteration >= goal.max) return finish("capped", { check });

		const next = iteration + 1;
		const rejected = checkpoint?.status === "done" ? " Your done checkpoint was not accepted." : "";
		const content =
			goal.check && check
				? `Goal iteration ${next}/${goal.max} · ${checkOutcome(goal.check, check)}.${rejected}\n\n\`\`\`\n${check.tail || "(no output)"}\n\`\`\`\n\nContinue toward the goal.`
				: `Goal iteration ${next}/${goal.max}. Continue toward the goal; call ${CHECKPOINT_TOOL} with done when it is met.`;
		showStatus(ctx, { ...goal, iterations: [...goal.iterations, {}] });
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: GOAL_TYPE,
					content,
					display: true,
					details: { goalId: goal.id, kind: "iteration", iteration: next, ...(check ? { check } : {}) },
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("goal", {
		description: 'Euler goal: /goal <objective> --until "<check>" [--max N] [--away]; /goal status, stop, resume',
		getArgumentCompletions: (prefix: string) =>
			["status", "stop", "resume"].filter((word) => word.startsWith(prefix.trim())).map((word) => ({ value: word, label: word })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const input = args.trim();
			const goal = readGoal(branchOf(ctx));
			const live = liveGoal(ctx);
			if (!input || input === "status") return ctx.ui.notify(describeGoal(goal, !!live), "info");
			if (input === "stop") {
				checkAbort?.abort(); // a startup check reports "Goal not started" itself
				if (live) {
					endNow(ctx, live, "stopped");
					return ctx.ui.notify("Goal stopped. The current reply finishes; Pi will not continue it.", "info");
				}
				return checkAbort ? undefined : ctx.ui.notify("No goal is active.", "info");
			}
			if (input === "resume") {
				if (!goal) return ctx.ui.notify("No goal on this branch to resume.", "info");
				if (live) return ctx.ui.notify("The goal is already active.", "info");
				return start(ctx, { objective: goal.objective, check: goal.check, max: goal.max, away: goal.away });
			}
			const parsed = parseGoalArgs(input);
			if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
			return start(ctx, parsed);
		},
	});
}
