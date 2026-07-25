import { visibleWidth } from "@earendil-works/pi-tui";
import { createAskTool } from "../../extensions/ask.ts";
import { K, check, driveDialog, report, screen, test, type, type DialogComponent } from "./harness.ts";

const askTool: any = createAskTool();

const storage = (overrides: Record<string, unknown> = {}) => ({
	id: "storage",
	question: "Where should sessions live?",
	header: "Storage",
	options: [
		{ label: "SQLite", description: "One local file" },
		{ label: "JSONL", description: "Append-only text" },
		{ label: "Postgres", description: "Shared server" },
	],
	...overrides,
});

const migration = (overrides: Record<string, unknown> = {}) => ({
	id: "migration",
	question: "Write a migration?",
	header: "Migration",
	options: [{ label: "Yes" }, { label: "No" }],
	...overrides,
});

async function execute(
	questions: Array<Record<string, unknown>>,
	drive: Parameters<typeof driveDialog>[0],
) {
	const driven = driveDialog(drive);
	const result = await askTool.execute("navigation-test", { questions }, undefined, undefined, driven.ctx);
	return { result, ...driven };
}

function allLinesFit(component: DialogComponent, width: number): boolean {
	return component.render(width).every((line) => visibleWidth(line) <= width);
}

await test("1. Submit is gated until every question is answered", async () => {
	let incompleteSubmit = "";
	let completeSubmit = "";
	const { result } = await execute([storage(), migration()], (component, render) => {
		type(component, K.enter); // Storage=SQLite; auto-advance to Migration.
		type(component, K.right); // Submit with Migration unanswered.
		type(component, K.enter); // Must not finish.
		incompleteSubmit = render();
		type(component, K.left); // Migration.
		type(component, K.down, K.enter); // Migration=No; auto-advance to Submit.
		completeSubmit = render();
		type(component, K.enter); // Now finish.
	});
	check("incomplete Submit shows Unanswered", incompleteSubmit.includes("Unanswered: Migration"), incompleteSubmit);
	check("incomplete Enter leaves dialog on Submit", incompleteSubmit.includes("Review answers"), incompleteSubmit);
	check("completed Submit offers Enter to submit", completeSubmit.includes("Enter to submit"), completeSubmit);
	check(
		"both answers are returned after final Enter",
		JSON.stringify(result.details.results.map((item: any) => item.selectedOptions)) === '[["SQLite"],["No"]]',
		result.details,
	);
});

await test("2. Multi-select toggles on the option list and commits only on Submit", async () => {
	let afterSpaceOn = "";
	let afterSpaceOff = "";
	let afterEnterToggle = "";
	let submitScreen = "";
	const { result } = await execute([storage({ multi: true })], (component, render) => {
		type(component, K.space); // SQLite on.
		afterSpaceOn = render();
		type(component, K.space); // SQLite off.
		afterSpaceOff = render();
		type(component, K.down, K.enter); // Enter toggles JSONL on, not submit.
		afterEnterToggle = render();
		type(component, K.down, K.space); // Postgres on.
		type(component, K.up, K.space); // JSONL off.
		type(component, K.up, K.space); // SQLite on: insertion order Postgres, SQLite.
		type(component, K.right);
		submitScreen = render();
		type(component, K.enter);
	});
	check("Space checks an option without leaving the list", afterSpaceOn.includes("[x] SQLite") && afterSpaceOn.includes("Where should sessions live?"), afterSpaceOn);
	check("Space unchecks an option", afterSpaceOff.includes("[ ] SQLite"), afterSpaceOff);
	check("Enter toggles a checkbox without submitting", afterEnterToggle.includes("[x] JSONL") && !afterEnterToggle.includes("Review answers"), afterEnterToggle);
	check("only the Submit tab displays review", submitScreen.includes("Review answers"), submitScreen);
	check(
		"selectedOptions preserves Set insertion order and contents",
		JSON.stringify(result.details.selectedOptions) === '["Postgres","SQLite"]',
		result.details,
	);
});

await test("3. Tab, Shift+Tab, Left, and Right wrap across all tabs", async () => {
	const screens: Record<string, string> = {};
	let caught = "";
	const driven = driveDialog((component, render) => {
		type(component, K.shiftTab); // First -> last (Submit).
		screens.shiftFromFirst = render();
		type(component, K.tab); // Last -> first.
		screens.tabFromLast = render();
		type(component, K.left); // First -> last (Submit).
		screens.leftFromFirst = render();
		type(component, K.right); // Last -> first.
		screens.rightFromLast = render();
		type(component, K.esc);
	});
	try {
		await askTool.execute("navigation-wrap", { questions: [storage(), migration()] }, undefined, undefined, driven.ctx);
	} catch (error) {
		caught = (error as Error).message;
	}
	check("Shift+Tab from first wraps to Submit", screens.shiftFromFirst.includes("Review answers"), screens.shiftFromFirst);
	check("Tab from Submit wraps to first", screens.tabFromLast.includes("Where should sessions live?"), screens.tabFromLast);
	check("Left from first wraps to Submit", screens.leftFromFirst.includes("Review answers"), screens.leftFromFirst);
	check("Right from Submit wraps to first", screens.rightFromLast.includes("Where should sessions live?"), screens.rightFromLast);
	check("intentional cleanup Escape dismisses", caught.includes("dismissed the question"), caught);
});

await test("4. Tab chips use header/id, truncate, and mark answered state", async () => {
	let initial = "";
	let afterAnswer = "";
	let activeSecond = "";
	const longHeader = "This header is definitely longer than sixteen columns";
	const { result } = await execute(
		[storage({ header: longHeader }), migration({ header: undefined, id: "fallback-id" })],
		(component, render) => {
			initial = render();
			type(component, K.enter); // Answer first, auto-advance second.
			afterAnswer = render();
			activeSecond = afterAnswer;
			type(component, K.enter); // Answer second -> Submit.
			type(component, K.enter);
		},
	);
	check("long header chip is truncated with ellipsis", initial.includes("This header is …") && !initial.includes(longHeader), initial);
	check("header falls back to id", initial.includes("fallback-id"), initial);
	check("unanswered tabs use hollow marker", initial.includes("□ This header is …") && initial.includes("□ fallback-id"), initial);
	check("answered tab changes to solid marker", afterAnswer.includes("■ This header is …"), afterAnswer);
	check("active tab is evidenced by its matching question body", activeSecond.includes("fallback-id") && activeSecond.includes("Write a migration?"), activeSecond);
	check("answers still submit", result.details.results.length === 2, result.details);
});

await test("5. Radio answers auto-advance through questions and land on Submit", async () => {
	let secondQuestion = "";
	let submitScreen = "";
	const { result } = await execute([storage(), migration()], (component, render) => {
		type(component, K.down, K.enter); // Storage=JSONL.
		secondQuestion = render();
		type(component, K.enter); // Migration=Yes.
		submitScreen = render();
		type(component, K.enter);
	});
	check("first answer advances to second question", secondQuestion.includes("Write a migration?") && !secondQuestion.includes("Review answers"), secondQuestion);
	check("last answer advances to Submit", submitScreen.includes("Review answers"), submitScreen);
	check("auto-advanced answers are preserved", result.details.results[0].selectedOptions[0] === "JSONL" && result.details.results[1].selectedOptions[0] === "Yes", result.details);
});

await test("6. Cursor wraps from first row to last and back", async () => {
	let wrappedUp = "";
	let wrappedDown = "";
	const { result } = await execute([storage()], (component, render) => {
		type(component, K.up); // First option -> final Chat row.
		wrappedUp = render();
		type(component, K.down); // Chat -> first option.
		wrappedDown = render();
		type(component, K.enter);
	});
	check("Up from first highlights final Chat row", wrappedUp.includes("❯   Chat about this"), wrappedUp);
	check("Down from final row highlights first option", wrappedDown.includes("❯ ( ) SQLite"), wrappedDown);
	check("wrapped cursor can select normally", result.details.selectedOptions[0] === "SQLite", result.details);
});

await test("7. Number keys select only actual numbered options", async () => {
	let afterBeyondOptionCount = "";
	const { result } = await execute([storage()], (component, render) => {
		type(component, "4", "5", "9"); // Other, Chat, and outside rows: all ignored.
		afterBeyondOptionCount = render();
		type(component, "3"); // Postgres.
	});
	check("numbers beyond option count do not move/open Other/Chat", afterBeyondOptionCount.includes("❯ ( ) SQLite") && !afterBeyondOptionCount.includes("Your answer:"), afterBeyondOptionCount);
	check("3 jumps to and selects option 3", result.details.selectedOptions[0] === "Postgres", result.details);
	check("number keys did not produce chatRedirect", result.details.chatRedirect === undefined, result.details);
});

await test("8. Chat about this returns chatRedirect without throwing", async () => {
	const { result, state } = await execute([storage()], (component) => {
		type(component, K.down, K.down, K.down, K.down, K.enter);
	});
	check("chatRedirect is true", result.details.chatRedirect === true, result.details);
	check("asked question is returned", result.details.questions[0] === "Where should sessions live?", result.details);
	check("chat redirect does not abort", state.aborted === false, state);
});

await test("9. Escape dismisses and calls ctx.abort", async () => {
	const driven = driveDialog((component) => type(component, K.esc));
	let message = "";
	try {
		await askTool.execute("navigation-escape", { questions: [storage()] }, undefined, undefined, driven.ctx);
	} catch (error) {
		message = (error as Error).message;
	}
	check("Escape throws a dismissal error", message.includes("dismissed the question"), message);
	check("Escape calls ctx.abort", driven.state.aborted === true, driven.state);
});

await test("10. Single radio question uses immediate flattened-result fast path", async () => {
	let before = "";
	const { result } = await execute([storage()], (component, render) => {
		before = render();
		type(component, K.enter);
	});
	check("single radio has no Submit tab", !before.includes("✓ Submit") && !before.includes("Review answers"), before);
	check("Enter immediately commits selected option", result.details.selectedOptions[0] === "SQLite", result.details);
	check("details are flattened", result.details.results === undefined && result.details.question === "Where should sessions live?", result.details);
});

await test("11. Recommended suffix and initial cursor are UI-only", async () => {
	let initial = "";
	const { result } = await execute([storage({ recommended: 1 })], (component, render) => {
		initial = render();
		type(component, K.enter);
	});
	check("recommended suffix is visible", initial.includes("JSONL (Recommended)"), initial);
	check("cursor starts on recommended option", initial.includes("❯ ( ) JSONL (Recommended)"), initial);
	check("recommended suffix is stripped from result", JSON.stringify(result.details.selectedOptions) === '["JSONL"]', result.details);
});

await test("12a. Narrow rendering clamps a long question and keeps every line within width", async () => {
	const longQuestion = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
	let at40 = "";
	let at30 = "";
	let fits40 = false;
	let fits30 = false;
	const { result } = await execute(
		[
			storage({
				question: longQuestion,
				options: Array.from({ length: 5 }, (_, index) => ({
					label: `Option ${index + 1}`,
					description: "A deliberately long description whose words must wrap within the narrow terminal viewport",
				})),
			}),
		],
		(component, render) => {
			at40 = render(40);
			fits40 = allLinesFit(component, 40);
			at30 = render(30);
			fits30 = allLinesFit(component, 30);
			type(component, K.enter);
		},
	);
	check("width 40 render does not crash and all lines fit", fits40, at40);
	check("width 30 render does not crash and all lines fit", fits30, at30);
	check("long question is clamped to at most four visible word-lines", (at30.match(/word\d+/g) ?? []).length < 25, at30);
	check("option rows remain visible after clamped question", at30.includes("Option 1") && at30.includes("Option 5"), at30);
	check("all five long descriptions render", (at30.match(/deliberately long/g) ?? []).length === 5, at30);
	check("narrow dialog still submits", result.details.selectedOptions[0] === "Option 1", result.details);
});

await test("12b. Very long Other input is ellipsized in the option row", async () => {
	const custom = "custom-" + "x".repeat(180);
	let customAt40 = "";
	let customAt30 = "";
	let fits40 = false;
	let fits30 = false;
	const { result } = await execute([storage(), migration()], (component, render) => {
		type(component, K.down, K.down, K.down, K.enter, ...custom.split(""), K.enter); // Other; auto-advance.
		type(component, K.left); // Return to Storage tab where custom value is shown under Other.
		customAt40 = render(40);
		fits40 = allLinesFit(component, 40);
		customAt30 = render(30);
		fits30 = allLinesFit(component, 30);
		check("long custom row contains ellipsis at width 40", customAt40.includes("…") && !customAt40.includes(custom), customAt40);
		check("long custom row contains ellipsis at width 30", customAt30.includes("…") && !customAt30.includes(custom), customAt30);
		type(component, K.right, K.enter, K.enter); // Migration=Yes -> Submit -> finish.
	});
	check("custom width 40 lines fit", fits40, customAt40);
	check("custom width 30 lines fit", fits30, customAt30);
	check("full custom value survives rendering truncation", result.details.results[0].customInput === custom, result.details.results[0]);
});

report();
