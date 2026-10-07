import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type FauxResponseStep, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const { default: euler } = await import("../euler.ts");
const { parseGoalArgs, readGoal, runCheck } = await import("../lib/euler-goal.ts");

type Context = { messages: Array<{ role: string; content?: unknown; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> }> };

/** Tools declared to the model by the request's system messages. */
function declared(context: Context): Set<string> {
	const tools = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return tools;
}

const lastMessage = (context: Context) => JSON.stringify(context.messages.at(-1));

let providers = 0;

/**
 * A real Pi session running Euler against a scripted model, with a stub
 * ask_user_question tool and proxy_ask, which reaches it through executeTool().
 */
async function goalSession(t: TestContext, options: { askExposure?: "direct" | "deferred" } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "euler-goal-"));
	const faux = fauxProvider({ provider: `goal-faux-${++providers}` });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, "auth.json"), modelsPath: null });
	runtime.registerNativeProvider(faux.provider);
	let asked = 0;
	// Assertions inside scripted replies surface as provider errors, which a finished goal would swallow.
	const failures: unknown[] = [];
	const script = (steps: FauxResponseStep[]) =>
		faux.setResponses(
			steps.map((step) =>
				typeof step !== "function"
					? step
					: async (...args: Parameters<typeof step>) => {
							try {
								return await step(...args);
							} catch (error) {
								failures.push(error);
								throw error;
							}
						},
			),
		);
	const askTool = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "ask_user_question",
			label: "Ask",
			description: "Ask the user a question",
			parameters: Type.Object({ question: Type.String() }),
			exposure: options.askExposure ?? "direct",
			execute: async () => {
				asked++;
				return { content: [{ type: "text", text: "yes" }], details: undefined };
			},
		});
		pi.registerTool({
			name: "proxy_ask",
			label: "Proxy",
			description: "Ask through another tool",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _update, ctx) => {
				const outcome = await ctx.executeTool("ask_user_question", { question: "which one?" });
				return { content: [{ type: "text", text: JSON.stringify(outcome).slice(0, 500) }], details: undefined };
			},
		});
	};
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: getAgentDir(),
		extensionFactories: [
			{ name: "euler", factory: euler },
			{ name: "ask", factory: askTool },
		],
	});
	await loader.reload();
	const manager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: getAgentDir(),
		modelRuntime: runtime,
		model: faux.getModel() as Model<Api>,
		resourceLoader: loader,
		sessionManager: manager,
	});
	await session.bindExtensions({});
	t.after(async () => {
		session.dispose();
		await fs.rm(dir, { recursive: true, force: true });
	});
	/** Submit input and wait until Pi stays idle (goal checks run between model calls). */
	const run = async (text: string) => {
		await session.prompt(text);
		for (let stable = 0; stable < 3; ) {
			await sleep(15);
			stable = session.isIdle ? stable + 1 : 0;
		}
		if (failures.length) throw failures[0];
	};
	return { dir, faux, script, session, manager, run, goal: () => readGoal(manager.getBranch() as never), asked: () => asked };
}

test("a goal continues until its check passes; the agent's done report alone does not end it", async (t) => {
	const s = await goalSession(t);
	s.script([
		(context) => {
			assert.ok(declared(context as Context).has("goal_checkpoint"));
			assert.match(JSON.stringify(context.messages), /Objective: make ok exist/);
			return fauxAssistantMessage(fauxToolCall("goal_checkpoint", { status: "done", note: "claimed early" }), { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage("Done."),
		(context) => {
			assert.match(lastMessage(context as Context), /Goal iteration 2\/5 · `test -f ok` failed \(exit 1\)\. Your done checkpoint was not accepted/);
			writeFileSync(path.join(s.dir, "ok"), "");
			return fauxAssistantMessage("Created ok.");
		},
	]);
	await s.run('/goal make ok exist --until "test -f ok" --max 5');

	assert.equal(s.faux.state.callCount, 3);
	const goal = s.goal()!;
	assert.equal(goal.end?.reason, "done");
	assert.deepEqual(goal.iterations.map((iteration) => [iteration.checkpoint?.status, iteration.check?.code]), [["done", 1], [undefined, 0]]);
	assert.ok(!s.session.getActiveToolNames().includes("goal_checkpoint"), "goal tools are removed once the goal ends");
});

test("a goal stops at its iteration budget, and a later prompt does not restart it", async (t) => {
	const s = await goalSession(t);
	s.script([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	await s.run("/goal never finishes --until false --max 2");
	assert.equal(s.faux.state.callCount, 2);
	assert.equal(s.goal()!.end?.reason, "capped");

	await s.run("thanks");
	assert.equal(s.faux.state.callCount, 3);
	assert.equal(s.goal()!.iterations.length, 2);
});

test("interrupting a goal ends it, so the next prompt does not resume the loop", async (t) => {
	const s = await goalSession(t);
	s.script([
		() => {
			void s.session.abort(); // Esc mid-reply
			return fauxAssistantMessage("partial");
		},
		() => fauxAssistantMessage("an unrelated answer"),
	]);
	await s.run("/goal keep going --until false --max 5");
	assert.equal(s.goal()!.end?.reason, "interrupted");

	await s.run("unrelated question");
	assert.equal(s.faux.state.callCount, 2);
	assert.equal(s.goal()!.iterations.length, 1);
});

test("an away goal cannot ask the user, and ends with a report turn", async (t) => {
	const s = await goalSession(t);
	s.script([
		(context) => {
			assert.ok(!declared(context as Context).has("ask_user_question"));
			assert.match(JSON.stringify(context.messages), /# Away/);
			return fauxAssistantMessage(fauxToolCall("ask_user_question", { question: "which one?" }), { stopReason: "toolUse" });
		},
		() => {
			writeFileSync(path.join(s.dir, "ok"), "");
			return fauxAssistantMessage("Picked the reversible default and created ok.");
		},
		(context) => {
			assert.match(lastMessage(context as Context), /Write the report for the user's return/);
			assert.ok(!declared(context as Context).has("ask_user_question"), "the report turn still cannot ask");
			return fauxAssistantMessage("Report.");
		},
	]);
	await s.run('/goal --away make ok exist --until "test -f ok"');

	assert.equal(s.faux.state.callCount, 3);
	assert.equal(s.asked(), 0);
	assert.equal(s.goal()!.end?.reason, "done");
	const tools = s.session.getActiveToolNames();
	assert.ok(tools.includes("ask_user_question") && !tools.includes("goal_checkpoint"), "tools are restored after the report");
});

test("a deferred ask tool reached through executeTool stays blocked for the whole away run, report included", async (t) => {
	const s = await goalSession(t, { askExposure: "deferred" });
	s.script([
		fauxAssistantMessage(fauxToolCall("proxy_ask", {}), { stopReason: "toolUse" }),
		() => {
			writeFileSync(path.join(s.dir, "ok"), "");
			return fauxAssistantMessage("Created ok.");
		},
		fauxAssistantMessage(fauxToolCall("proxy_ask", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Report."),
	]);
	await s.run('/goal --away make ok exist --until "test -f ok"');
	assert.equal(s.faux.state.callCount, 4);
	assert.equal(s.asked(), 0);
});

test("navigating back into a finished goal does not revive it on the next prompt", async (t) => {
	const s = await goalSession(t);
	s.script([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("an unrelated answer")]);
	await s.run("/goal never finishes --until false --max 2");
	assert.equal(s.goal()!.end?.reason, "capped");
	const firstReply = s.manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "assistant")!;

	await s.session.navigateTree(firstReply.id);
	await s.run("unrelated question");
	assert.equal(s.faux.state.callCount, 3);
	assert.equal(s.goal()!.iterations.length, 1, "no goal iteration was added on the new branch");
});

test("/goal stop during the startup check cancels the goal", async (t) => {
	const s = await goalSession(t);
	s.script([fauxAssistantMessage("should not run")]);
	const starting = s.session.prompt('/goal slow start --until "sleep 0.4; false"');
	await sleep(100);
	await s.session.prompt("/goal stop");
	await starting;
	await s.run("/goal status");
	assert.equal(s.faux.state.callCount, 0);
	assert.equal(s.goal(), undefined);
});

test("a check killed by a signal never counts as passing", async (t) => {
	const s = await goalSession(t);
	s.script([
		() => {
			writeFileSync(path.join(s.dir, "ok"), "");
			return fauxAssistantMessage("Created ok.");
		},
		(context) => {
			assert.match(lastMessage(context as Context), /was killed by SIGTERM/);
			return fauxAssistantMessage("Still trying.");
		},
	]);
	await s.run(`/goal make ok exist --until 'test -f ok && kill -TERM $$' --max 2`);
	assert.equal(s.faux.state.callCount, 2);
	assert.equal(s.goal()!.end?.reason, "capped");
});

test("a check that ignores SIGTERM is still killed after the grace period", async () => {
	const started = Date.now();
	const result = await runCheck("trap '' TERM; sleep 20; exit 0", { cwd: os.tmpdir(), timeoutMs: 50, killGraceMs: 100 });
	assert.ok(Date.now() - started < 3_000, "the check did not outlive its timeout");
	assert.equal(result.code, -1);
	assert.equal(result.timedOut, true);
});

test("a check that already passes cannot start a goal", async (t) => {
	const s = await goalSession(t);
	await s.run("/goal anything --until true");
	assert.equal(s.faux.state.callCount, 0);
	assert.equal(s.goal(), undefined);
});

test("goal flags accept quoted and unquoted checks without swallowing other flags", () => {
	assert.deepEqual(parseGoalArgs("fix the parser --until make check --max 3 --away"), {
		objective: "fix the parser",
		check: "make check",
		max: 3,
		away: true,
	});
	assert.deepEqual(parseGoalArgs(`ship it --until "npm test -- --grep 'a b'"`), {
		objective: "ship it",
		check: "npm test -- --grep 'a b'",
		max: undefined,
		away: false,
	});
	assert.ok("error" in parseGoalArgs("x --max 0"));
});
