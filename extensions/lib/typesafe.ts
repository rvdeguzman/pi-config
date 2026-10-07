/** Minimal TypeSafe System One client: one POST, typed answers back. */

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export type TypeSafeAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface SystemOneOptions {
	apiKey?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export async function systemOne(
	state: unknown,
	questions: Record<string, unknown>,
	options: SystemOneOptions = {},
): Promise<Record<string, TypeSafeAnswer>> {
	const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
	if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set.");
	const response = await (options.fetchImpl ?? fetch)(TYPESAFE_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: "jev-latest", state, questions }),
		signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
	});
	if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}.`);
	const body = (await response.json()) as { answers?: Record<string, TypeSafeAnswer> };
	if (!body.answers) throw new Error("TypeSafe returned no answers.");
	return body.answers;
}
