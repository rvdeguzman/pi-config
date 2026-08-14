/**
 * herdr-metadata: publishes display-only pane metadata to herdr.
 *
 * Companion to the managed herdr-agent-state.ts (semantic state) — this one
 * uses pane.report_metadata for presentation: pane title = current task
 * (first line of the latest user prompt), and tokens {model, cost, ctx}
 * renderable as $model/$cost/$ctx in Agent sidebar rows.
 */

import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const socketPath = process.env.HERDR_SOCKET_PATH;
const endpoint = process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const source = "user:pi-metadata";

const enabled = () => process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;

function send(params: Record<string, unknown>) {
	if (!enabled()) return;
	const request = {
		id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
		method: "pane.report_metadata",
		params: { pane_id: paneId, source, agent: "pi", ...params },
	};
	const socket = net.createConnection(endpoint!);
	const timeout = setTimeout(() => socket.destroy(), 1000);
	timeout.unref?.();
	socket.on("error", () => socket.destroy());
	socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", () => {
		clearTimeout(timeout);
		socket.destroy();
	});
}

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text)
						.join(" ");
		const line = text.trim().split("\n")[0];
		if (line) return line.length > 60 ? `${line.slice(0, 57)}...` : line;
	}
	return undefined;
}

function usageTokens(ctx: ExtensionContext): Record<string, string> {
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		let usage;
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (usage) cost += usage.cost.total;
	}
	const context = ctx.getContextUsage();
	const tokens: Record<string, string> = { cost: `$${cost.toFixed(2)}` };
	if (ctx.model?.id) tokens.model = ctx.model.id;
	if (context?.percent != null) tokens.ctx = `${context.percent.toFixed(0)}%`;
	return tokens;
}

export default function herdrMetadata(pi: ExtensionAPI) {
	if (!enabled()) return;

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const title = latestUserPrompt(ctx);
		send(title ? { title, tokens: usageTokens(ctx) } : { tokens: usageTokens(ctx) });
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		send({ tokens: usageTokens(ctx) });
	});
}
