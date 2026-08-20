/**
 * deadline.ts — Wall-clock time budget for a subagent run.
 *
 * Turn limits measure the wrong unit: a turn holding a 10-minute build and a
 * turn holding a `grep` count the same. The motivating incident was a worker
 * that spent 37 minutes (18 of 30 turns, 51 tool uses) productively looping on
 * an impossible verification gate — no stall detector fires on an agent that
 * is busy, only a wall clock does.
 *
 * Two-stage, mirroring the turn leash in agent-runner.ts:
 *   - SOFT at the budget: steer "wrap up now, report what you have".
 *   - HARD at budget + grace: abort on the timer itself, NOT at a turn
 *     boundary — the whole point is catching a run wedged inside one long
 *     tool call, which a turn-keyed check structurally cannot.
 *
 * The budget resolves frontmatter (`max_duration:`) → `defaultMaxDuration`
 * (subagents.json) → 10 minutes. `0` means unlimited, same spelling as
 * `max_turns`. The clock is armed when the run's first turn starts (just
 * before `session.prompt`), so time queued under `maxConcurrent` is free.
 * A HUMAN steer resets the clock to a full budget — the user just handed the
 * agent new work with eyes on it; the deadline's own wrap-up steer and the
 * model's `steer_subagent` do not.
 */

/** Sanity ceiling — a "deadline" past a day is a typo, not a budget. */
const MAX_DURATION_CEILING_MS = 24 * 3_600_000;

/** Documented default: 10 minutes (README / spec — kills the incident at 15m
 *  via worker's own frontmatter, at 10m for anything untuned). */
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;

let defaultMaxDurationMs: number | undefined = DEFAULT_MAX_DURATION_MS;

/** Get the default wall-clock budget in ms. undefined = unlimited. */
export function getDefaultMaxDurationMs(): number | undefined { return defaultMaxDurationMs; }
/** Set the default wall-clock budget in ms. undefined or 0 = unlimited. */
export function setDefaultMaxDurationMs(ms: number | undefined): void {
  defaultMaxDurationMs = normalizeMaxDurationMs(ms);
}

/**
 * Grace window between the wrap-up steer and the hard abort. 90s: enough for
 * a model to write a handoff paragraph, not enough to "just try one more fix".
 */
let deadlineGraceMs = 90_000;

export function getDeadlineGraceMs(): number { return deadlineGraceMs; }
export function setDeadlineGraceMs(ms: number): void { deadlineGraceMs = Math.max(1_000, ms); }

/** Normalize a budget: undefined or 0 = unlimited, otherwise minimum 1s. */
export function normalizeMaxDurationMs(ms: number | undefined): number | undefined {
  if (ms == null || ms === 0) return undefined;
  return Math.max(1_000, ms);
}

/**
 * Parse a `max_duration` / `defaultMaxDuration` value into ms.
 *
 * Accepts a number (SECONDS — frontmatter `max_duration: 300`) or a string
 * with a unit: "15m", "90s", "1h", "500ms"; a bare numeric string is seconds.
 * `0` in any spelling means unlimited and is preserved as 0 so an explicit
 * frontmatter `max_duration: 0` can override a global default (0 ≠ absent).
 * Invalid or past the 24h ceiling → undefined (field dropped), matching how
 * settings.ts sanitizes every other field.
 */
export function parseDuration(value: unknown): number | undefined {
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    ms = value * 1_000;
  } else if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
    if (!match) return undefined;
    const n = Number(match[1]);
    const unit = (match[2] ?? "s").toLowerCase();
    ms = unit === "ms" ? n : unit === "s" ? n * 1_000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  } else {
    return undefined;
  }
  if (ms > MAX_DURATION_CEILING_MS) return undefined;
  return Math.round(ms);
}

/** Human spelling of a budget for steer/report text: "15m", "90s", "1h". */
export function formatDurationMs(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

export interface DeadlineHooks {
  /** Fire the wrap-up steer. Must not throw. */
  onSoft(budgetMs: number, graceMs: number): void;
  /** Hard-abort the run. Must not throw. */
  onHard(): void;
}

export interface Deadline {
  readonly budgetMs: number;
  /** Start (or restart) both timers with the full budget from now. */
  arm(): void;
  /** Stop both timers (run settled). */
  clear(): void;
  /**
   * Remaining lifetime in ms until the HARD abort (budget + grace). Full
   * budget before the first arm — a child clamped to its parent's remaining
   * time must not be strangled by asking a moment too early.
   */
  remainingMs(): number;
  /** Whether the wrap-up steer has fired for the current arm. */
  softFired(): boolean;
  /** Whether the hard abort fired. */
  exceeded(): boolean;
}

/**
 * Build a two-stage deadline. Pure timer mechanics — the session-facing steer
 * and abort live in the hooks, so this is testable with fake timers alone.
 */
export function createDeadline(budgetMs: number, hooks: DeadlineHooks): Deadline {
  let softTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let armedAt = 0;
  let soft = false;
  let hard = false;

  const clear = () => {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    softTimer = hardTimer = undefined;
  };

  const arm = () => {
    if (hard) return; // an exceeded deadline stays exceeded
    clear();
    armedAt = Date.now();
    soft = false;
    const graceMs = getDeadlineGraceMs();
    softTimer = setTimeout(() => {
      soft = true;
      hooks.onSoft(budgetMs, graceMs);
    }, budgetMs);
    softTimer.unref?.();
    hardTimer = setTimeout(() => {
      hard = true;
      clear();
      hooks.onHard();
    }, budgetMs + graceMs);
    hardTimer.unref?.();
  };

  return {
    budgetMs,
    arm,
    clear,
    remainingMs: () => {
      if (hard) return 0;
      if (armedAt === 0) return budgetMs + getDeadlineGraceMs();
      return Math.max(0, budgetMs + getDeadlineGraceMs() - (Date.now() - armedAt));
    },
    softFired: () => soft,
    exceeded: () => hard,
  };
}
