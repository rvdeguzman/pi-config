// Wall-clock deadline: parsing, normalization, and the two-stage timer.
//
// The timer tests use fake timers against `createDeadline` directly — the
// factory exists so the mechanics are testable without a session; the
// session-facing steer/abort live in the hooks the runner supplies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeadline,
  formatDurationMs,
  getDeadlineGraceMs,
  normalizeMaxDurationMs,
  parseDuration,
  setDeadlineGraceMs,
} from "../src/deadline.js";

describe("parseDuration", () => {
  it("parses unit strings", () => {
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration(" 10m ")).toBe(600_000);
  });

  it("treats bare numbers and numeric strings as seconds", () => {
    expect(parseDuration(300)).toBe(300_000);
    expect(parseDuration("300")).toBe(300_000);
  });

  it("preserves 0 as explicit-unlimited (distinct from absent)", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("0m")).toBe(0);
  });

  it("rejects garbage, negatives, and values past the 24h ceiling", () => {
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("-5m")).toBeUndefined();
    expect(parseDuration(-1)).toBeUndefined();
    expect(parseDuration("25h")).toBeUndefined();
    expect(parseDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseDuration(null)).toBeUndefined();
    expect(parseDuration({})).toBeUndefined();
    expect(parseDuration(true)).toBeUndefined();
  });
});

describe("normalizeMaxDurationMs", () => {
  it("maps undefined and 0 to unlimited", () => {
    expect(normalizeMaxDurationMs(undefined)).toBeUndefined();
    expect(normalizeMaxDurationMs(0)).toBeUndefined();
  });

  it("enforces a 1s floor and passes real budgets through", () => {
    expect(normalizeMaxDurationMs(5)).toBe(1_000);
    expect(normalizeMaxDurationMs(600_000)).toBe(600_000);
  });
});

describe("formatDurationMs", () => {
  it("prefers the largest clean unit", () => {
    expect(formatDurationMs(600_000)).toBe("10m");
    expect(formatDurationMs(3_600_000)).toBe("1h");
    expect(formatDurationMs(90_000)).toBe("90s");
    expect(formatDurationMs(61_000)).toBe("61s");
  });
});

describe("createDeadline", () => {
  const BUDGET = 10_000;
  const GRACE = 2_000;
  let originalGrace: number;
  let onSoft: ReturnType<typeof vi.fn>;
  let onHard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalGrace = getDeadlineGraceMs();
    setDeadlineGraceMs(GRACE);
    onSoft = vi.fn();
    onHard = vi.fn();
  });

  afterEach(() => {
    setDeadlineGraceMs(originalGrace);
    vi.useRealTimers();
  });

  it("fires the wrap-up steer at the budget and the hard abort a grace later", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();

    vi.advanceTimersByTime(BUDGET - 1);
    expect(onSoft).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSoft).toHaveBeenCalledWith(BUDGET, GRACE);
    expect(d.softFired()).toBe(true);
    expect(onHard).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE);
    expect(onHard).toHaveBeenCalledTimes(1);
    expect(d.exceeded()).toBe(true);
  });

  it("does nothing until armed — queue time is free", () => {
    createDeadline(BUDGET, { onSoft, onHard });
    vi.advanceTimersByTime(BUDGET * 10);
    expect(onSoft).not.toHaveBeenCalled();
    expect(onHard).not.toHaveBeenCalled();
  });

  it("re-arming (a human steer) restarts the clock with the full budget", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();

    vi.advanceTimersByTime(BUDGET - 1_000); // 1s from the steer
    d.arm(); // human steered — stale deadline

    vi.advanceTimersByTime(BUDGET - 1);
    expect(onSoft).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSoft).toHaveBeenCalledTimes(1);
  });

  it("re-arming after the wrap-up steer grants a fresh soft stage", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();
    vi.advanceTimersByTime(BUDGET);
    expect(d.softFired()).toBe(true);

    d.arm();
    expect(d.softFired()).toBe(false);
    vi.advanceTimersByTime(BUDGET + GRACE - 1);
    expect(onHard).not.toHaveBeenCalled();
  });

  it("an exceeded deadline stays exceeded — arm() after the hard kill is a no-op", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();
    vi.advanceTimersByTime(BUDGET + GRACE);
    expect(d.exceeded()).toBe(true);

    d.arm();
    vi.advanceTimersByTime(BUDGET + GRACE);
    expect(onHard).toHaveBeenCalledTimes(1);
    expect(d.exceeded()).toBe(true);
  });

  it("clear() stops both stages (run settled first)", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();
    d.clear();
    vi.advanceTimersByTime(BUDGET + GRACE + 1);
    expect(onSoft).not.toHaveBeenCalled();
    expect(onHard).not.toHaveBeenCalled();
  });

  it("remainingMs reports the full lifetime before arming — a child clamped early is not strangled", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    expect(d.remainingMs()).toBe(BUDGET + GRACE);
  });

  it("remainingMs counts down to the hard kill and bottoms out at 0", () => {
    const d = createDeadline(BUDGET, { onSoft, onHard });
    d.arm();
    vi.advanceTimersByTime(4_000);
    expect(d.remainingMs()).toBe(BUDGET + GRACE - 4_000);

    vi.advanceTimersByTime(BUDGET + GRACE);
    expect(d.remainingMs()).toBe(0);
  });
});
