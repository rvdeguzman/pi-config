import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { recall } = await import("../recall.ts");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-recall-test-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const sessions = join(agentDir, "sessions", "--project--");
	await mkdir(sessions, { recursive: true });
	await mkdir(join(project, "docs"), { recursive: true });
	const session = (id: string, user: string, assistant: string, tool = "") =>
		[
			{ type: "session", id, cwd: project, timestamp: "2026-10-01T00:00:00Z" },
			{ type: "message", id: `${id}-u`, timestamp: "2026-10-01T00:00:01Z", message: { role: "user", content: user } },
			...(tool
				? [{ type: "message", id: `${id}-t`, message: { role: "toolResult", content: [{ type: "text", text: tool }] } }]
				: []),
			{ type: "message", id: `${id}-a`, timestamp: "2026-10-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: assistant }] } },
		].map((entry) => JSON.stringify(entry)).join("\n");
	const current = join(sessions, "current.jsonl");
	await writeFile(join(sessions, "past.jsonl"), session("past", "Use iCloud sync for narrator", "Decision: each device writes its own state file."));
	await writeFile(join(sessions, "noise.jsonl"), session("noise", "unrelated", "nothing useful", "ICLOUD_SECRET_IN_TOOL_OUTPUT"));
	await writeFile(current, session("current", "What did we decide about iCloud sync?", "Searching."));
	await writeFile(join(project, "docs", "plan.md"), "# Sync\n\nThe iCloud merge picks the latest updatedAt per book.\n");
	return { root, agentDir, project, current };
}

test("recall searches conversation text and notes, excludes the current session and tool output, then lets Jev rank", async () => {
	const { root, agentDir, project, current } = await fixture();
	const previous = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "test-key";
	let request: any;
	try {
		const result = await recall("iCloud sync decision", {
			cwd: project,
			agentDir,
			currentSessionFile: current,
			fetchImpl: async (_url, init) => {
				request = JSON.parse(String(init?.body));
				const answers = Object.fromEntries(
					Object.entries(request.state.candidates).map(([id, candidate]: [string, any]) => [
						id,
						{ type: "noul", noul: candidate.kind === "note" ? 0.95 : 0.4 },
					]),
				);
				return new Response(JSON.stringify({ answers }), { status: 200 });
			},
		});
		assert.equal(result.ranker, "jev");
		assert.deepEqual(result.candidates.map((candidate) => candidate.kind), ["note", "session"]);
		assert.match(result.candidates[1]!.text, /each device writes its own state file/);
		const sent = JSON.stringify(request);
		assert.doesNotMatch(sent, /What did we decide/);
		assert.doesNotMatch(sent, /ICLOUD_SECRET_IN_TOOL_OUTPUT/);
	} finally {
		if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("recall falls back to local lexical results when TypeSafe is unavailable", async () => {
	const { root, agentDir, project, current } = await fixture();
	const previous = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "test-key";
	try {
		const result = await recall("device state file", {
			cwd: project,
			agentDir,
			currentSessionFile: current,
			fetchImpl: async () => new Response("overloaded", { status: 529 }),
		});
		assert.equal(result.ranker, "lexical");
		assert.match(result.warning!, /HTTP 529/);
		assert.match(result.candidates[0]!.text, /each device writes its own state file/);
	} finally {
		if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previous;
		await rm(root, { recursive: true, force: true });
	}
});
