/**
 * Recall: find relevant decisions and context from past Pi sessions and notes.
 *
 * Local lexical search builds a shortlist. When TYPESAFE_API_KEY is set, Jev
 * reranks that shortlist with one yes/no relevance judgment per candidate.
 * Without a key, or if TypeSafe is unavailable, results stay lexical.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { filesUnder, newestSessionFiles, textContent } from "./lib/session-files.ts";
import { systemOne } from "./lib/typesafe.ts";

const SESSION_LIMIT = 400;
const NOTE_LIMIT = 300;
const SHORTLIST = 24;
const DEFAULT_RESULTS = 5;
const CHUNK_CHARS = 2_400;
const SNIPPET_CHARS = 700;
const MAX_NOTE_BYTES = 200_000;
const STOP_WORDS = new Set(
	"a an and are as at be but by can do does for from how i if in into is it its me my of on or our so that the this to u up was we what when where which who why will with you your".split(" "),
);

export interface RecallCandidate {
	id: string;
	kind: "session" | "note";
	source: string;
	location?: string;
	project?: string;
	date?: string;
	text: string;
	lexical: number;
	relevance?: number;
}

export interface RecallResult {
	query: string;
	ranker: "jev" | "lexical";
	warning?: string;
	candidates: RecallCandidate[];
}

interface Chunk extends Omit<RecallCandidate, "id" | "lexical" | "relevance"> {}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.match(/[a-z0-9][a-z0-9_.-]*/g)
		?.map((word) => word.replace(/[._-]+$/g, ""))
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word)) ?? [];
}

function compact(text: string, limit = CHUNK_CHARS): string {
	const clean = text.replace(/\n{3,}/g, "\n\n").trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

async function sessionChunks(file: string): Promise<Chunk[]> {
	const chunks: Chunk[] = [];
	let project: string | undefined;
	let current: { id: string; date?: string; user: string; assistant: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		const assistant = current.assistant.join("\n\n").trim();
		const text = compact(`User: ${current.user}${assistant ? `\n\nAssistant: ${assistant}` : ""}`);
		if (words(text).length) {
			chunks.push({ kind: "session", source: file, location: current.id, project, date: current.date, text });
		}
		current = undefined;
	};
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
		if (message.role === "user") {
			flush();
			current = { id: String(entry.id ?? chunks.length), date: entry.timestamp, user: textContent(message.content), assistant: [] };
		} else if (message.role === "assistant" && current) {
			const text = textContent(message.content).trim();
			if (text) current.assistant.push(text);
		}
	}
	flush();
	return chunks;
}

function markdownChunks(file: string, text: string, date?: string): Chunk[] {
	const sections = text.split(/(?=^#{1,4}\s)/m);
	const chunks: Chunk[] = [];
	for (const section of sections) {
		const heading = section.match(/^#{1,4}\s+(.+)$/m)?.[1]?.trim();
		for (let start = 0; start < section.length; start += CHUNK_CHARS) {
			const body = compact(section.slice(start, start + CHUNK_CHARS));
			if (words(body).length) chunks.push({ kind: "note", source: file, location: heading, date, text: body });
		}
	}
	return chunks;
}

async function noteChunks(cwd: string, agentDir: string): Promise<Chunk[]> {
	const roots = [cwd, path.join(agentDir, "research")];
	const files = new Set<string>();
	for (const root of roots) {
		for (const file of await filesUnder(root, (candidate) => candidate.endsWith(".md"), NOTE_LIMIT, root === cwd ? 4 : 2)) {
			files.add(path.resolve(file));
		}
	}
	for (const file of await filesUnder(agentDir, (candidate) => /(?:SPEC|README)\.md$/.test(candidate), 30, 1)) {
		files.add(path.resolve(file));
	}
	const chunks: Chunk[] = [];
	for (const file of files) {
		try {
			const info = await stat(file);
			if (info.size > MAX_NOTE_BYTES) continue;
			chunks.push(...markdownChunks(file, await readFile(file, "utf8"), info.mtime.toISOString()));
		} catch {
			// A note can disappear during search.
		}
	}
	return chunks;
}

export function rankLexically(query: string, chunks: Chunk[], cwd?: string, limit = SHORTLIST): RecallCandidate[] {
	const terms = [...new Set(words(query))];
	if (!terms.length) return [];
	const docs = chunks.map((chunk) => words(`${chunk.location ?? ""}\n${chunk.text}`));
	const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
	const documentFrequency = new Map(terms.map((term) => [term, docs.filter((doc) => doc.includes(term)).length]));
	const scored = chunks.map((chunk, index) => {
		const counts = new Map<string, number>();
		for (const word of docs[index]!) counts.set(word, (counts.get(word) ?? 0) + 1);
		let score = 0;
		for (const term of terms) {
			const frequency = counts.get(term) ?? 0;
			if (!frequency) continue;
			const df = documentFrequency.get(term)!;
			const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
			score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * docs[index]!.length / Math.max(averageLength, 1))));
		}
		if (cwd && chunk.project && path.resolve(chunk.project) === path.resolve(cwd)) score *= 1.15;
		return { ...chunk, lexical: score };
	});
	return scored
		.filter((candidate) => candidate.lexical > 0)
		.sort((a, b) => b.lexical - a.lexical)
		.slice(0, limit)
		.map((candidate, index) => ({ ...candidate, id: `c${index + 1}` }));
}

export async function rerankWithJev(
	query: string,
	candidates: RecallCandidate[],
	apiKey = process.env.TYPESAFE_API_KEY,
	fetchImpl: typeof fetch = fetch,
): Promise<RecallCandidate[]> {
	if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set.");
	if (!candidates.length) return [];
	const state = {
		query,
		candidates: Object.fromEntries(
			candidates.map((candidate) => [
				candidate.id,
				{ kind: candidate.kind, project: candidate.project, location: candidate.location, date: candidate.date, text: candidate.text },
			]),
		),
	};
	const questions = Object.fromEntries(
		candidates.map((candidate) => [
			candidate.id,
			{
				type: "noul",
				instructions: `Would \`candidates.${candidate.id}\` help a coding agent recall decisions, constraints, implementation history, or context needed for \`query\`?`,
				criteria: {
					true: "Directly contains relevant prior decisions, requirements, constraints, implementation details, or outcomes.",
					false: "Only shares words or a broad topic, or would not help with the query.",
				},
			},
		]),
	);
	const answers = (await systemOne(state, questions, { apiKey, fetchImpl })) as Record<string, { noul?: unknown }>;
	return candidates
		.map((candidate) => {
			const relevance = answers[candidate.id]?.noul;
			if (typeof relevance !== "number" || !Number.isFinite(relevance)) throw new Error(`TypeSafe omitted ${candidate.id}.`);
			return { ...candidate, relevance };
		})
		.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.lexical - a.lexical);
}

export async function recall(
	query: string,
	options: { cwd: string; currentSessionFile?: string; limit?: number; agentDir?: string; fetchImpl?: typeof fetch },
): Promise<RecallResult> {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("Recall query must not be empty.");
	const agentDir = options.agentDir ?? getAgentDir();
	const sessions = await newestSessionFiles(path.join(agentDir, "sessions"), {
		exclude: options.currentSessionFile,
		limit: SESSION_LIMIT,
	});
	const chunks = [
		...(await Promise.all(sessions.map((file) => sessionChunks(file).catch(() => [])))).flat(),
		...(await noteChunks(options.cwd, agentDir)),
	];
	const shortlist = rankLexically(trimmed, chunks, options.cwd);
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_RESULTS, 10));
	try {
		return {
			query: trimmed,
			ranker: "jev",
			candidates: (await rerankWithJev(trimmed, shortlist, process.env.TYPESAFE_API_KEY, options.fetchImpl)).slice(0, limit),
		};
	} catch (error) {
		return {
			query: trimmed,
			ranker: "lexical",
			warning: `${error instanceof Error ? error.message : String(error)} Showing lexical matches.`,
			candidates: shortlist.slice(0, limit),
		};
	}
}

export function formatRecall(result: RecallResult): string {
	const lines = [`Recall for: ${result.query}`, `Ranker: ${result.ranker}${result.warning ? ` (${result.warning})` : ""}`];
	if (!result.candidates.length) return [...lines, "", "No matches found."].join("\n");
	for (const [index, candidate] of result.candidates.entries()) {
		const score = candidate.relevance === undefined ? `lexical ${candidate.lexical.toFixed(2)}` : `relevance ${candidate.relevance.toFixed(2)}`;
		const where = [candidate.source, candidate.location ? `#${candidate.location}` : ""].join("");
		const meta = [candidate.kind, candidate.date?.slice(0, 10), candidate.project].filter(Boolean).join(" · ");
		lines.push(
			"",
			`${index + 1}. ${where}`,
			`   ${meta} · ${score}`,
			candidate.text.length > SNIPPET_CHARS ? `${candidate.text.slice(0, SNIPPET_CHARS - 1)}…` : candidate.text,
		);
	}
	return lines.join("\n");
}

const RecallParams = Type.Object({
	query: Type.String({ description: "What prior decision, implementation, or context to recall" }),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Maximum results (default 5)" })),
});

export default function recallExtension(pi: ExtensionAPI): void {
	const run = (query: string, ctx: ExtensionContext, limit?: number) =>
		recall(query, { cwd: ctx.cwd, currentSessionFile: ctx.sessionManager.getSessionFile(), limit });

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search past Pi sessions and local notes for relevant decisions, constraints, implementation history, or project context. Reranks with Jev when TYPESAFE_API_KEY is configured.",
		promptSnippet: "Recall relevant decisions and context from past Pi sessions and local notes",
		promptGuidelines: ["Use recall when resuming earlier work or when prior decisions, constraints, or implementation history are likely relevant."],
		parameters: RecallParams,
		async execute(_toolCallId, params: { query: string; limit?: number }, _signal, _onUpdate, ctx) {
			const result = await run(params.query, ctx, params.limit);
			return { content: [{ type: "text" as const, text: formatRecall(result) }], details: result };
		},
	});

	pi.registerCommand("recall", {
		description: "Recall decisions and context from past sessions and notes: /recall <query>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /recall <query>", "error");
				return;
			}
			ctx.ui.notify("Recalling…", "info");
			const result = await run(args, ctx);
			pi.sendMessage({ customType: "recall-result", content: formatRecall(result), display: true, details: result });
		},
	});
}
