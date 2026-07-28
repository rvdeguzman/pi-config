/** Headless tests for ~/.pi/agent/extensions/ask.ts via the RPC fallback path. */
import askExtension, { createAskTool } from "../../extensions/ask.ts";

const captured: any = createAskTool();

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}`, extra ?? "");
	}
}

/** Scripted UI: `selects` are consumed in order, `editors` likewise. */
function makeCtx(opts: {
	mode?: string;
	hasUI?: boolean;
	selects?: (string | undefined)[];
	editors?: (string | undefined)[];
}) {
	const selects = [...(opts.selects ?? [])];
	const editors = [...(opts.editors ?? [])];
	const seenSelects: string[][] = [];
	let aborted = false;
	const notices: string[] = [];
	return {
		ctx: {
			mode: opts.mode ?? "rpc",
			hasUI: opts.hasUI ?? true,
			cwd: "/tmp/ask-check",
			abort: () => {
				aborted = true;
			},
			ui: {
				notify: (m: string) => notices.push(m),
				select: async (_t: string, options: string[]) => {
					seenSelects.push(options);
					return selects.shift();
				},
				editor: async () => editors.shift(),
			},
		} as any,
		state: {
			get aborted() {
				return aborted;
			},
			notices,
			seenSelects,
		},
	};
}

const run = (params: any, ctx: any) => captured.execute("id", params, undefined, undefined, ctx);
const q = (over: any = {}) => ({
	id: "storage",
	question: "Where should sessions live?",
	options: [{ label: "SQLite" }, { label: "JSONL", description: "append-only" }],
	...over,
});

console.log("\ndefinition");
check("name is ask", captured.name === "ask");
check("executionMode sequential", captured.executionMode === "sequential", captured.executionMode);
check("has promptSnippet", typeof captured.promptSnippet === "string");
check("has 7 guidelines", captured.promptGuidelines.length === 7, captured.promptGuidelines.length);

console.log("\nvalidation");
for (const [name, params, needle] of [
	["empty questions", { questions: [] }, "at least one question"],
	["blank id", { questions: [q({ id: " " })] }, "non-empty id"],
	["duplicate ids", { questions: [q(), q()] }, "Duplicate"],
	["no options", { questions: [q({ options: [] })] }, "no options"],
	[
		"reserved Other label",
		{ questions: [q({ options: [{ label: "Other (type your own)" }, { label: "x" }] })] },
		"reserved option label",
	],
	[
		"reserved Chat label",
		{ questions: [q({ options: [{ label: "Chat about this" }, { label: "x" }] })] },
		"reserved option label",
	],
] as const) {
	const { ctx } = makeCtx({});
	let message = "";
	try {
		await run(params, ctx);
	} catch (error) {
		message = (error as Error).message;
	}
	check(`rejects ${name}`, message.includes(needle), message);
}

console.log("\nheadless");
{
	const { ctx } = makeCtx({ hasUI: false });
	let message = "";
	try {
		await run({ questions: [q()] }, ctx);
	} catch (error) {
		message = (error as Error).message;
	}
	check("throws without UI", message.includes("No interactive UI"), message);
}

console.log("\nsingle select");
{
	const { ctx, state } = makeCtx({ selects: ["SQLite"] });
	const result = await run({ questions: [q()] }, ctx);
	check("text reports selection", result.content[0].text === "User selected: SQLite", result.content[0].text);
	check("details flattened (no results[])", result.details.results === undefined);
	check("details.selectedOptions", JSON.stringify(result.details.selectedOptions) === '["SQLite"]');
	check("notified while waiting", state.notices[0] === "Waiting for input", state.notices);
	const rows = state.seenSelects[0];
	check("appends Other + Chat rows", rows.at(-2) === "Other (type your own)" && rows.at(-1) === "Chat about this", rows);
}

console.log("\nrecommended suffix");
{
	const { ctx, state } = makeCtx({ selects: ["JSONL (Recommended)"] });
	const result = await run({ questions: [q({ recommended: 1 })] }, ctx);
	check("suffix shown in UI", state.seenSelects[0][1] === "JSONL (Recommended)", state.seenSelects[0]);
	check("suffix stripped from result", result.details.selectedOptions[0] === "JSONL", result.details.selectedOptions);
}

console.log("\nOther / custom input");
{
	const { ctx } = makeCtx({ selects: ["Other (type your own)"], editors: ["  postgres  "] });
	const result = await run({ questions: [q()] }, ctx);
	check("customInput trimmed", result.details.customInput === "postgres", result.details.customInput);
	check("text reports custom", result.content[0].text.includes("User provided custom input: postgres"));
}

console.log("\nChat about this");
{
	const { ctx } = makeCtx({ selects: ["Chat about this"] });
	const result = await run({ questions: [q()] }, ctx);
	check("chatRedirect set", result.details.chatRedirect === true);
	check("questions echoed", result.details.questions[0] === "Where should sessions live?");
	check("no throw / not an error", result.content[0].text.includes("chose to chat"));
}

console.log("\ncancel");
{
	const { ctx, state } = makeCtx({ selects: [undefined] });
	let message = "";
	try {
		await run({ questions: [q()] }, ctx);
	} catch (error) {
		message = (error as Error).message;
	}
	check("throws on dismiss", message.includes("dismissed the question"), message);
	check("aborts the run", state.aborted);
}

console.log("\nmulti-select");
{
	const { ctx, state } = makeCtx({ selects: ["[ ] SQLite", "[ ] JSONL", "Done selecting"] });
	const result = await run({ questions: [q({ multi: true })] }, ctx);
	check("both selected", JSON.stringify(result.details.selectedOptions) === '["SQLite","JSONL"]', result.details);
	check("checkbox glyphs rendered", state.seenSelects[0][0] === "[ ] SQLite", state.seenSelects[0]);
	check("checked glyph after toggle", state.seenSelects[1][0] === "[x] SQLite", state.seenSelects[1]);
	check("Done appears only once selected", !state.seenSelects[0].includes("Done selecting"), state.seenSelects[0]);
}

console.log("\nmulti-select toggle off");
{
	const { ctx } = makeCtx({ selects: ["[ ] SQLite", "[x] SQLite", "[ ] JSONL", "Done selecting"] });
	const result = await run({ questions: [q({ multi: true })] }, ctx);
	check("deselect works", JSON.stringify(result.details.selectedOptions) === '["JSONL"]', result.details);
}

console.log("\nmultiple questions");
{
	const { ctx } = makeCtx({ selects: ["SQLite", "Yes"] });
	const result = await run(
		{
			questions: [
				q(),
				{ id: "migrate", question: "Write a migration?", header: "Migration", options: [{ label: "Yes" }, { label: "No" }] },
			],
		},
		ctx,
	);
	check("details.results[] used", Array.isArray(result.details.results) && result.details.results.length === 2);
	check("keyed by id", result.details.results.map((r: any) => r.id).join(",") === "storage,migrate");
	const text: string = result.content[0].text;
	check("text is per-id list", text.startsWith("User answers:") && text.includes("- migrate: Yes"), text);
}

console.log("\nrenderers");
{
	const theme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
	const call = captured.renderCall({ questions: [q(), q({ id: "b", header: "Migration" })] }, theme, {});
	check("renderCall mentions count", JSON.stringify(call).includes("2 questions"));
	const chat = captured.renderResult({ content: [], details: { chatRedirect: true } }, {}, theme, {});
	check("renderResult chat card", JSON.stringify(chat).includes("discuss"));
	const noted = captured.renderResult(
		{ content: [], details: { results: [{ id: "storage", question: "", options: [], multi: false, selectedOptions: ["SQLite"], note: "only if\n  we shard" }] } },
		{},
		theme,
		{},
	);
	check("renderResult shows note flattened", JSON.stringify(noted).includes("only if we shard"), JSON.stringify(noted));
	const timed = captured.renderResult(
		{ content: [], details: { question: "", options: [], multi: false, selectedOptions: ["SQLite"], timedOut: true } },
		{},
		theme,
		{},
	);
	check("renderResult marks timeout", JSON.stringify(timed).includes("⏱"), JSON.stringify(timed));
}

console.log("\nregistration gating");
{
	/** Fake ExtensionAPI capturing session_start handlers and registrations. */
	function fakePi() {
		const handlers: any[] = [];
		const registered: string[] = [];
		return {
			api: {
				on: (event: string, handler: any) => {
					if (event === "session_start") handlers.push(handler);
				},
				registerTool: (def: any) => registered.push(def.name),
			} as any,
			fire: (hasUI: boolean) => handlers.forEach((h) => h({}, { hasUI })),
			registered,
			handlerCount: () => handlers.length,
		};
	}

	const headless = fakePi();
	askExtension(headless.api);
	check("does not register at load time", headless.registered.length === 0, headless.registered);
	check("subscribes to session_start", headless.handlerCount() === 1);
	headless.fire(false);
	check("headless session registers nothing", headless.registered.length === 0, headless.registered);

	const ui = fakePi();
	askExtension(ui.api);
	ui.fire(true);
	check("UI session registers ask", ui.registered.join() === "ask", ui.registered);
	ui.fire(true);
	check("repeat session_start does not double-register", ui.registered.length === 1, ui.registered);

	const late = fakePi();
	askExtension(late.api);
	late.fire(false);
	late.fire(true);
	check("headless then UI still registers", late.registered.join() === "ask", late.registered);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
