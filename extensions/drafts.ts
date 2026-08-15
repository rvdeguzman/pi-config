import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Draft = { text: string; createdAt: string };

const file = join(homedir(), ".pi", "agent", "drafts.json");

async function load(): Promise<Draft[]> {
	try {
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		return Array.isArray(value)
			? value.filter((d): d is Draft => !!d && typeof d === "object" && typeof (d as Draft).text === "string")
			: [];
	} catch {
		return [];
	}
}

async function save(drafts: Draft[]) {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");
	await rename(tmp, file);
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("alt+d", {
		description: "Save the current prompt or pick a draft",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;

			const text = ctx.ui.getEditorText().trim();
			const drafts = await load();

			if (text) {
				drafts.unshift({ text, createdAt: new Date().toISOString() });
				await save(drafts);
				ctx.ui.setEditorText("");
				ctx.ui.notify("Prompt saved to drafts", "info");
				return;
			}

			if (!drafts.length) {
				ctx.ui.notify("No drafts", "info");
				return;
			}

			const choice = await ctx.ui.select(
				"Pick a draft (restores and removes it)",
				drafts.map((draft) => draft.text.replace(/\s+/g, " ").slice(0, 100)),
			);
			if (choice === undefined) return;

			const index = drafts.findIndex(
				(draft) => draft.text.replace(/\s+/g, " ").slice(0, 100) === choice,
			);
			if (index < 0) return;
			const [draft] = drafts.splice(index, 1);
			await save(drafts);
			ctx.ui.setEditorText(draft.text);
		},
	});
}
