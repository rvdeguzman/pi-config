import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseAutoModel, eligibleExecutions, parseAutoPolicy, type AutoPolicy } from "./lib/auto-model-routing.ts";

export function registerAutoModel(pi: ExtensionAPI, dependencies: {
	loadPolicy?: () => Promise<AutoPolicy>;
	route?: typeof chooseAutoModel;
	apiKey?: () => string | undefined;
} = {}) {
	if (process.env.PI_HERDR_SUBAGENT_CHILD === "1" || process.env.PI_HERDR_WORKER_CHILD === "1") return;
	const policyPath = join(getAgentDir(), "extensions", "auto-model.json");
	const loadPolicy = dependencies.loadPolicy ?? (async () => parseAutoPolicy(JSON.parse(await readFile(policyPath, "utf8"))));
	let enabled = false;
	let applying = false;
	let generation = 0;
	let pending: AbortController | undefined;
	let last = "No routing decision yet.";
	const status = (ctx: ExtensionContext, text?: string) => { if (ctx.hasUI) ctx.ui.setStatus("auto-model", enabled ? `Auto: ${text ?? "on"}` : undefined); };
	const cancel = () => { generation++; pending?.abort(); pending = undefined; };
	const disable = (ctx: ExtensionContext) => { enabled = false; cancel(); status(ctx); };

	pi.registerCommand("auto", {
		description: "Jev main-session model routing (sends prompt text to TypeSafe). on | off | status | last",
		getArgumentCompletions: (prefix) => ["on", "off", "status", "last"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "off") { disable(ctx); ctx.ui.notify("Auto model routing off; current model retained.", "info"); return; }
			if (action === "status") { ctx.ui.notify(`Auto: ${enabled ? "on" : "off"}\n${last}\nPolicy: ${policyPath}`, "info"); return; }
			if (action === "last") {
				const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === "auto-model-routing-response");
				ctx.ui.notify(entry?.type === "custom" ? JSON.stringify(entry.data, null, 2) : "No recorded Jev routing response on this branch yet.", "info");
				return;
			}
			if (action !== "on") { ctx.ui.notify("Usage: /auto on|off|status|last", "warning"); return; }
			const version = generation;
			try { await loadPolicy(); } catch { ctx.ui.notify(`Invalid or unreadable auto policy: ${policyPath}`, "error"); return; }
			if (version !== generation) return;
			if (!(dependencies.apiKey?.() ?? process.env.TYPESAFE_API_KEY)?.trim()) { ctx.ui.notify("Set TYPESAFE_API_KEY in Pi's environment first.", "warning"); return; }
			enabled = true;
			status(ctx);
			ctx.ui.notify("Auto on for this runtime. Idle prompt text is sent to TypeSafe; no transcript, system prompt, or images. /auto off disables it; reload resets it.", "info");
		},
	});
	pi.on("session_shutdown", (_event, ctx) => disable(ctx));
	pi.on("session_tree", (_event, ctx) => disable(ctx));
	pi.on("model_select", (_event, ctx) => { if (!applying && enabled) disable(ctx); });
	pi.on("input", async (event, ctx) => {
		// Do not switch an executing agent, classify synthetic feedback, or expand skills for external disclosure.
		if (!enabled || !ctx.isIdle() || event.streamingBehavior || event.source === "extension" || event.text.trimStart().startsWith("/")) return;
		if (event.images?.length) { last = "Image prompt: current model retained."; status(ctx, "kept (images)"); return; }
		cancel();
		const version = generation;
		const controller = pending = new AbortController();
		const current = ctx.model;
		const currentEffort = pi.getThinkingLevel();
		const fresh = () => enabled && version === generation && !controller.signal.aborted && ctx.isIdle();
		status(ctx, "routing…");
		try {
			const policy = await loadPolicy();
			if (!fresh()) return;
			const decision = await (dependencies.route ?? chooseAutoModel)(policy, event.text, eligibleExecutions(policy, ctx, event.text), {
				apiKey: dependencies.apiKey?.() ?? process.env.TYPESAFE_API_KEY, signal: controller.signal,
			});
			if (!fresh()) return;
			// Classification record, not a claim that the subsequent model switch succeeded.
			pi.appendEntry("auto-model-routing-response", {
				version: 1, timestamp: new Date().toISOString(), classifier: policy.model,
				action: decision.action, elapsedMs: decision.elapsedMs,
				thresholds: { confidence: policy.minConfidence, probability: policy.minProbability },
				response: decision.response ?? null,
				...(decision.action === "keep" ? { reason: decision.reason } : { proposed: { model: decision.execution.id, thinking: decision.execution.thinking } }),
			});
			if (decision.action === "keep") { last = `${decision.reason} (${decision.elapsedMs}ms)`; status(ctx, `kept · ${decision.elapsedMs}ms`); return; }
			const latestPolicy = await loadPolicy();
			if (!fresh()) return;
			const chosen = decision.execution;
			const eligible = eligibleExecutions(latestPolicy, ctx, event.text).some((entry) => entry.id === chosen.id && entry.thinking === chosen.thinking);
			if (JSON.stringify(latestPolicy) !== JSON.stringify(policy) || !eligible || ctx.model !== current || pi.getThinkingLevel() !== currentEffort) {
				last = "Routing inputs changed; current model retained."; status(ctx, "kept (changed)"); return;
			}
			const model = ctx.modelRegistry.getAvailable().find((entry) => `${entry.provider}/${entry.id}` === chosen.id)!;
			applying = true;
			try {
				if (model !== ctx.model && !await pi.setModel(model)) { last = "Model switch rejected; current model retained."; status(ctx, "kept (auth)"); return; }
				if (!fresh()) return;
				pi.setThinkingLevel(chosen.thinking);
			} finally { applying = false; }
			last = `${chosen.id}:${chosen.thinking} · ${decision.elapsedMs}ms`;
			status(ctx, last);
			pi.appendEntry("auto-model-decision", { model: chosen.id, thinking: chosen.thinking, confidence: decision.confidence, probability: decision.probability, elapsedMs: decision.elapsedMs });
		} catch {
			if (fresh()) { last = "Auto routing failed; no further changes applied."; status(ctx, "routing failed"); }
		} finally { if (pending === controller) pending = undefined; }
	});
}

export default function (pi: ExtensionAPI) { registerAutoModel(pi); }
