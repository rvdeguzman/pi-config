/**
 * Correction capture: find places where the user corrected an agent, so
 * recurring preferences can become approved rules.
 *
 * Code collects user messages that follow an assistant reply. Jev judges each
 * one (is it a correction? how broadly does it apply?). The flagged evidence is
 * handed to the main agent, which groups it into rules and asks the user to
 * approve each before writing anything.
 */

import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { newestSessionFiles, textContent } from "./lib/session-files.ts";
import { systemOne, type TypeSafeAnswer } from "./lib/typesafe.ts";

const STATE_FILE = "corrections-state.json";
const DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;
const SESSION_LIMIT = 300;
const MAX_CANDIDATES = 200;
const BATCH = 25;
const MAX_MESSAGE_CHARS = 1_500;
const CORRECTION_THRESHOLD = 0.6;
const REVIEWED_LIMIT = 5_000;

export type Scope = "global" | "project" | "one_off";

export interface CorrectionCandidate {
	key: string;
	session: string;
	entryId: string;
	project?: string;
	date?: string;
	previous: string;
	message: string;
}

export interface FlaggedCorrection extends CorrectionCandidate {
	correction: number;
	scope: Scope;
}

interface State {
	lastRun?: number;
	reviewed: string[];
}

export function preferencesPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "skills", "euler", "preferences.md");
}

async function loadState(agentDir: string): Promise<State> {
	try {
		const parsed = JSON.parse(await readFile(path.join(agentDir, STATE_FILE), "utf8"));
		return { lastRun: typeof parsed.lastRun === "number" ? parsed.lastRun : undefined, reviewed: Array.isArray(parsed.reviewed) ? parsed.reviewed : [] };
	} catch {
		return { reviewed: [] };
	}
}

async function saveState(agentDir: string, state: State): Promise<void> {
	const reviewed = state.reviewed.slice(-REVIEWED_LIMIT);
	await writeFile(path.join(agentDir, STATE_FILE), `${JSON.stringify({ ...state, reviewed }, null, "\t")}\n`, { mode: 0o600 });
}

function clip(text: string, limit: number): string {
	const clean = text.trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** User messages that answer an assistant reply; skips injected skills, notices, and pasted dumps. */
function isReviewable(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed.length > 0 &&
		trimmed.length <= MAX_MESSAGE_CHARS &&
		!trimmed.startsWith("<skill") &&
		!trimmed.startsWith("<system-notice>") &&
		!trimmed.startsWith("/")
	);
}

async function sessionCandidates(file: string, sinceMs: number, skip: Set<string>): Promise<CorrectionCandidate[]> {
	const candidates: CorrectionCandidate[] = [];
	let project: string | undefined;
	let previous = "";
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session" && typeof entry.cwd === "string") project = entry.cwd;
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "assistant") {
			const text = textContent(message.content).trim();
			if (text) previous = text;
			continue;
		}
		if (message.role !== "user") continue;
		const text = textContent(message.content);
		const time = Date.parse(entry.timestamp ?? "");
		const key = `${file}#${entry.id}`;
		if (previous && isReviewable(text) && !(time < sinceMs) && !skip.has(key)) {
			candidates.push({
				key,
				session: file,
				entryId: String(entry.id),
				project,
				date: entry.timestamp,
				previous: clip(previous, 600),
				message: text.trim(),
			});
		}
		previous = "";
	}
	return candidates;
}

export async function collectCandidates(options: {
	agentDir: string;
	sinceMs: number;
	currentSessionFile?: string;
	skip?: Set<string>;
}): Promise<CorrectionCandidate[]> {
	const files = await newestSessionFiles(path.join(options.agentDir, "sessions"), {
		exclude: options.currentSessionFile,
		limit: SESSION_LIMIT,
		sinceMs: options.sinceMs,
	});
	const all = (await Promise.all(files.map((file) => sessionCandidates(file, options.sinceMs, options.skip ?? new Set()).catch(() => [])))).flat();
	return all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, MAX_CANDIDATES);
}

function questionsFor(ids: string[]): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const id of ids) {
		questions[`${id}__correction`] = {
			type: "noul",
			instructions: `Is \`candidates.${id}.user_message\` the user correcting, rejecting, or redirecting what the agent did or proposed in \`candidates.${id}.previous_assistant\`, such as its scope, design, taste, wording, process, or amount of work?`,
			criteria: {
				true: "The user pushes back on or changes the agent's direction because it did not match what they wanted.",
				false: "A new request, an answer to the agent's question, an approval, or a follow-up that does not correct the agent.",
			},
		};
		questions[`${id}__scope`] = {
			type: "choice",
			instructions: `If \`candidates.${id}.user_message\` expresses a preference, how broadly would it apply to future work?`,
			criteria: {
				global: "A general working or taste preference likely to apply across projects, such as UI style, simplicity, testing, scope, or communication.",
				project: "Specific to this project's product, codebase, or design decisions.",
				one_off: "Only about this moment, file, or value; unlikely to matter again.",
			},
		};
	}
	return questions;
}

export async function classifyCandidates(
	candidates: CorrectionCandidate[],
	options: { fetchImpl?: typeof fetch } = {},
): Promise<FlaggedCorrection[]> {
	const flagged: FlaggedCorrection[] = [];
	for (let start = 0; start < candidates.length; start += BATCH) {
		const batch = candidates.slice(start, start + BATCH);
		const ids = batch.map((_, index) => `c${start + index + 1}`);
		const state = {
			candidates: Object.fromEntries(
				batch.map((candidate, index) => [
					ids[index],
					{ project: candidate.project, previous_assistant: candidate.previous, user_message: candidate.message },
				]),
			),
		};
		const answers = await systemOne(state, questionsFor(ids), { fetchImpl: options.fetchImpl, timeoutMs: 30_000 });
		batch.forEach((candidate, index) => {
			const correction = (answers[`${ids[index]}__correction`] as Extract<TypeSafeAnswer, { type: "noul" }> | undefined)?.noul;
			const scope = (answers[`${ids[index]}__scope`] as Extract<TypeSafeAnswer, { type: "choice" }> | undefined)?.choice as Scope | undefined;
			if (typeof correction !== "number" || !scope) throw new Error(`TypeSafe omitted answers for ${ids[index]}.`);
			if (correction >= CORRECTION_THRESHOLD && scope !== "one_off") flagged.push({ ...candidate, correction, scope });
		});
	}
	return flagged.sort((a, b) => b.correction - a.correction);
}

/**
 * Scan sessions since the last run (or the last `days`), classify with Jev, and
 * remember what was reviewed so the next run only sees new messages. An explicit
 * `days` window re-reviews everything in that window.
 */
export async function findCorrections(options: {
	agentDir?: string;
	days?: number;
	now?: number;
	currentSessionFile?: string;
	fetchImpl?: typeof fetch;
}): Promise<{ reviewed: number; flagged: FlaggedCorrection[] }> {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? Date.now();
	const state = await loadState(agentDir);
	const sinceMs = options.days !== undefined ? now - options.days * DAY_MS : (state.lastRun ?? now - DEFAULT_DAYS * DAY_MS);
	const skip = options.days !== undefined ? new Set<string>() : new Set(state.reviewed);
	const candidates = await collectCandidates({ agentDir, sinceMs, currentSessionFile: options.currentSessionFile, skip });
	const flagged = candidates.length ? await classifyCandidates(candidates, { fetchImpl: options.fetchImpl }) : [];
	const reviewed = new Set(state.reviewed);
	for (const candidate of candidates) reviewed.add(candidate.key);
	await saveState(agentDir, { lastRun: now, reviewed: [...reviewed] });
	return { reviewed: candidates.length, flagged };
}

export function correctionPrompt(flagged: FlaggedCorrection[], preferences = preferencesPath()): string {
	const evidence = flagged
		.map((item, index) =>
			[
				`### ${index + 1}. ${item.scope} · correction ${item.correction.toFixed(2)}`,
				`Project: ${item.project ?? "unknown"} · ${item.date?.slice(0, 10) ?? ""} · ${item.key}`,
				`Agent before: ${item.previous}`,
				`User: ${item.message}`,
			].join("\n"),
		)
		.join("\n\n");
	return `Review these corrections I gave agents in past sessions and turn the durable ones into rules.

1. Group evidence that expresses the same preference. Drop one-offs, anything that is not really a correction, and rules already covered by \`${preferences}\` or the relevant project's AGENTS.md.
2. Phrase each rule as one concise, positive instruction for a coding agent.
3. Ask me to approve them with one ask_user_question chain: one question per rule, with its evidence in details. Options: "Keep: global", "Keep: project (<path>)" when a project applies, and "Reject". Treat my notes as edits to the rule.
4. Write only approved rules. Global rules: append a bullet to \`${preferences}\` (create it as a plain bullet list if missing). Project rules: append a bullet under a "## Preferences" section in that project's AGENTS.md (create the section or file if needed). Change nothing else. If I discard the questionnaire, write nothing.
5. Report what was saved and where.

## Evidence

${evidence}`;
}

export default function correctionsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("corrections", {
		description: "Find recurring corrections in recent sessions and turn approved ones into rules: /corrections [days]",
		handler: async (args, ctx) => {
			const input = args.trim();
			const days = input ? Number(input) : undefined;
			if (days !== undefined && !(Number.isFinite(days) && days > 0)) {
				ctx.ui.notify("Usage: /corrections [days]", "error");
				return;
			}
			if (!process.env.TYPESAFE_API_KEY) {
				ctx.ui.notify("Correction capture needs TYPESAFE_API_KEY.", "error");
				return;
			}
			ctx.ui.notify("Scanning recent sessions for corrections…", "info");
			let result;
			try {
				result = await findCorrections({ days, currentSessionFile: ctx.sessionManager.getSessionFile() });
			} catch (error) {
				ctx.ui.notify(`Correction capture failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (!result.flagged.length) {
				ctx.ui.notify(`Reviewed ${result.reviewed} message(s); no corrections found.`, "info");
				return;
			}
			const prompt = correctionPrompt(result.flagged);
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});
}
