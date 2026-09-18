import {
	capsFromEnvironment, createTypeSafe, openUsageLedger, resolveApiKey, TypeSafeIntegrationError,
	type ChoiceQuestion, type EntryType, type TypeSafe, type UsageLedger, type UsageSnapshot,
} from "pi-typesafe";

/** Jev is a decision service, not a Pi chat-model provider. */
export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MAX_CHOICES = 64;
export const MAX_RESPONSE_BYTES = 128_000;

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}
export interface ChoiceRequest {
	model: string;
	state: EntryType;
	questions: Record<string, ChoiceQuestion>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fraction(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The package validates ranges/labels; routing also requires a coherent distribution. */
export function parseChoice(value: unknown, labels: string[]): ChoiceAnswer {
	if (!record(value) || value.type !== "choice" || typeof value.choice !== "string" ||
		!labels.includes(value.choice) || !fraction(value.confidence) || !record(value.probabilities)) {
		throw new TypeSafeIntegrationError("response", "Invalid Jev choice response.");
	}
	const probabilities = value.probabilities;
	if (Object.keys(probabilities).length !== labels.length || labels.some((label) => !fraction(probabilities[label]))) {
		throw new TypeSafeIntegrationError("response", "Invalid Jev probability distribution.");
	}
	const values = labels.map((label) => probabilities[label] as number);
	if (Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > 0.01 ||
		(probabilities[value.choice] as number) + 0.000001 < Math.max(...values)) {
		throw new TypeSafeIntegrationError("response", "Inconsistent Jev choice.");
	}
	// Never retain arbitrary upstream metadata in session/tool evidence.
	return { type: "choice", choice: value.choice, confidence: value.confidence,
		probabilities: Object.fromEntries(labels.map((label) => [label, probabilities[label] as number])) };
}

/** Bound even transports/readers that ignore abort; always observe late rejections. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new TypeSafeIntegrationError("aborted", "Jev routing cancelled or timed out."));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function cancelBody(response: Response): void {
	// Cancellation is best-effort; an uncooperative stream must not stall the caller.
	void response.body?.cancel().catch(() => undefined);
}

/** Guard the public SDK's fetch seam, before it buffers/clones/parses the response. */
export function boundedFetch(transport: typeof fetch = (...args) => fetch(...args)): typeof fetch {
	return async (input, init) => {
		if (input !== ENDPOINT || !init?.signal) throw new TypeSafeIntegrationError("configuration", "Invalid routing transport request.");
		const signal = init.signal;
		signal.throwIfAborted();
		const response = await withAbort(transport(input, { ...init, redirect: "error" }).then((response) => {
			if (signal.aborted) { cancelBody(response); signal.throwIfAborted(); }
			return response;
		}), signal);
		if (response.redirected) { cancelBody(response); throw new TypeSafeIntegrationError("response", "Unexpected Jev redirect."); }
		if (!response.ok) {
			cancelBody(response);
			// Preserve the status for the package's safe error categories, not headers/body.
			return new Response(null, { status: response.status });
		}
		if (!response.body) throw new TypeSafeIntegrationError("response", "Empty Jev response.");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await withAbort(reader.read(), signal);
				if (done) break;
				size += value.byteLength;
				if (size > MAX_RESPONSE_BYTES) throw new TypeSafeIntegrationError("response", "Jev response exceeded the size limit.");
				chunks.push(value);
			}
			signal.throwIfAborted();
			return new Response(Buffer.concat(chunks, size), { status: response.status, headers: { "Content-Type": "application/json" } });
		} finally {
			void reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	};
}

/** Fixed messages only, including for injected transports and invalid server metadata. */
export function routingFailureReason(error: unknown): string {
	if (error instanceof TypeSafeIntegrationError) {
		if (error.code === "budget") return "Jev routing failed: TypeSafe request budget reached.";
		if (error.code === "configuration") return "Jev routing failed: TypeSafe credentials or configuration unavailable.";
		if (error.code === "validation") return "Jev routing failed: request exceeds TypeSafe format or size limits.";
		if (error.code === "http" && (error.status === 401 || error.status === 403)) return "Jev routing failed: TypeSafe authentication or access rejected.";
	}
	return "Jev routing failed or returned an invalid decision.";
}

export interface RoutingClient {
	credentials(): { available: boolean; reason: string };
	evaluate(request: ChoiceRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<Record<string, ChoiceAnswer>>;
	getUsage(): UsageSnapshot;
	status(): string;
	reset(): void;
}

/**
 * One lazy client owner per extension runtime. Each request re-resolves credentials;
 * logout/key rotation and changed daily-cap environment invalidate the cached client.
 * No implicit 20-attempt limit: existing routers had no session cap. The optional
 * explicit cap is enforced across client rotations, counting only submitted attempts.
 * pi-typesafe's daily ledger is advisory, NOT a cross-process hard spending boundary.
 */
export function createRoutingClient(options: {
	apiKey?: () => string | undefined;
	fetch?: typeof fetch;
	ledger?: UsageLedger;
	maxRequests?: number;
} = {}): RoutingClient {
	const maxRequests = options.maxRequests ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) throw new Error("Invalid routing request budget.");
	let cached: { key: string; timeoutMs: number; caps: string; client: TypeSafe } | undefined;
	let ledger: UsageLedger | undefined;
	let clients: TypeSafe[] = [];
	let generation = 0;
	let lastFailure: string | undefined;
	const pending = new Set<AbortController>();
	const key = () => options.apiKey ? options.apiKey()?.trim() : resolveApiKey()?.key;
	const credentials = () => {
		try {
			return key() ? { available: true, reason: "TypeSafe credential configured (environment or /typesafe login)." }
				: { available: false, reason: "Set TYPESAFE_API_KEY or use /typesafe login first." };
		} catch {
			return { available: false, reason: "TypeSafe credential store unavailable or insecure; check permissions or use /typesafe login." };
		}
	};
	const getUsage = (): UsageSnapshot => {
		const total = { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
		for (const client of clients) {
			const usage = client.getUsage();
			for (const key of Object.keys(total) as Array<keyof UsageSnapshot>) total[key] += usage[key];
		}
		return total;
	};
	return {
		credentials, getUsage,
		status() {
			const usage = getUsage();
			return `${credentials().reason} Routing session: ${usage.requestsStarted} attempts, ${usage.inputTokens} input tokens (~$${usage.estimatedUsd.toFixed(6)}).${lastFailure ? ` Last failure: ${lastFailure}` : ""}`;
		},
		reset() {
			generation++;
			for (const controller of pending) controller.abort();
			pending.clear();
			cached = undefined; ledger = undefined; clients = []; lastFailure = undefined;
		},
		async evaluate(request, callOptions) {
			const callGeneration = generation;
			const controller = new AbortController();
			const signal = AbortSignal.any([callOptions.signal, controller.signal]);
			pending.add(controller);
			try {
				signal.throwIfAborted();
				let apiKey: string | undefined;
				try { apiKey = key(); } catch { /* sanitize permission/store errors below */ }
				if (!apiKey) {
					cached = undefined;
					throw new TypeSafeIntegrationError("configuration", "TypeSafe credential unavailable.");
				}
				const caps = JSON.stringify(capsFromEnvironment());
				if (!cached || cached.key !== apiKey || cached.timeoutMs !== callOptions.timeoutMs || cached.caps !== caps) {
					const client = createTypeSafe({ apiKey, timeoutMs: callOptions.timeoutMs, maxRequests,
						ledger: ledger ??= options.ledger ?? openUsageLedger(), fetch: boundedFetch(options.fetch) });
					cached = { key: apiKey, timeoutMs: callOptions.timeoutMs, caps, client };
					clients.push(client);
				}
				if (getUsage().requestsStarted >= maxRequests) throw new TypeSafeIntegrationError("budget", "Routing request budget reached.");
				const labels = Object.entries(request.questions).map(([name, question]) => [name, Object.keys(question.criteria)] as const);
				const result = await withAbort(cached.client.evaluate(request, { signal }), signal);
				signal.throwIfAborted();
				const answers = Object.fromEntries(labels.map(([name, criteria]) => [name, parseChoice(result.answers[name], criteria)]));
				lastFailure = undefined;
				return answers;
			} catch (error) {
				if (callGeneration === generation) lastFailure = signal.aborted ? "Routing cancelled or timed out." : routingFailureReason(error);
				throw error;
			} finally {
				pending.delete(controller);
				controller.abort();
			}
		},
	};
}

export interface RoutingOptions {
	apiKey?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	client?: RoutingClient;
}
export function routingClientFor(options: RoutingOptions): RoutingClient {
	return options.client ?? createRoutingClient({
		...(Object.hasOwn(options, "apiKey") ? { apiKey: () => options.apiKey } : {}), fetch: options.fetch,
	});
}
