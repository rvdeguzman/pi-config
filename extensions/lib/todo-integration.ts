import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TODO_SERVICE_AVAILABLE_EVENT = "todo:service:available";
export const TODO_SERVICE_DISCOVER_EVENT = "todo:service:discover";
export const TODO_CHANGED_EVENT = "todo:changed";

export interface IntegratedTodoRecord {
	id: string;
	title: string;
	tags: string[];
	status: string;
	createdAt: string;
	body: string;
}

export interface CreateIntegratedTodoInput {
	title: string;
	tags?: string[];
	status?: string;
	body?: string;
}

export interface TodoIntegrationService {
	create(input: CreateIntegratedTodoInput, ctx: ExtensionContext): Promise<IntegratedTodoRecord>;
	getMany(ids: string[], ctx: ExtensionContext): Promise<IntegratedTodoRecord[]>;
	updateStatus(id: string, status: string, ctx: ExtensionContext): Promise<IntegratedTodoRecord>;
}

export interface TodoServiceDiscovery {
	accept(service: TodoIntegrationService): void;
}

export interface TodoChangedEvent {
	cwd: string;
	action: "create" | "update" | "delete";
	source: "tool" | "ui" | "integration";
	todo: IntegratedTodoRecord;
}

export function isIntegratedTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}
