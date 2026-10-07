/** Shared helpers for reading Pi session transcripts and local notes. */

import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

const IGNORED_DIRS = new Set([".git", ".repos", "node_modules", "dist", "build", "target", ".next", ".venv", "out"]);

/** Visible text of a message: strings and text blocks only (no thinking, images, or tool calls). */
export function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => String((block as { text?: unknown }).text ?? ""))
		.join("\n");
}

export async function filesUnder(root: string, accept: (file: string) => boolean, limit: number, depth = 5): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string, level: number): Promise<void> => {
		if (files.length >= limit || level > depth) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= limit) return;
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) await walk(file, level + 1);
			} else if (entry.isFile() && accept(file)) {
				files.push(file);
			}
		}
	};
	await walk(root, 0);
	return files;
}

/** Session files under `root`, newest first, optionally modified since `sinceMs`. */
export async function newestSessionFiles(
	root: string,
	options: { exclude?: string; limit: number; sinceMs?: number },
): Promise<string[]> {
	const exclude = options.exclude && path.resolve(options.exclude);
	const files = await filesUnder(root, (file) => file.endsWith(".jsonl") && path.resolve(file) !== exclude, 10_000, 3);
	const dated = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
	return dated
		.filter((item) => options.sinceMs === undefined || item.mtime >= options.sinceMs)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, options.limit)
		.map((item) => item.file);
}
