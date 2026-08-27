import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentProfile {
	name: string;
	model?: string | string[];
	thinking?: ThinkingLevel;
	tools?: string[];
}

export interface ProfileRegistry {
	list(): Promise<AgentProfile[]>;
	get(name: string): Promise<AgentProfile>;
}

const PROFILE_KEYS = new Set(["name", "model", "thinking", "tools"]);
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/i;

function stringList(value: unknown, field: string, file: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`Malformed agent profile ${file}: ${field} must be a non-empty string array.`);
	}
	return value.map((item) => (item as string).trim());
}

export function parseAgentProfile(source: string, file = "<profile>"): AgentProfile {
	let frontmatter: Record<string, unknown>;
	try {
		const parsed = parseFrontmatter(source);
		frontmatter = parsed.frontmatter as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Malformed agent profile ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		throw new Error(`Malformed agent profile ${file}: YAML frontmatter is required.`);
	}
	const unsupported = Object.keys(frontmatter).filter((key) => !PROFILE_KEYS.has(key));
	if (unsupported.length > 0)
		throw new Error(`Malformed agent profile ${file}: unsupported field(s): ${unsupported.join(", ")}.`);
	if (typeof frontmatter.name !== "string" || !NAME_PATTERN.test(frontmatter.name.trim())) {
		throw new Error(`Malformed agent profile ${file}: name must match ${NAME_PATTERN}.`);
	}
	const profile: AgentProfile = { name: frontmatter.name.trim() };
	if (frontmatter.model !== undefined) {
		if (typeof frontmatter.model === "string" && frontmatter.model.trim()) profile.model = frontmatter.model.trim();
		else profile.model = stringList(frontmatter.model, "model", file);
	}
	if (frontmatter.thinking !== undefined) {
		if (typeof frontmatter.thinking !== "string" || !THINKING_LEVELS.includes(frontmatter.thinking as ThinkingLevel)) {
			throw new Error(`Malformed agent profile ${file}: invalid thinking level.`);
		}
		profile.thinking = frontmatter.thinking as ThinkingLevel;
	}
	if (frontmatter.tools !== undefined) {
		if (
			!Array.isArray(frontmatter.tools) ||
			frontmatter.tools.some((item) => typeof item !== "string" || !item.trim())
		) {
			throw new Error(`Malformed agent profile ${file}: tools must be a string array.`);
		}
		profile.tools = [...new Set(frontmatter.tools.map((item) => (item as string).trim()))];
	}
	return profile;
}

export class FileProfileRegistry implements ProfileRegistry {
	constructor(readonly directory = path.join(getAgentDir(), "agents")) {}

	private validateProfiles(files: Array<{ name: string; source: string }>): AgentProfile[] {
		const profiles: AgentProfile[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			const profile = parseAgentProfile(file.source, file.name);
			const normalized = profile.name.toLowerCase();
			if (seen.has(normalized)) throw new Error(`Duplicate agent profile name: ${profile.name}.`);
			seen.add(normalized);
			profiles.push(profile);
		}
		return profiles.sort((a, b) => a.name.localeCompare(b.name));
	}

	listSync(): AgentProfile[] {
		let names: string[];
		try {
			names = readdirSync(this.directory)
				.filter((name) => name.endsWith(".md"))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return this.validateProfiles(
			names.map((name) => ({
				name: path.join(this.directory, name),
				source: readFileSync(path.join(this.directory, name), "utf8"),
			})),
		);
	}

	async list(): Promise<AgentProfile[]> {
		let names: string[];
		try {
			names = (await readdir(this.directory)).filter((name) => name.endsWith(".md")).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return this.validateProfiles(
			await Promise.all(
				names.map(async (name) => {
					const file = path.join(this.directory, name);
					return { name: file, source: await readFile(file, "utf8") };
				}),
			),
		);
	}

	async get(name: string): Promise<AgentProfile> {
		const profiles = await this.list();
		const profile = profiles.find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase());
		if (profile) return profile;
		const available = profiles.map((candidate) => candidate.name);
		throw new Error(
			`Unknown agent profile "${name}". Available profiles: ${available.length ? available.join(", ") : "(none)"}.`,
		);
	}
}

export const subagentProfiles = new FileProfileRegistry();
