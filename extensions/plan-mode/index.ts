/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Shell, write, task-state, and subagent tools disabled while planning
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	TODO_CHANGED_EVENT,
	TODO_SERVICE_AVAILABLE_EVENT,
	TODO_SERVICE_DISCOVER_EVENT,
	isIntegratedTodoClosed,
	type TodoChangedEvent,
	type TodoIntegrationService,
	type TodoServiceDiscovery,
} from "../lib/todo-integration.ts";
import {
	extractDoneSteps,
	extractTodoItems,
	formatStepSelection,
	markCompletedSteps,
	parseStepSelection,
	type TodoItem,
} from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "ask_user_question"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
// Disable direct mutation plus tools that can delegate mutation or alter task state.
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["bash", "edit", "write", "todo", "herdr_subagent"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	executionSteps?: number[];
	planText?: string;
	toolsBeforePlanMode?: string[];
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let executionSteps: number[] = [];
	let todoItems: TodoItem[] = [];
	let planText = "";
	let toolsBeforePlanMode: string[] | undefined;
	let todoService: TodoIntegrationService | undefined;
	let currentCtx: ExtensionContext | undefined;

	const unsubscribeTodoService = pi.events.on(TODO_SERVICE_AVAILABLE_EVENT, (service) => {
		todoService = service as TodoIntegrationService;
	});
	pi.events.emit(TODO_SERVICE_DISCOVER_EVENT, {
		accept(service: TodoIntegrationService) {
			todoService = service;
		},
	} satisfies TodoServiceDiscovery);
	const unsubscribeTodoChanges = pi.events.on(TODO_CHANGED_EVENT, (data) => {
		const event = data as TodoChangedEvent;
		if (!currentCtx || event.cwd !== currentCtx.cwd || event.action === "delete") return;
		const item = todoItems.find((candidate) => candidate.todoId === event.todo.id);
		if (!item) return;

		const completed = isIntegratedTodoClosed(event.todo.status);
		if (item.completed === completed) return;
		item.completed = completed;
		updateStatus(currentCtx);
		persistState();
		if (event.source !== "integration" && currentCtx.isIdle()) {
			completeMilestoneIfReady(currentCtx);
		}
	});

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			executionSteps,
			planText,
			toolsBeforePlanMode,
		});
	}

	async function ensureLinkedTodos(ctx: ExtensionContext): Promise<void> {
		if (!todoService) return;
		let changed = false;
		for (const item of todoItems) {
			if (item.todoId) continue;
			try {
				const todo = await todoService.create(
					{
						title: `${item.step}. ${item.text}`,
						tags: ["plan-mode", `plan-step-${item.step}`],
						status: item.completed ? "closed" : "open",
						body: `Linked to plan-mode step ${item.step}.\n\n${item.text}`,
					},
					ctx,
				);
				item.todoId = todo.id;
				changed = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not create todo for plan step ${item.step}: ${message}`, "warning");
			}
		}
		if (changed) persistState();
	}

	async function reconcileLinkedTodos(ctx: ExtensionContext): Promise<void> {
		if (!todoService) return;
		const linkedIds = todoItems.flatMap((item) => (item.todoId ? [item.todoId] : []));
		if (linkedIds.length === 0) return;
		try {
			const records = await todoService.getMany(linkedIds, ctx);
			const byId = new Map(records.map((record) => [record.id, record]));
			let changed = false;
			for (const item of todoItems) {
				if (!item.todoId) continue;
				const record = byId.get(item.todoId);
				if (!record) continue;
				const completed = isIntegratedTodoClosed(record.status);
				if (item.completed !== completed) {
					item.completed = completed;
					changed = true;
				}
			}
			if (changed) persistState();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not synchronize plan todos: ${message}`, "warning");
		}
	}

	async function closeLinkedTodos(ctx: ExtensionContext, steps: readonly number[]): Promise<void> {
		if (!todoService) return;
		const selected = new Set(steps);
		for (const item of todoItems) {
			if (!item.completed || !item.todoId || !selected.has(item.step)) continue;
			try {
				await todoService.updateStatus(item.todoId, "closed", ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not close todo for plan step ${item.step}: ${message}`, "warning");
			}
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			executionMode = false;
			executionSteps = [];
			planModeEnabled = true;
			enablePlanModeTools();
			ctx.ui.notify("Implementation paused. Plan progress preserved; implementation tools disabled.");
			updateStatus(ctx);
			persistState();
			return;
		}

		planModeEnabled = !planModeEnabled;
		executionMode = false;
		executionSteps = [];
		todoItems = [];
		planText = "";

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Implementation tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	function mergeExtractedPlan(extracted: TodoItem[]): TodoItem[] {
		const existing = new Map(todoItems.map((item) => [`${item.step}\u0000${item.text}`, item]));
		return extracted.map((item) => {
			const previous = existing.get(`${item.step}\u0000${item.text}`);
			return previous ? { ...item, completed: previous.completed, todoId: previous.todoId } : item;
		});
	}

	function formatPlanItem(item: TodoItem): string {
		const todoRef = item.todoId ? ` [TODO-${item.todoId}]` : "";
		return `${item.step}. ${item.text}${todoRef}`;
	}

	function incompleteSteps(items = todoItems): number[] {
		return items.filter((item) => !item.completed).map((item) => item.step);
	}

	function selectedIncompleteItems(items = todoItems, steps = executionSteps): TodoItem[] {
		const selected = new Set(steps);
		return items.filter((item) => !item.completed && selected.has(item.step));
	}

	function buildImplementationPrompt(
		items = todoItems,
		capturedPlan = planText,
		steps = executionSteps.length > 0 ? executionSteps : incompleteSteps(items),
	): string {
		const remainingList = selectedIncompleteItems(items, steps).map(formatPlanItem).join("\n");
		const planDetails = capturedPlan.trim()
			? `\n\nCaptured planning response:\n${capturedPlan.trim()}`
			: "";
		return `Implement the selected milestone from the agreed plan.\n\nSelected steps:\n${remainingList}${planDetails}\n\nExecute only the selected steps, in order. Each linked TODO is the same source of progress as the plan widget: closing it marks the step complete, and a [DONE:n] tag closes it automatically. Do not begin unselected steps.`;
	}

	async function chooseImplementationSteps(ctx: ExtensionContext, selector: string): Promise<number[] | undefined> {
		if (todoItems.length === 0) {
			ctx.ui.notify("No numbered plan was captured. Enter /plan and create one first.", "warning");
			return undefined;
		}

		if (selector.trim()) {
			const parsed = parseStepSelection(selector, todoItems);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return undefined;
			}
			return parsed.steps;
		}

		if (!ctx.hasUI) return incompleteSteps();
		while (true) {
			const remaining = incompleteSteps();
			const choice = await ctx.ui.select(
				`Choose implementation scope · incomplete: ${formatStepSelection(remaining)}`,
				["Enter a step range…", `All remaining (${remaining.length} steps)`],
			);
			if (!choice) return undefined;
			if (choice.startsWith("All remaining")) return remaining;

			const input = await ctx.ui.input("Steps to implement:", "e.g. 1-3,5");
			if (input === undefined) return undefined;
			const parsed = parseStepSelection(input, todoItems);
			if (!parsed.error) return parsed.steps;
			ctx.ui.notify(parsed.error, "warning");
		}
	}

	function leavePlanModeForImplementation(ctx: ExtensionContext): void {
		planModeEnabled = false;
		if (toolsBeforePlanMode !== undefined) {
			restoreNormalModeTools();
		}
		updateStatus(ctx);
		persistState();
	}

	function returnToPlanMode(ctx: ExtensionContext): void {
		executionMode = false;
		executionSteps = [];
		planModeEnabled = true;
		enablePlanModeTools();
		updateStatus(ctx);
		persistState();
	}

	function completeMilestoneIfReady(ctx: ExtensionContext): boolean {
		if (!executionMode || todoItems.length === 0) return false;
		const selected = new Set(executionSteps);
		const milestoneItems = todoItems.filter((item) => selected.has(item.step));
		if (milestoneItems.length === 0 || !milestoneItems.every((item) => item.completed)) return false;

		const completedList = milestoneItems.map((item) => `~~${item.step}. ${item.text}~~`).join("\n");
		const remaining = incompleteSteps();
		if (remaining.length === 0) {
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			executionSteps = [];
			todoItems = [];
			planText = "";
			updateStatus(ctx);
			persistState();
		} else {
			pi.sendMessage(
				{
					customType: "plan-milestone-complete",
					content: `**Milestone Complete!** ✓\n\n${completedList}\n\nRemaining steps: ${formatStepSelection(remaining)}\nRun /implement to choose the next milestone.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			returnToPlanMode(ctx);
		}
		return true;
	}

	function implementHere(ctx: ExtensionContext, steps: number[]): boolean {
		if (todoItems.length === 0 || steps.length === 0) {
			ctx.ui.notify("No incomplete plan steps were selected.", "warning");
			return false;
		}
		executionMode = true;
		executionSteps = [...steps];
		leavePlanModeForImplementation(ctx);
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: buildImplementationPrompt(), display: true },
			{ triggerTurn: true },
		);
		return true;
	}

	pi.registerCommand("implement", {
		description: "Select plan steps and implement them in a fresh linked session",
		handler: async (args, ctx) => {
			if (executionMode) {
				ctx.ui.notify("A plan milestone is already being implemented.", "info");
				return;
			}
			const selectedSteps = await chooseImplementationSteps(ctx, args);
			if (!selectedSteps) return;

			leavePlanModeForImplementation(ctx);

			// Capture plain data before replacing the session; old session objects become stale.
			const handoffTodos = todoItems.map((item) => ({ ...item }));
			const handoffSteps = [...selectedSteps];
			const handoffPlan = planText;
			const handoffPrompt = buildImplementationPrompt(handoffTodos, handoffPlan, handoffSteps);
			const parentSession = ctx.sessionManager.getSessionFile();
			const sourceName = pi.getSessionName();
			const stepLabel = formatStepSelection(handoffSteps);

			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry("plan-mode", {
						enabled: false,
						todos: handoffTodos,
						executing: true,
						executionSteps: handoffSteps,
						planText: handoffPlan,
					} satisfies PlanModeState);
					const baseName = sourceName ?? "Plan implementation";
					sessionManager.appendSessionInfo(`${baseName} — steps ${stepLabel}`);
				},
				withSession: async (freshCtx) => {
					await freshCtx.sendUserMessage(handoffPrompt);
				},
			});

			if (result.cancelled) {
				returnToPlanMode(ctx);
				ctx.ui.notify("Fresh implementation session was cancelled.", "warning");
			}
		},
	});

	pi.registerCommand("implement-here", {
		description: "Select plan steps and implement them in the current full context",
		handler: async (args, ctx) => {
			if (executionMode) {
				ctx.ui.notify("A plan milestone is already being implemented.", "info");
				return;
			}
			const selectedSteps = await chooseImplementationSteps(ctx, args);
			if (selectedSteps) implementHere(ctx, selectedSteps);
		},
	});

	pi.registerCommand("implement-compact", {
		description: "Compact context, then implement selected plan steps here",
		handler: async (args, ctx) => {
			if (executionMode) {
				ctx.ui.notify("A plan milestone is already being implemented.", "info");
				return;
			}
			const selectedSteps = await chooseImplementationSteps(ctx, args);
			if (!selectedSteps) return;

			leavePlanModeForImplementation(ctx);
			ctx.ui.notify("Compacting planning context before implementation…", "info");
			await new Promise<void>((resolve) => {
				ctx.compact({
					customInstructions: "Preserve the agreed implementation plan, requirements, decisions, constraints, relevant file paths, and verification steps.",
					onComplete: () => {
						implementHere(ctx, selectedSteps);
						resolve();
					},
					onError: (error) => {
						returnToPlanMode(ctx);
						ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
						resolve();
					},
				});
			});
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan progress", 
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No captured plan. Enter /plan and ask for a numbered plan first.", "info");
				return;
			}
			const list = todoItems
				.map((item) => `${item.completed ? "✓" : "○"} ${formatPlanItem(item)}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Fail closed if a disabled tool call was already queued when plan mode was enabled.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || !PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: `Plan mode: ${event.toolName} is disabled. Use /implement or /plan to restore implementation tools.`,
		};
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Shell, edit, write, task-state, and subagent tools are disabled
- Read-only inspection, question, and web-research tools remain available

Ask clarifying questions using ask_user_question when requirements are ambiguous.
Use the available web search tools when current external research is needed.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = selectedIncompleteItems();
			const todoList = remaining.map(formatPlanItem).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
Closing a linked TODO marks its plan step complete; a [DONE:n] tag closes it automatically.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const activeSteps = new Set(executionSteps);
		const newlyCompleted = extractDoneSteps(text).filter((step) => {
			const item = todoItems.find((candidate) => candidate.step === step);
			return activeSteps.has(step) && item !== undefined && !item.completed;
		});
		if (markCompletedSteps(text, todoItems, executionSteps) > 0) {
			await closeLinkedTodos(ctx, newlyCompleted);
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if the selected milestone is complete.
		if (executionMode && todoItems.length > 0) {
			completeMilestoneIfReady(ctx);
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const assistantText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(assistantText);
			if (extracted.length > 0) {
				todoItems = mergeExtractedPlan(extracted);
				planText = assistantText;
			}
		}

		if (todoItems.length === 0) return;
		await ensureLinkedTodos(ctx);
		persistState();

		// Show plan steps and prompt for next action
		const todoListText = todoItems
			.map((item) => `${item.step}. ${item.completed ? "☑" : "☐"} ${item.text}`)
			.join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Implement in a fresh session (recommended)",
			"Compact, then implement here",
			"Implement here with full context",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (
			choice?.startsWith("Implement in a fresh") ||
			choice?.startsWith("Compact") ||
			choice?.startsWith("Implement here")
		) {
			const selectedSteps = await chooseImplementationSteps(ctx, "");
			if (!selectedSteps) return;

			const selector = formatStepSelection(selectedSteps);
			const command = choice.startsWith("Implement in a fresh")
				? "implement"
				: choice.startsWith("Compact")
					? "implement-compact"
					: "implement-here";
			leavePlanModeForImplementation(ctx);
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendUserMessage(`/${command} ${selector}`, { deliverAs: "followUp", expandPromptTemplates: true });
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			executionSteps = planModeEntry.data.executionSteps ?? executionSteps;
			planText = planModeEntry.data.planText ?? planText;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}
		// Older sessions predate ranged milestones and implicitly execute every incomplete step.
		if (executionMode && executionSteps.length === 0) executionSteps = incompleteSteps();

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems, executionSteps);
		}

		await ensureLinkedTodos(ctx);
		await reconcileLinkedTodos(ctx);
		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
		if (executionMode && ctx.isIdle()) completeMilestoneIfReady(ctx);
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
		unsubscribeTodoChanges();
		unsubscribeTodoService();
	});
}
