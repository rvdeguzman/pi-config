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
import { extractTodoItems, markCompletedSteps, type TodoItem } from "./utils.ts";

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
	let todoItems: TodoItem[] = [];
	let planText = "";
	let toolsBeforePlanMode: string[] | undefined;

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
			planText,
			toolsBeforePlanMode,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
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

	function buildImplementationPrompt(items = todoItems, capturedPlan = planText): string {
		const remainingList = items.filter((t) => !t.completed).map((t) => `${t.step}. ${t.text}`).join("\n");
		const planDetails = capturedPlan.trim()
			? `\n\nCaptured planning response:\n${capturedPlan.trim()}`
			: "";
		return `Implement the agreed plan.\n\nRemaining steps:\n${remainingList}${planDetails}\n\nExecute the steps in order. After completing a step, include a [DONE:n] tag in your response.`;
	}

	function leavePlanModeForImplementation(ctx: ExtensionContext): void {
		planModeEnabled = false;
		if (toolsBeforePlanMode !== undefined) {
			restoreNormalModeTools();
		}
		updateStatus(ctx);
		persistState();
	}

	function implementHere(ctx: ExtensionContext): boolean {
		if (todoItems.length === 0) {
			ctx.ui.notify("No numbered plan was captured. Enter /plan and create one first.", "warning");
			return false;
		}
		executionMode = true;
		leavePlanModeForImplementation(ctx);
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: buildImplementationPrompt(), display: true },
			{ triggerTurn: true },
		);
		return true;
	}

	pi.registerCommand("implement", {
		description: "Implement the captured plan in a fresh linked session",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No numbered plan was captured. Enter /plan and create one first.", "warning");
				return;
			}

			leavePlanModeForImplementation(ctx);

			// Capture plain data before replacing the session; old session objects become stale.
			const handoffTodos = todoItems.map((item) => ({ ...item }));
			const handoffPlan = planText;
			const handoffPrompt = buildImplementationPrompt(handoffTodos, handoffPlan);
			const parentSession = ctx.sessionManager.getSessionFile();
			const sourceName = pi.getSessionName();

			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry("plan-mode", {
						enabled: false,
						todos: handoffTodos,
						executing: true,
						planText: handoffPlan,
					} satisfies PlanModeState);
					sessionManager.appendSessionInfo(sourceName ? `${sourceName} — implementation` : "Plan implementation");
				},
				withSession: async (freshCtx) => {
					await freshCtx.sendUserMessage(handoffPrompt);
				},
			});

			if (result.cancelled) ctx.ui.notify("Fresh implementation session was cancelled.", "warning");
		},
	});

	pi.registerCommand("implement-here", {
		description: "Implement the captured plan in the current full context",
		handler: async (_args, ctx) => {
			if (executionMode) {
				ctx.ui.notify("The plan is already being implemented.", "info");
				return;
			}
			implementHere(ctx);
		},
	});

	pi.registerCommand("implement-compact", {
		description: "Compact the current context, then implement the captured plan",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No numbered plan was captured. Enter /plan and create one first.", "warning");
				return;
			}
			leavePlanModeForImplementation(ctx);
			ctx.ui.notify("Compacting planning context before implementation…", "info");
			await new Promise<void>((resolve) => {
				ctx.compact({
					customInstructions: "Preserve the agreed implementation plan, requirements, decisions, constraints, relevant file paths, and verification steps.",
					onComplete: () => {
						implementHere(ctx);
						resolve();
					},
					onError: (error) => {
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
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
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
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
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
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				planText = "";
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const assistantText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(assistantText);
			if (extracted.length > 0) {
				todoItems = extracted;
				planText = assistantText;
			}
		}

		if (todoItems.length === 0) return;
		persistState();

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
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

		if (choice?.startsWith("Implement in a fresh")) {
			leavePlanModeForImplementation(ctx);
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendUserMessage("/implement", { deliverAs: "followUp", expandPromptTemplates: true });
		} else if (choice?.startsWith("Compact")) {
			leavePlanModeForImplementation(ctx);
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendUserMessage("/implement-compact", { deliverAs: "followUp", expandPromptTemplates: true });
		} else if (choice?.startsWith("Implement here")) {
			leavePlanModeForImplementation(ctx);
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendUserMessage("/implement-here", { deliverAs: "followUp", expandPromptTemplates: true });
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
			planText = planModeEntry.data.planText ?? planText;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

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
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
