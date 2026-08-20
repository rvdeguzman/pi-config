// Deadline-aware status notes and the abnormal-exit report.
//
// The wording distinction matters operationally: "ran out of turns" suggests a
// bigger turn cap; "killed at its time budget" plus the non-retry framing is
// what stops an orchestrator from re-spawning the same doomed task — the
// 37-minute incident, times N.

import { describe, expect, it } from "vitest";
import { createFlightRecorder } from "../src/flight-recorder.js";
import { abnormalExitReport, getForegroundOutcomeNote, getStatusNote } from "../src/status-note.js";

const KILLED = { budgetMs: 900_000, exceeded: true } as const;
const WRAPPED = { budgetMs: 900_000, softFired: true } as const;

describe("deadline-aware status notes", () => {
  it("switches aborted wording from turns to time on a deadline kill", () => {
    expect(getStatusNote("aborted")).toContain("turn limit");
    expect(getStatusNote("aborted", KILLED)).toContain("KILLED at its 15m time budget");
    expect(getForegroundOutcomeNote("aborted", KILLED)).toContain("15m time budget");
  });

  it("switches steered wording when the wrap-up came from the time budget", () => {
    expect(getStatusNote("steered")).toContain("turn limit");
    expect(getStatusNote("steered", WRAPPED)).toContain("time budget");
    expect(getForegroundOutcomeNote("steered", WRAPPED)).toContain("time budget");
  });

  it("a deadline that armed but never fired changes no wording", () => {
    const armedOnly = { budgetMs: 900_000 };
    expect(getStatusNote("aborted", armedOnly)).toBe(getStatusNote("aborted"));
    expect(getStatusNote("steered", armedOnly)).toBe(getStatusNote("steered"));
  });
});

describe("abnormalExitReport", () => {
  function stoppedRecordWithWork() {
    const recorder = createFlightRecorder();
    recorder.observe({ type: "start", toolName: "edit", toolCallId: "c1", args: { path: "/src/a.ts" } });
    recorder.observe({ type: "end", toolName: "edit", toolCallId: "c1", isError: false });
    return { status: "stopped", recorder, deadline: undefined };
  }

  it("is empty for clean completions and steered wrap-ups — those runs stay byte-identical", () => {
    const recorder = createFlightRecorder();
    recorder.observe({ type: "start", toolName: "bash", toolCallId: "c1", args: { command: "ls" } });
    expect(abnormalExitReport({ status: "completed", recorder, deadline: undefined })).toBe("");
    expect(abnormalExitReport({ status: "steered", recorder, deadline: WRAPPED })).toBe("");
  });

  it("appends the flight recorder on a user stop — 'No output.' is never again the whole story", () => {
    const report = abnormalExitReport(stoppedRecordWithWork());
    expect(report).toContain("What the agent DID (flight recorder):");
    expect(report).toContain("/src/a.ts");
  });

  it("leads with explicit non-retry framing on a deadline kill", () => {
    const record = { ...stoppedRecordWithWork(), status: "aborted", deadline: { ...KILLED } };
    const report = abnormalExitReport(record);
    expect(report).toContain("killed at its 15m wall-clock budget");
    expect(report).toContain("NOT a transient failure");
    expect(report).toContain("do not re-run the same task unchanged");
    // Framing first, evidence second.
    expect(report.indexOf("NOT a transient failure")).toBeLessThan(report.indexOf("flight recorder"));
  });

  it("stays quiet when an abnormal exit has no recorded work and no deadline kill", () => {
    expect(abnormalExitReport({ status: "stopped", recorder: createFlightRecorder(), deadline: undefined })).toBe("");
    expect(abnormalExitReport({ status: "stopped", recorder: undefined, deadline: undefined })).toBe("");
  });
});
