// Flight recorder: what an agent DID, for abnormal-exit reporting.
//
// The motivating incident returned "No output." after 37 minutes and 51 tool
// uses — the work was in the files, not the final text. These tests pin the
// three ledgers (ring, files, commands) and the bounds that keep the render
// from becoming its own token problem.

import { describe, expect, it } from "vitest";
import { createFlightRecorder } from "../src/flight-recorder.js";

function start(toolName: string, args: unknown, toolCallId = `${toolName}-${Math.random()}`) {
  return { type: "start" as const, toolName, toolCallId, args };
}

describe("createFlightRecorder", () => {
  it("is empty until a real tool call arrives", () => {
    const r = createFlightRecorder();
    expect(r.hasData()).toBe(false);
    expect(r.render()).toBe("");
  });

  it("skips synthetic diagnostics (no toolCallId)", () => {
    const r = createFlightRecorder();
    r.observe({ type: "end", toolName: "extension-error:some-path" });
    expect(r.hasData()).toBe(false);
  });

  it("records calls and marks errors from the matching end event", () => {
    const r = createFlightRecorder();
    r.observe({ type: "start", toolName: "read", toolCallId: "c1", args: { path: "/a.ts" } });
    r.observe({ type: "end", toolName: "read", toolCallId: "c1", isError: true });
    r.observe({ type: "start", toolName: "read", toolCallId: "c2", args: { path: "/b.ts" } });
    r.observe({ type: "end", toolName: "read", toolCallId: "c2", isError: false });

    const out = r.render();
    expect(out).toContain('✗ read {"path":"/a.ts"}');
    expect(out).toContain('· read {"path":"/b.ts"}');
  });

  it("ledgers files from edit/write, accepting both path and file_path", () => {
    const r = createFlightRecorder();
    r.observe(start("edit", { path: "/src/a.ts", edits: [] }));
    r.observe(start("write", { file_path: "/src/b.ts", content: "x" }));
    r.observe(start("edit", { path: "/src/a.ts", edits: [] })); // dedup
    r.observe(start("read", { path: "/src/ignored.ts" })); // reads are not mutations

    const out = r.render();
    const filesLine = out.split("\n").find((l) => l.startsWith("Files written/edited"));
    expect(filesLine).toBe("Files written/edited (2): /src/a.ts, /src/b.ts");
    // The read still shows in the ring (it is a call) — just not as a mutation.
    expect(filesLine).not.toContain("ignored.ts");
  });

  it("ledgers bash commands with run and failure counts", () => {
    const r = createFlightRecorder();
    // The incident's shape: the same failing verification gate, re-run.
    for (let i = 0; i < 4; i++) {
      const id = `bash-${i}`;
      r.observe({ type: "start", toolName: "bash", toolCallId: id, args: { command: "npm run typecheck" } });
      r.observe({ type: "end", toolName: "bash", toolCallId: id, isError: true });
    }
    r.observe({ type: "start", toolName: "bash", toolCallId: "ok", args: { command: "ls src/" } });
    r.observe({ type: "end", toolName: "bash", toolCallId: "ok", isError: false });

    const out = r.render();
    expect(out).toContain("Commands run (2 distinct, 5 total; ✗ = failed):");
    expect(out).toContain("4× ✗ npm run typecheck");
    expect(out).toContain("1× ✓ ls src/");
  });

  it("keeps only the last 30 calls in the ring but counts them all", () => {
    const r = createFlightRecorder();
    for (let i = 0; i < 35; i++) {
      r.observe({ type: "start", toolName: "read", toolCallId: `c${i}`, args: { path: `/f${i}.ts` } });
    }
    const out = r.render();
    expect(out).toContain("Last 30 of 35 tool calls");
    expect(out).not.toContain("/f0.ts"); // evicted
    expect(out).toContain("/f34.ts");
  });

  it("truncates oversized args to one bounded line", () => {
    const r = createFlightRecorder();
    r.observe(start("bash", { command: "x".repeat(500) }));
    const line = r.render().split("\n").find((l) => l.includes("· bash"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(140);
    expect(line).toContain("…");
  });

  it("survives args that JSON cannot stringify", () => {
    const r = createFlightRecorder();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    r.observe(start("weird", cyclic));
    expect(r.render()).toContain("weird");
  });
});
