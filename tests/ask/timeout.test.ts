import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import askExtension from "../../extensions/ask.ts";
import { K, check, driveDialog, report, test, type } from "./harness.ts";

let askTool: any;
askExtension({ registerTool: (definition: any) => (askTool = definition) } as any);

const TEMP_ROOT = "/tmp/ask-timeout-tests";
const GLOBAL_DIR = join(TEMP_ROOT, "global");
const PROJECT_ROOT = join(TEMP_ROOT, "project");
const WAIT_PAST_ONE_SECOND = 1_150;

const baseQuestion = (overrides: Record<string, unknown> = {}) => ({
	id: "storage",
	question: "Where should sessions live?",
	header: "Storage",
	options: [{ label: "SQLite" }, { label: "JSONL" }, { label: "Postgres" }],
	...overrides,
});

function resetTemp(): void {
	rmSync(TEMP_ROOT, { recursive: true, force: true });
	mkdirSync(GLOBAL_DIR, { recursive: true });
	mkdirSync(PROJECT_ROOT, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = GLOBAL_DIR;
}

function writeGlobal(value: unknown): void {
	mkdirSync(GLOBAL_DIR, { recursive: true });
	writeFileSync(join(GLOBAL_DIR, "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function writeProject(value: unknown, cwd = PROJECT_ROOT): void {
	const dir = join(cwd, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
}

type Driver = (
	component: Parameters<Parameters<typeof driveDialog>[0]>[0],
	render: Parameters<Parameters<typeof driveDialog>[0]>[1],
	state: ReturnType<typeof driveDialog>["state"],
) => void | Promise<void>;

async function execute(
	questions: Array<Record<string, unknown>>,
	drive: Driver,
	cwd = PROJECT_ROOT,
) {
	let driven!: ReturnType<typeof driveDialog>;
	driven = driveDialog((component, render) => drive(component, render, driven.state), { cwd, watchdogMs: 1_900 });
	const result = await askTool.execute("timeout-test", { questions }, undefined, undefined, driven.ctx);
	return { result, ...driven };
}

await test("1. defaults: no countdown, no automatic submission, one notification", async () => {
	resetTemp(); // Neither global nor project settings file exists.
	let initial = "";
	let outcomeBeforeAnswer: unknown;
	const { result, state } = await execute([baseQuestion()], async (component, render, liveState) => {
		initial = render();
		await Bun.sleep(100);
		outcomeBeforeAnswer = liveState.outcome;
		type(component, K.enter);
	});
	check("default footer has no countdown", !initial.includes("auto in"), initial);
	check("default does not auto-submit", outcomeBeforeAnswer === undefined, outcomeBeforeAnswer);
	check("default sends exactly one notification", state.notifications.length === 1, state.notifications);
	check("default notification text is exact", state.notifications[0]?.message === "Waiting for input", state.notifications);
	check("normal answer still works", result.details.selectedOptions[0] === "SQLite", result.details);
});

await test("2a. timeout: 1 auto-selects the recommended option", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 1, notify: "off" } });
	let initial = "";
	const { result, state } = await execute([baseQuestion({ recommended: 1 })], async (_component, render) => {
		initial = render();
		await Bun.sleep(WAIT_PAST_ONE_SECOND);
	});
	check("countdown is rendered", /auto in 1s/.test(initial), initial);
	check("recommended option is selected", result.details.selectedOptions[0] === "JSONL", result.details);
	check("details marks timeout", result.details.timedOut === true, result.details);
	check("result text marks timeout", result.content[0].text.includes("auto-selected after timeout"), result.content[0].text);
	check("notify off suppresses notification", state.notifications.length === 0, state.notifications);
}, 1_800);

await test("2b. timeout without recommended auto-selects the first option", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 1 } });
	const { result } = await execute([baseQuestion()], async () => {
		await Bun.sleep(WAIT_PAST_ONE_SECOND);
	});
	check("first option is selected", result.details.selectedOptions[0] === "SQLite", result.details);
	check("first-option fallback is marked timed out", result.details.timedOut === true, result.details);
}, 1_800);

await test("3. any keypress permanently cancels the timeout", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 1 } });
	let afterKey = "";
	let outcomeAfterDeadline: unknown;
	const { result, state } = await execute([baseQuestion({ recommended: 2 })], async (component, render, liveState) => {
		type(component, K.up); // From recommended Postgres to JSONL; cancels the global dialog timer.
		afterKey = render();
		await Bun.sleep(WAIT_PAST_ONE_SECOND);
		outcomeAfterDeadline = liveState.outcome;
		type(component, K.enter); // User's own answer: JSONL.
	});
	check("countdown disappears after keypress", !afterKey.includes("auto in"), afterKey);
	check("dialog remains open past old deadline", outcomeAfterDeadline === undefined, outcomeAfterDeadline);
	check("user answer wins", result.details.selectedOptions[0] === "JSONL", result.details);
	check("user answer has no timedOut flag", result.details.timedOut === undefined, result.details);
}, 1_800);

await test("4. project settings override global timeout and notify", async () => {
	resetTemp();
	writeGlobal({ ask: { timeout: 1, notify: "off" } });
	writeProject({ ask: { timeout: 0, notify: "on" } });
	let initial = "";
	let beforeAnswer: unknown;
	const { result, state } = await execute([baseQuestion({ recommended: 2 })], async (component, render, liveState) => {
		initial = render();
		await Bun.sleep(100);
		beforeAnswer = liveState.outcome;
		type(component, K.enter);
	});
	check("project timeout=0 overrides global timeout=1", !initial.includes("auto in") && beforeAnswer === undefined, initial);
	check("project notify=on overrides global notify=off", state.notifications.length === 1, state.notifications);
	check("override notification text is exact", state.notifications[0]?.message === "Waiting for input", state.notifications);
	check("no global timeout leaked into answer", result.details.timedOut === undefined, result.details);
});

await test("5. explicit notify on and off semantics", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 0, notify: "off" } });
	const off = await execute([baseQuestion()], (component) => type(component, K.enter));
	check("notify off emits no notification", off.state.notifications.length === 0, off.state.notifications);

	writeProject({ ask: { timeout: 0, notify: "on" } });
	const on = await execute([baseQuestion()], (component) => type(component, K.enter));
	check("notify on emits exactly once", on.state.notifications.length === 1, on.state.notifications);
	check("notify on message is exact", on.state.notifications[0]?.message === "Waiting for input", on.state.notifications);
});

await test("6. explicit timeout zero disables countdown and auto-submit", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 0 } });
	let initial = "";
	let beforeAnswer: unknown;
	const { result, state } = await execute([baseQuestion()], async (component, render, liveState) => {
		initial = render();
		await Bun.sleep(100);
		beforeAnswer = liveState.outcome;
		type(component, K.enter);
	});
	check("timeout zero has no countdown", !initial.includes("auto in"), initial);
	check("timeout zero does not auto-submit", beforeAnswer === undefined, beforeAnswer);
	check("timeout zero answer is not marked timed out", result.details.timedOut === undefined, result.details);
});

await test("7. malformed settings fall back safely", async () => {
	const variants: Array<[string, string | object | undefined]> = [
		["missing settings file", undefined],
		["non-object ask", { ask: "bad" }],
		["negative timeout", { ask: { timeout: -1 } }],
		["string timeout", { ask: { timeout: "1" } }],
		["unparseable JSON", "{ definitely not json"],
	];

	for (const [name, settings] of variants) {
		resetTemp();
		if (settings !== undefined) writeProject(settings);
		let initial = "";
		let result: any;
		let thrown: unknown;
		try {
			({ result } = await execute([baseQuestion()], (component, render) => {
				initial = render();
				type(component, K.enter);
			}));
		} catch (error) {
			thrown = error;
		}
		check(`${name}: does not throw`, thrown === undefined, thrown);
		check(`${name}: falls back to no timeout`, !initial.includes("auto in"), initial);
		check(`${name}: normal answer succeeds`, result?.details?.selectedOptions?.[0] === "SQLite", result?.details);
	}
});

await test("8a. multi-question timeout auto-selects every unanswered question", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 1, notify: "off" } });
	const second = {
		id: "migration",
		question: "Write a migration?",
		header: "Migration",
		options: [{ label: "Yes" }, { label: "No" }],
		recommended: 1,
	};
	const { result } = await execute([baseQuestion(), second], async () => {
		await Bun.sleep(WAIT_PAST_ONE_SECOND);
	});
	check("both questions return results", result.details.results.length === 2, result.details);
	check("first question gets first fallback", result.details.results[0].selectedOptions[0] === "SQLite", result.details.results[0]);
	check("second gets its recommended fallback", result.details.results[1].selectedOptions[0] === "No", result.details.results[1]);
	check("both auto-selected results are timed out", result.details.results.every((entry: any) => entry.timedOut === true), result.details.results);
	check("multi result text marks timeout", result.content[0].text.includes("auto-selected after timeout"), result.content[0].text);
}, 1_800);

await test("8b. answering the first question cancels timeout for the whole multi-question dialog", async () => {
	resetTemp();
	writeProject({ ask: { timeout: 1, notify: "off" } });
	const second = {
		id: "migration",
		question: "Write a migration?",
		header: "Migration",
		options: [{ label: "Yes" }, { label: "No" }],
		recommended: 1,
	};
	let afterFirst = "";
	let outcomeAfterDeadline: unknown;
	const { result, state } = await execute([baseQuestion(), second], async (component, render, liveState) => {
		type(component, K.enter); // Answer Q1; this keypress cancels the one dialog-wide timer.
		afterFirst = render();
		await Bun.sleep(WAIT_PAST_ONE_SECOND);
		outcomeAfterDeadline = liveState.outcome;
		type(component, K.up, K.enter); // Move off recommended No and explicitly answer Q2 = Yes; advances to Submit.
		type(component, K.enter); // Confirm Submit.
	});
	check("countdown is gone after answering Q1", !afterFirst.includes("auto in"), afterFirst);
	check("remaining question is not auto-submitted", outcomeAfterDeadline === undefined, outcomeAfterDeadline);
	check("Q1 preserves user answer", result.details.results[0].selectedOptions[0] === "SQLite", result.details.results[0]);
	check("Q2 uses later user answer, not recommended", result.details.results[1].selectedOptions[0] === "Yes", result.details.results[1]);
	check("neither result is marked timed out", result.details.results.every((entry: any) => entry.timedOut === undefined), result.details.results);
}, 1_800);

report();
