let priorityEnabled = true;

export const getPriorityEnabled = () => priorityEnabled;
export const setPriorityEnabled = (enabled: boolean) => (priorityEnabled = enabled);

export function applyPriority(payload: unknown, enabled: boolean): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const next = { ...(payload as Record<string, unknown>) };
	if (enabled) next.service_tier = "priority";
	else delete next.service_tier;
	return next;
}
