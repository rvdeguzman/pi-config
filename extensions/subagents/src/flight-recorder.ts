/**
 * flight-recorder.ts — Bounded ledger of what an agent DID, for abnormal exits.
 *
 * A stopped/aborted/errored run reports its last assistant TEXT, which for a
 * working agent is usually nothing — the motivating incident returned
 * "No output." after 37 minutes and 51 tool uses, and the good work it had
 * done was only discoverable by reading the diff. The output was in the
 * FILES, not the words.
 *
 * The runner's session subscription already receives `tool_execution_start`
 * (with args) and `tool_execution_end` (with isError) and previously threw
 * both away. This recorder catches them: a ring buffer of the last N calls
 * plus a deduplicated ledger of file mutations and bash commands. It is
 * rendered ONLY on abnormal exits (status-note.ts `abnormalExitReport`), so a
 * clean run costs zero extra tokens and is byte-identical to before.
 */

/** Structurally matches agent-runner's ToolActivity — kept local to avoid a cycle. */
export interface RecordedActivity {
  type: "start" | "end";
  toolName: string;
  /** Absent for synthetic diagnostics (`extension-error:*`) — those are skipped. */
  toolCallId?: string;
  /** Start events only. */
  args?: unknown;
  /** End events only. */
  isError?: boolean;
}

/** Last N tool calls kept verbatim. */
const RING_SIZE = 30;
/** One-line args summary cap per ring entry. */
const ARGS_MAX_CHARS = 110;
/** Distinct file paths shown in the render (all are counted). */
const FILES_SHOWN = 20;
/** Distinct commands shown in the render (all are counted). */
const COMMANDS_SHOWN = 15;
/** Dedup key cap for long command lines. */
const COMMAND_KEY_MAX = 200;
/** In-flight start→end matching entries kept (ends normally arrive at once). */
const PENDING_CAP = 100;

interface RingEntry {
  toolName: string;
  argsSummary: string;
  isError: boolean;
  /** Dedup key into `commands`, for error attribution at end time. */
  commandKey?: string;
}

export interface FlightRecorder {
  observe(activity: RecordedActivity): void;
  /** True once at least one real tool call was seen. */
  hasData(): boolean;
  /** Bounded plain-text report; "" when there is nothing to report. */
  render(): string;
}

function summarizeArgs(args: unknown): string {
  let text: string;
  try {
    text = args === undefined ? "" : JSON.stringify(args) ?? "";
  } catch {
    text = String(args);
  }
  text = text.replace(/\s+/g, " ");
  return text.length > ARGS_MAX_CHARS ? `${text.slice(0, ARGS_MAX_CHARS)}…` : text;
}

export function createFlightRecorder(): FlightRecorder {
  const ring: RingEntry[] = [];
  /** toolCallId → entry, for marking isError when the end event lands. */
  const pending = new Map<string, RingEntry>();
  /** Insertion-ordered distinct paths from edit/write calls. */
  const filesTouched = new Set<string>();
  /** command → run/error counts. */
  const commands = new Map<string, { count: number; errors: number }>();
  let totalCalls = 0;

  const observe = (a: RecordedActivity): void => {
    // Synthetic diagnostics reuse the activity channel with no toolCallId.
    if (!a.toolCallId) return;

    if (a.type === "start") {
      totalCalls++;
      const args = (a.args ?? {}) as Record<string, unknown>;
      const entry: RingEntry = {
        toolName: a.toolName,
        argsSummary: summarizeArgs(a.args),
        isError: false,
      };

      const lower = a.toolName.toLowerCase();
      if (lower === "edit" || lower === "write") {
        // pi built-ins use `path`; Claude Code-style tools use `file_path`.
        const p = typeof args.path === "string" ? args.path
          : typeof args.file_path === "string" ? args.file_path : undefined;
        if (p) filesTouched.add(p);
      } else if (lower === "bash") {
        const c = typeof args.command === "string" ? args.command
          : typeof args.cmd === "string" ? args.cmd : undefined;
        if (c) {
          const key = c.length > COMMAND_KEY_MAX ? c.slice(0, COMMAND_KEY_MAX) : c;
          entry.commandKey = key;
          const cur = commands.get(key) ?? { count: 0, errors: 0 };
          cur.count++;
          commands.set(key, cur);
        }
      }

      ring.push(entry);
      if (ring.length > RING_SIZE) ring.shift();
      pending.set(a.toolCallId, entry);
      if (pending.size > PENDING_CAP) {
        // Ends normally arrive immediately; a runaway of never-ended starts
        // must not grow unbounded. Drop the oldest key.
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      return;
    }

    const entry = pending.get(a.toolCallId);
    pending.delete(a.toolCallId);
    if (!entry || !a.isError) return;
    entry.isError = true;
    if (entry.commandKey) {
      const cmd = commands.get(entry.commandKey);
      if (cmd) cmd.errors++;
    }
  };

  const render = (): string => {
    if (totalCalls === 0) return "";
    const lines: string[] = ["What the agent DID (flight recorder):"];

    if (filesTouched.size > 0) {
      const files = [...filesTouched];
      const shown = files.slice(0, FILES_SHOWN);
      const more = files.length - shown.length;
      lines.push(`Files written/edited (${files.length}): ${shown.join(", ")}${more > 0 ? ` …and ${more} more` : ""}`);
    }

    if (commands.size > 0) {
      const total = [...commands.values()].reduce((n, c) => n + c.count, 0);
      lines.push(`Commands run (${commands.size} distinct, ${total} total; ✗ = failed):`);
      const byCount = [...commands.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [cmd, { count, errors }] of byCount.slice(0, COMMANDS_SHOWN)) {
        const mark = errors === count ? "✗" : errors > 0 ? `✗${errors}/✓${count - errors}` : "✓";
        lines.push(`  ${count}× ${mark} ${cmd}`);
      }
      if (byCount.length > COMMANDS_SHOWN) lines.push(`  …and ${byCount.length - COMMANDS_SHOWN} more distinct commands`);
    }

    lines.push(`Last ${ring.length} of ${totalCalls} tool calls (✗ = returned error):`);
    for (const entry of ring) {
      lines.push(`  ${entry.isError ? "✗" : "·"} ${entry.toolName} ${entry.argsSummary}`.trimEnd());
    }

    return lines.join("\n");
  };

  return { observe, hasData: () => totalCalls > 0, render };
}
