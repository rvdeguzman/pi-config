/**
 * Regression test for the uncaughtException that killed pi:
 *
 *   Error: This extension ctx is stale after session replacement or reload.
 *     at renderQuota (extensions/quota.ts)
 *     at Timeout._onTimeout (extensions/quota.ts)
 *
 * quota.ts arms a setInterval in session_start that closes over that session's ctx.
 * Clearing it in session_shutdown is the primary cleanup, but it only works if pi
 * delivers session_shutdown to the same closure that armed the timer before
 * invalidating that ctx. When that didn't happen, the tick touched a dead ctx and
 * threw inside a bare timer callback — an uncaughtException, which takes down the
 * entire process.
 *
 * The 60s countdown repaint timer that originally crashed is gone: quota:changed now
 * carries raw windows, so the footer recomputes the countdown at render time.
 *
 * Hermetic: HOME is redirected to a temp dir before importing quota.ts so the
 * module-level cache/auth paths never touch the real ~/.pi/agent files.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const sandbox = mkdtempSync(join(tmpdir(), "quota-test-"));
mkdirSync(join(sandbox, ".pi/agent"), { recursive: true });
writeFileSync(
	join(sandbox, ".pi/agent/auth.json"),
	JSON.stringify({ anthropic: { access: "test-token", expires: Date.now() + 3_600_000 } }),
);
process.env.HOME = sandbox;

// Imported after HOME is redirected: quota.ts resolves its cache/auth paths at module load.
const quota = await import("../quota.ts");

type Interval = { fn: () => void; ms: number };

/** Drive one full session lifecycle against a ctx we can invalidate on demand. */
async function harness() {
	const intervals = new Map<number, Interval>();
	let nextId = 1;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const realFetch = globalThis.fetch;

	globalThis.setInterval = ((fn: () => void, ms: number) => {
		const id = nextId++;
		intervals.set(id, { fn, ms });
		return id;
	}) as unknown as typeof globalThis.setInterval;
	globalThis.clearInterval = ((id: number) => void intervals.delete(id)) as unknown as typeof globalThis.clearInterval;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
			seven_day: { utilization: 34, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
		}),
	})) as unknown as typeof globalThis.fetch;

	const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
	const emitted: unknown[] = [];
	const pi = {
		on: (evt: string, fn: (e: unknown, c: unknown) => unknown) =>
			handlers.set(evt, [...(handlers.get(evt) ?? []), fn]),
		events: { emit: (_evt: string, value: unknown) => void emitted.push(value) },
		registerCommand: () => {},
	};
	(quota.default as (api: unknown) => void)(pi);

	let stale = false;
	const assertActive = () => {
		if (stale) throw new Error(STALE_MESSAGE);
	};
	const ctx = {
		get ui() {
			assertActive();
			return { theme: { fg: (_s: string, t: string) => t }, setStatus: () => {}, notify: () => {} };
		},
		get model() {
			assertActive();
			return { provider: "anthropic" };
		},
	};

	return {
		intervals,
		emitted,
		// The sole remaining timer is the periodic fetch.
		tick: () => [...intervals.values()][0],
		setStale: (v: boolean) => {
			stale = v;
		},
		fire: async (evt: string) => {
			for (const h of handlers.get(evt) ?? []) await h({ type: evt }, ctx);
			await new Promise((r) => realSetInterval.call(globalThis, r, 50));
		},
		settle: () => new Promise((r) => realSetInterval.call(globalThis, r, 50)),
		restore: () => {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			globalThis.fetch = realFetch;
		},
	};
}

test("session_start arms exactly one timer, and it is the fetch timer", async () => {
	const h = await harness();
	try {
		await h.fire("session_start");
		assert.equal(h.intervals.size, 1, "the 60s countdown repaint timer must be gone");
		assert.ok((h.tick()?.ms ?? 0) >= 60_000, "the remaining timer is the periodic fetch, not a repaint");
	} finally {
		h.restore();
	}
});

test("a timer tick on a stale ctx does not throw and tears its timer down", async () => {
	const h = await harness();
	try {
		await h.fire("session_start");
		assert.ok(h.tick());

		// The crash condition: ctx is invalidated without session_shutdown reaching
		// this closure, so the interval is still live over a dead ctx.
		h.setStale(true);
		assert.doesNotThrow(() => h.tick()?.fn(), "stale tick must not escape into the timer callback");
		await h.settle();
		assert.equal(h.intervals.size, 0, "first stale touch must clear the timer");
	} finally {
		h.restore();
	}
});

test("a later session still renders after a stale teardown", async () => {
	const h = await harness();
	try {
		await h.fire("session_start");
		h.setStale(true);
		h.tick()?.fn();
		await h.settle();
		assert.equal(h.intervals.size, 0);

		h.setStale(false);
		await h.fire("session_start");
		assert.equal(h.intervals.size, 1, "a fresh session must re-arm the fetch timer");
		assert.doesNotThrow(() => h.tick()?.fn());
	} finally {
		h.restore();
	}
});

test("session_shutdown remains the primary cleanup", async () => {
	const h = await harness();
	try {
		await h.fire("session_start");
		assert.equal(h.intervals.size, 1);
		await h.fire("session_shutdown");
		assert.equal(h.intervals.size, 0, "session_shutdown must clear the timer");
	} finally {
		h.restore();
	}
});

test("quota:changed carries raw windows so the footer can tick the countdown itself", async () => {
	const h = await harness();
	try {
		await h.fire("session_start");
		const payload = h.emitted.at(-1) as { wins: { label: string; resetAt?: number }[]; showReset: boolean };

		assert.ok(payload, "session_start must emit quota:changed");
		assert.ok(Array.isArray(payload.wins), "payload must carry raw windows, not pre-formatted text");
		assert.deepEqual(
			payload.wins.map((w) => w.label),
			["5h", "wk"],
		);
		// resetAt is what lets the footer recompute the countdown on every repaint.
		assert.ok(payload.wins.every((w) => typeof w.resetAt === "number"));
		assert.equal(typeof payload.showReset, "boolean", "showReset must ride along for separate module copies");
	} finally {
		h.restore();
	}
});
