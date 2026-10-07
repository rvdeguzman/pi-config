import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { correctionPrompt, findCorrections } = await import("../corrections.ts");

const line = (entry: unknown) => JSON.stringify(entry);
const assistant = (id: string, text: string) =>
	line({ type: "message", id, timestamp: "2026-10-05T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const user = (id: string, text: string, timestamp = "2026-10-05T00:00:01Z") =>
	line({ type: "message", id, timestamp, message: { role: "user", content: text } });

test("Jev-flagged corrections reach the review prompt; non-corrections, skills, and openers do not; reruns skip reviewed messages", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-corrections-test-"));
	const sessions = join(agentDir, "sessions", "--orbs--");
	await mkdir(sessions, { recursive: true });
	await writeFile(
		join(sessions, "orbs.jsonl"),
		[
			line({ type: "session", id: "s", cwd: "/repos/orbs", timestamp: "2026-10-05T00:00:00Z" }),
			user("opener", "build me an orb site"),
			assistant("a1", "I added an editorial hero with serif headings and a story section."),
			user("fix", "it's too editorial, make it utility and drop the flavor text"),
			assistant("a2", "Done. Should I deploy?"),
			user("yes", "yes deploy it"),
			assistant("a3", "Deployed."),
			user("skill", "<skill name=\"grilling\">long injected body</skill>"),
		].join("\n"),
	);
	const requests: any[] = [];
	const fetchImpl = async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		const answers: Record<string, unknown> = {};
		for (const [id, candidate] of Object.entries<any>(body.state.candidates)) {
			const correction = /too editorial/.test(candidate.user_message) ? 0.93 : 0.08;
			answers[`${id}__correction`] = { type: "noul", noul: correction };
			answers[`${id}__scope`] = { type: "choice", choice: "global", probabilities: {}, confidence: 0.8 };
		}
		return new Response(JSON.stringify({ answers }), { status: 200 });
	};
	try {
		const now = Date.parse("2026-10-07T00:00:00Z");
		const first = await findCorrections({ agentDir, now, fetchImpl });
		assert.equal(first.reviewed, 2, "only replies to the agent are reviewed; the opener and skill injection are skipped");
		assert.deepEqual(first.flagged.map((item) => item.message), ["it's too editorial, make it utility and drop the flavor text"]);

		const prompt = correctionPrompt(first.flagged, "/prefs.md");
		assert.match(prompt, /Agent before: I added an editorial hero/);
		assert.match(prompt, /User: it's too editorial/);
		assert.doesNotMatch(prompt, /yes deploy it/);

		const second = await findCorrections({ agentDir, now: now + 1_000, fetchImpl });
		assert.equal(second.reviewed, 0);
		assert.equal(requests.length, 1, "nothing new means no TypeSafe call");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
