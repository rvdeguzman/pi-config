import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TODO_CHANGED_EVENT, type TodoChangedEvent } from "../lib/todo-integration.ts";
import { createTodoIntegrationService } from "../todos.ts";

test("todo integration service persists records and publishes status changes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "plan-todo-integration-"));
	const events: TodoChangedEvent[] = [];
	const pi = {
		events: {
			emit: (event: string, data: unknown) => {
				if (event === TODO_CHANGED_EVENT) events.push(data as TodoChangedEvent);
			},
		},
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionId: () => "session-1",
		},
		ui: { confirm: async () => false },
	};

	try {
		const service = createTodoIntegrationService(pi as never);
		const created = await service.create(
			{ title: "1. Capture baseline", tags: ["plan-mode"], body: "Linked step" },
			ctx as never,
		);
		assert.match(created.id, /^[a-f0-9]{8}$/);
		assert.equal(created.status, "open");
		assert.match(await readFile(join(cwd, ".pi/todos", `${created.id}.md`), "utf8"), /Capture baseline/);

		const closed = await service.updateStatus(created.id, "closed", ctx as never);
		assert.equal(closed.status, "closed");
		assert.deepEqual((await service.getMany([created.id], ctx as never)).map((todo) => todo.status), ["closed"]);
		assert.deepEqual(
			events.map((event) => [event.action, event.source, event.todo.status]),
			[
				["create", "integration", "open"],
				["update", "integration", "closed"],
			],
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
