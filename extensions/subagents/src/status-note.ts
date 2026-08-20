/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import { formatDurationMs } from "./deadline.js";
import type { AgentRecord, DeadlineState } from "./types.js";

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff.
 *
 * `deadline` switches the aborted/steered wording from turns to time: the two
 * leashes are different facts ("ran out of turns" suggests a bigger turn cap;
 * "ran out of time" suggests the task itself doesn't converge) and conflating
 * them invites exactly the wrong retry.
 */
export function getStatusNote(status: string, deadline?: DeadlineState): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return deadline?.exceeded
        ? ` (KILLED at its ${formatDurationMs(deadline.budgetMs)} time budget — output may be incomplete)`
        : " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return deadline?.softFired
        ? " (wrapped up at its time budget — output may be partial)"
        : " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string, deadline?: DeadlineState): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return deadline?.exceeded
        ? ` (KILLED at its ${formatDurationMs(deadline.budgetMs)} time budget — everything the agent produced is above; the task is unfinished)`
        : " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return deadline?.softFired
        ? " (wrapped up at its time budget — everything the agent produced is above; the task may be unfinished)"
        : " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/** Statuses whose result surfaces get the flight recorder appended. */
function isAbnormalExit(status: string): boolean {
  return status === "stopped" || status === "aborted" || status === "error";
}

/**
 * Post-mortem block for a run that ended abnormally — appended to every
 * result surface (foreground tool result, background notification,
 * get_subagent_result, nested results). Two parts, both bounded:
 *
 *   - Deadline framing, only on a wall-clock kill. Explicitly non-retry: the
 *     motivating incident was a task that could never satisfy its own
 *     verification gate, where a neutral "exceeded budget" reads as transient
 *     and invites the same doomed spawn again — 37 minutes × N.
 *   - The flight recorder: what the agent DID (files, commands, last N tool
 *     calls). A stopped agent's text is usually "No output." while its real
 *     output sits in the files it touched; without this the orchestrator has
 *     to rediscover that work by diffing.
 *
 * Empty string for clean completions and steered wrap-ups — those runs stay
 * byte-identical to before and cost no extra tokens.
 */
export function abnormalExitReport(
  record: Pick<AgentRecord, "status" | "deadline" | "recorder">,
): string {
  if (!isAbnormalExit(record.status)) return "";
  const parts: string[] = [];
  if (record.deadline?.exceeded) {
    parts.push(
      `This agent was killed at its ${formatDurationMs(record.deadline.budgetMs)} wall-clock budget. ` +
      "This is NOT a transient failure — do not re-run the same task unchanged. " +
      "Something about the task prevents completion within budget: it is too big, blocked on an " +
      "impossible requirement, or looping on a failing step. Review what it did below, then either " +
      "finish the remainder directly or delegate a smaller task with the blocker removed.",
    );
  }
  const flight = record.recorder?.render();
  if (flight) parts.push(flight);
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}
