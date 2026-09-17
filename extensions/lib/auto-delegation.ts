import { join } from "node:path";
import { StringEnum, clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	truncateHead,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { subagentProfiles, type AgentProfile, type ThinkingLevel } from "./subagent-profiles.ts";
import { decideRoute, loadRoutingPolicy, MAX_TASK_CHARS, type RouteCandidate, type RoutingDecision, type RoutingPolicy } from "./jev-routing.ts";

const STATE_TYPE = "delegate-auto";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "web_search_exa", "web_fetch_exa", "deep_search_exa"]);

export interface DelegatedTask {
	agent: string;
	task: string;
	cwd?: string;
}

interface Dependencies {
	dispatch(
		delivery: "async" | "blocking",
		profile: AgentProfile,
		id: string,
		params: DelegatedTask,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
	resolveTools(tools: string[], profile: string): string[];
	listProfiles?: () => Promise<AgentProfile[]>;
	loadPolicy?: () => Promise<RoutingPolicy>;
	route?: typeof decideRoute;
	apiKey?: () => string | undefined;
}

interface PreparedCandidate {
	candidate: RouteCandidate;
	profile: AgentProfile;
}

/** Only global, user-authored policy is read; project content cannot widen routes. */
export function registerAutoDelegation(pi: ExtensionAPI, dependencies: Dependencies): void {
	const policyPath = join(getAgentDir(), "extensions", "herdr-routing.json");
	const policyLoader = dependencies.loadPolicy ?? (() => loadRoutingPolicy(policyPath));
	const listProfiles = dependencies.listProfiles ?? (() => subagentProfiles.list());
	const apiKey = dependencies.apiKey ?? (() => process.env.TYPESAFE_API_KEY);
	let enabled = false;
	let stopped = false;
	let generation = 0;
	const requests = new Set<AbortController>();

	function cancelRequests(): void {
		generation++;
		for (const controller of requests) controller.abort();
		requests.clear();
	}

	function restore(ctx: ExtensionContext): void {
		cancelRequests();
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { version?: unknown; enabled?: unknown } | undefined;
				if (data?.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATE_TYPE, enabled ? "Jev delegation: on" : undefined);
	}

	pi.on("session_start", (_event, ctx) => { stopped = false; restore(ctx); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => { stopped = true; cancelRequests(); });
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: event.systemPrompt + "\n\nJev auto-delegation is enabled. For a potentially worthwhile bounded subtask, write a complete brief and use herdr_delegate BEFORE dispatching it. Jev decides whether to keep it in the parent, then chooses an eligible profile/model. Supply dependencies and potential overlapping writes in context. An optional agent pins the profile, not the dispatch decision. allowWrites must be true only for user-authorized implementation work. If herdr_delegate returns parent, do the work yourself; do not bypass the decision by retrying through another delegation tool. Explicit &name requests remain direct herdr_async calls with that profile and bypass Jev. The parent still chooses task boundaries, number/order of calls, and async versus blocking delivery. Never use automatic fire-and-forget dispatch." };
	});

	pi.registerCommand("delegate-auto", {
		description: "Opt into Jev dispatch/profile/model routing for this session; sends task briefs to TypeSafe. on | off | status",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (!["on", "off", "status"].includes(action)) { ctx.ui.notify("Usage: /delegate-auto on|off|status", "warning"); return; }
			if (action === "on") {
				if (!apiKey()?.trim()) { ctx.ui.notify("Set TYPESAFE_API_KEY in Pi's environment first. Do not paste the key into chat.", "error"); return; }
				try { await policyLoader(); } catch { ctx.ui.notify(`Invalid/missing routing policy: ${policyPath}`, "error"); return; }
			}
			if (action !== "status") {
				cancelRequests();
				enabled = action === "on";
				pi.appendEntry(STATE_TYPE, { version: 1, enabled });
				if (ctx.hasUI) ctx.ui.setStatus(STATE_TYPE, enabled ? "Jev delegation: on" : undefined);
			}
			ctx.ui.notify(`Jev delegation: ${enabled ? "on — task briefs/context are sent to TypeSafe; uncertain decisions stay in the parent" : "off"}. Policy: ${policyPath}`, "info");
		},
	});

	async function prepare(policy: RoutingPolicy, ctx: ExtensionContext, delivery: "async" | "blocking", allowWrites: boolean, agent?: string): Promise<PreparedCandidate[]> {
		const available = new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
		const scope = new Map(ctx.scopedModels.map((entry) => [`${entry.model.provider}/${entry.model.id}`, entry]));
		const prepared: PreparedCandidate[] = [];
		for (const profile of await listProfiles()) {
			if (agent && profile.name.toLowerCase() !== agent.toLowerCase()) continue;
			if (profile.name.toLowerCase() === "worker" && (delivery === "blocking" || !allowWrites)) continue;
			const rubric = policy.profiles[profile.name.toLowerCase()];
			if (!rubric) continue;
			let tools: string[];
			try { tools = dependencies.resolveTools(profile.tools ?? pi.getActiveTools(), profile.name); } catch { continue; }
			if (!allowWrites && tools.some((name) => !READ_ONLY_TOOLS.has(name))) continue;
			const models: RouteCandidate["models"] = [];
			for (const candidate of rubric.models) {
				const model = available.get(candidate.id);
				if (!model || (scope.size > 0 && !scope.has(candidate.id))) continue;
				const requestedThinking = profile.thinking ?? scope.get(candidate.id)?.thinkingLevel ?? pi.getThinkingLevel();
				models.push({ ...candidate, thinking: clampThinkingLevel(model, requestedThinking) });
			}
			if (models.length) prepared.push({ profile, candidate: { profile: profile.name, description: rubric.description, tools, models } });
		}
		return prepared;
	}

	pi.registerTool({
		name: "herdr_delegate",
		label: "Jev Delegation",
		description: "Opt-in automatic delegation of one parent-authored task. Requires /delegate-auto on. Jev gates dispatch, selects an eligible profile and scoped model, then launches via Herdr. Uncertainty/errors return action=parent and launch nothing. Optional agent pins a profile but still evaluates delegation. Explicit &name references must use herdr_async instead. No fire-and-forget path.",
		promptSnippet: "Let Jev decide whether and how to delegate one bounded task (opt-in)",
		promptGuidelines: [
			"Use herdr_delegate for candidate subtasks when /delegate-auto is on; include complete context and expected output, not an underspecified fragment.",
			"If herdr_delegate returns action=parent, handle the task yourself rather than bypassing Jev through another delegation tool.",
			"Use herdr_async, not herdr_delegate, for explicit &name requests. Only set herdr_delegate allowWrites for user-authorized implementation work.",
		],
		parameters: Type.Object({
			task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Complete bounded task, instructions, constraints, and expected output." }),
			context: Type.Optional(Type.String({ maxLength: MAX_TASK_CHARS, description: "Relevant dependencies, parent parallel work, and overlapping writes. Sent to Jev AND the child; no secrets." })),
			agent: Type.Optional(Type.String({ description: "Optionally pin an existing profile; Jev still gates dispatch and selects its model." })),
			delivery: Type.Optional(StringEnum(["async", "blocking"] as const, { description: "Default async. Parent chooses blocking only when it needs the result before continuing; workers cannot block." })),
			allowWrites: Type.Optional(Type.Boolean({ description: "Default false. True only when the user authorized implementation; permits write-capable profiles." })),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			const retained = (reason: string, decision?: RoutingDecision): AgentToolResult<unknown> => ({
				content: [{ type: "text", text: `Keep this task in the parent. ${reason} No subagent was dispatched. Do not bypass this decision through another delegation tool.` }],
				details: { ...decision, action: "parent", reason },
			});
			if (!enabled || stopped) return retained("Jev auto-delegation is off; the user can opt in with /delegate-auto on.");
			const delivery = params.delivery ?? "async";
			const targetTool = delivery === "async" ? "herdr_async" : "herdr_subagent";
			const toolsEnabled = () => pi.getActiveTools().includes("herdr_delegate") && pi.getActiveTools().includes(targetTool);
			if (!toolsEnabled()) return retained("Delegation tools are disabled in the current mode.");
			const controller = new AbortController();
			requests.add(controller);
			const callGeneration = generation;
			const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const cancelled = () => combinedSignal.aborted || stopped || !enabled || generation !== callGeneration;
			let launchAttempted = false;
			try {
				const policy = await policyLoader();
				const prepared = await prepare(policy, ctx, delivery, params.allowWrites ?? false, params.agent);
				if (cancelled()) return retained("Routing cancelled.");
				const decision = await (dependencies.route ?? decideRoute)(policy, {
					task: params.task,
					context: params.context,
					agent: params.agent ? prepared[0]?.profile.name ?? params.agent : undefined,
					delivery,
					allowWrites: params.allowWrites ?? false,
				}, prepared.map(({ candidate }) => candidate), { apiKey: apiKey(), signal: combinedSignal });
				if (decision.action === "parent") return retained(decision.reason, decision);
				if (cancelled() || !toolsEnabled()) return retained("Routing cancelled or delegation disabled before launch.", decision);
				// Re-read configuration, tools, and scope after network I/O. Never trust stale eligibility.
				const freshPolicy = await policyLoader();
				if (JSON.stringify(freshPolicy) !== JSON.stringify(policy)) return retained("Routing policy changed during evaluation.", decision);
				const fresh = await prepare(freshPolicy, ctx, delivery, params.allowWrites ?? false, params.agent);
				const selection = fresh.find(({ candidate }) => candidate.profile === decision.profile);
				const selectedModel = selection?.candidate.models.find((model) => model.id === decision.model);
				const original = prepared.find(({ candidate }) => candidate.profile === decision.profile);
				if (!selection || !selectedModel || JSON.stringify(selection) !== JSON.stringify(original)) return retained("Selected route changed or is no longer eligible.", decision);
				if (cancelled() || !toolsEnabled()) return retained("Routing cancelled before launch.", decision);
				const task = params.context ? `${params.task}\n\n## Delegation context\n${params.context}` : params.task;
				const profile: AgentProfile = { ...selection.profile, model: decision.model, tools: selection.candidate.tools, thinking: selectedModel.thinking as ThinkingLevel };
				// Private in-process override, not a public tool argument. The model can only select vetted policy candidates.
				launchAttempted = true;
				const result = await dependencies.dispatch(delivery, profile, id, { agent: profile.name, task, cwd: params.cwd }, combinedSignal, onUpdate, ctx);
				return {
					...result,
					content: [{ type: "text", text: truncateHead(
						`Jev delegated to ${profile.name} on ${decision.model}.\n\n` + result.content
							.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
					).content }],
					details: { action: "delegate", routing: decision, child: result.details },
				};
			} catch (error) {
				// Dispatch failures must not be described as "nothing launched": the child may have started.
				if (launchAttempted) throw error;
				return retained(cancelled() ? "Routing cancelled." : "Routing configuration or service is unavailable.");
			} finally {
				requests.delete(controller);
			}
		},
	});
}
