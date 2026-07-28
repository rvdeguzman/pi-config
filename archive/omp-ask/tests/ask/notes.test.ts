import { createAskTool } from "../../extensions/ask.ts";
import { K, check, driveDialog, report, test, type } from "../../../../tests/lib/harness.ts";

const askTool: any = createAskTool();

const baseQuestion = (overrides: Record<string, unknown> = {}) => ({
	id: "storage",
	question: "Where should sessions live?",
	header: "Storage",
	options: [
		{ label: "SQLite", description: "One local file" },
		{ label: "JSONL", description: "Append-only text" },
	],
	...overrides,
});

async function execute(question: Record<string, unknown>, drive: Parameters<typeof driveDialog>[0]) {
	const driven = driveDialog(drive);
	const result = await askTool.execute("note-test", { questions: [question] }, undefined, undefined, driven.ctx);
	return { result, ...driven };
}

await test("harness rejects a dialog that never calls done", async () => {
	const guarded = driveDialog(() => {}, { watchdogMs: 50 });
	let message = "";
	try {
		await (guarded.ctx.ui.custom as any)(() => ({
			render: () => [],
			handleInput: () => {},
			invalidate: () => {},
			dispose: () => {},
		}));
	} catch (error) {
		message = (error as Error).message;
	}
	check("deadlock guard rejects clearly", message === "dialog never completed within 50ms", message);
});

await test("1. attaching a note marks its row and returns details.note", async () => {
	let markedScreen = "";
	const { result } = await execute(baseQuestion(), (component, render) => {
		type(component, "n", ..."shard first".split(""), K.enter);
		markedScreen = render();
		type(component, K.enter);
	});
	check("rendered row has note marker", markedScreen.includes("✎ note"), markedScreen);
	check("answer is the noted row", result.details.selectedOptions[0] === "SQLite", result.details);
	check("details.note contains note text", result.details.note === "shard first", result.details);
});

await test("2. selecting a different radio option drops the note", async () => {
	const { result } = await execute(baseQuestion(), (component) => {
		type(component, "n", ..."only for sqlite".split(""), K.enter);
		type(component, K.down, K.enter);
	});
	check("different option is returned", result.details.selectedOptions[0] === "JSONL", result.details);
	check("note is absent after answer changes", result.details.note === undefined, result.details);
});

await test("3. unchecking a noted checkbox drops its note", async () => {
	const { result } = await execute(baseQuestion({ multi: true }), (component) => {
		type(component, "n", ..."sqlite note".split(""), K.enter);
		type(component, K.space); // check noted SQLite
		type(component, K.space); // uncheck it; note must die
		type(component, K.down, K.space); // check JSONL
		type(component, K.right, K.enter); // Submit tab, then submit
	});
	check("different checkbox remains selected", JSON.stringify(result.details.selectedOptions) === '["JSONL"]', result.details);
	check("unchecked option's note is absent", result.details.note === undefined, result.details);
});

await test("4. Escape exits note editor without cancelling ask", async () => {
	const { result, state } = await execute(baseQuestion(), (component) => {
		type(component, "n", ..."discard me".split(""), K.esc);
		type(component, K.enter);
	});
	check("ask was not aborted", state.aborted === false, state);
	check("normal answer can still be selected", result.details.selectedOptions[0] === "SQLite", result.details);
	check("abandoned note is absent", result.details.note === undefined, result.details);
});

await test("5a. Other-row note survives with real custom input", async () => {
	const { result } = await execute(baseQuestion(), (component) => {
		type(component, K.down, K.down); // Other
		type(component, "n", ..."custom rationale".split(""), K.enter);
		type(component, K.enter, ..."DuckDB".split(""), K.enter);
	});
	check("custom input is returned", result.details.customInput === "DuckDB", result.details);
	check("Other note survives with custom input", result.details.note === "custom rationale", result.details);
});

await test("5b. submitting Other empty drops its note", async () => {
	const { result } = await execute(baseQuestion(), (component) => {
		type(component, K.down, K.down); // Other
		type(component, "n", ..."custom rationale".split(""), K.enter);
		type(component, K.enter, K.enter); // open Other editor, submit empty
		type(component, K.up, K.up, K.enter); // answer SQLite normally
	});
	check("empty custom input is absent", result.details.customInput === undefined, result.details);
	check("Other note is absent without custom input", result.details.note === undefined, result.details);
	check("subsequent normal answer succeeds", result.details.selectedOptions[0] === "SQLite", result.details);
});

await test("6. reopening a noted row prefills the note editor", async () => {
	let reopenedScreen = "";
	const { result } = await execute(baseQuestion(), (component, render) => {
		type(component, "n", ..."existing rationale".split(""), K.enter);
		type(component, "n");
		reopenedScreen = render();
		type(component, K.esc, K.enter);
	});
	check("reopened editor renders existing note", reopenedScreen.includes("existing rationale"), reopenedScreen);
	check("existing note remains after reopening and backing out", result.details.note === "existing rationale", result.details);
});

await test("7. whitespace-only note is discarded", async () => {
	const { result } = await execute(baseQuestion(), (component) => {
		type(component, "n", " ", " ", " ", K.enter);
		type(component, K.enter);
	});
	check("answer still succeeds", result.details.selectedOptions[0] === "SQLite", result.details);
	check("whitespace note is absent", result.details.note === undefined, result.details);
});

report();
