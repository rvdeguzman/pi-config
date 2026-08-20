/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, type AgentSessionEvent, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Project/global default for writing a subagent's `.output` transcript; a custom
 * agent's `output_transcript` overrides it per agent.
 *
 * State lives here rather than in an index.ts closure because both spawn paths
 * need it — the top-level Agent tool and the nested delegation tools. Same
 * reason `scopeModels` lives in model-scope.ts: a setting only one path can read
 * is a setting the other path silently ignores.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

/**
 * Transcript root: `<agentDir>/subagent-runs`, NOT the OS temp dir. The
 * motivating incident's 37-minute worker transcript went to tmpdir() and the
 * OS reaped it — the one artifact that could explain a bad run has to survive
 * longer than /tmp does. No uid suffix: the agent dir is already per-user.
 * Nothing reaps this location, so `pruneOutputFiles` (called at extension
 * startup) ages runs out after 14 days instead.
 */
export function outputFilesRoot(): string {
  return join(getAgentDir(), "subagent-runs");
}

/** Create the output file path, ensuring the directory exists.
 *  Mirrors Claude Code's layout: {root}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const root = outputFilesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows and throws on some Windows filesystems.
  // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.output`);
}

/** Transcripts older than this are pruned at startup. */
const PRUNE_MAX_AGE_MS = 14 * 24 * 3_600_000;

/**
 * Age out old transcripts. tmpdir() came with free (if hostile) cleanup; the
 * agent-dir location has none, so this runs once at extension startup.
 * Best-effort throughout — a prune failure must never block activation. The
 * walk follows the fixed {root}/{encoded-cwd}/{sessionId}/tasks/*.output
 * layout rather than a recursive readdir, and removes directories only once
 * empty (rmdirSync refuses non-empty ones, which is exactly the guard needed).
 */
export function pruneOutputFiles(maxAgeMs: number = PRUNE_MAX_AGE_MS): void {
  const cutoff = Date.now() - maxAgeMs;
  const list = (dir: string): string[] => {
    try { return readdirSync(dir); } catch { return []; }
  };
  const rmdirIfEmpty = (dir: string): void => {
    try { rmdirSync(dir); } catch { /* non-empty or gone — both fine */ }
  };
  const root = outputFilesRoot();
  for (const cwdName of list(root)) {
    const cwdDir = join(root, cwdName);
    for (const sessionName of list(cwdDir)) {
      const sessionDir = join(cwdDir, sessionName);
      const tasksDir = join(sessionDir, "tasks");
      for (const file of list(tasksDir)) {
        const filePath = join(tasksDir, file);
        try {
          if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
        } catch { /* raced or unreadable — skip */ }
      }
      rmdirIfEmpty(tasksDir);
      rmdirIfEmpty(sessionDir);
    }
    rmdirIfEmpty(cwdDir);
  }
}

/**
 * Ensure a transcript file exists without disturbing what is already in it.
 *
 * A resume reuses the agent's existing transcript (same deterministic path), so
 * it must never call `writeInitialEntry` — that truncates, discarding turns the
 * completion notification still points the user at, and any history the session
 * has since compacted away is gone for good. Appending nothing creates the file
 * when this is the agent's first transcript and is a no-op when it is not.
 */
export function ensureOutputFile(path: string): void {
  try {
    appendFileSync(path, "", "utf-8");
  } catch { /* ignore — streaming writes are best-effort too */ }
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  // Index of the first message this stream is responsible for. A spawn writes
  // messages[0] as the initial prompt entry, so it starts at 1. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file.
  let writtenCount = startIndex ?? 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch { /* ignore write errors */ }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction replaces session.messages with a shorter, summarized array,
    // leaving writtenCount past the new end — without re-anchoring, the flush
    // loop would never match again and streaming would halt for good (#145).
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then re-anchor to the rebuilt array once it lands. The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would sit one past the trimmed array and skip
    // the first post-compaction message. Aborted/failed compactions leave
    // session.messages untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => { writtenCount = session.messages.length; });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
