// README promises the transcript root is owner-only `0700`. Transcripts hold
// the agent's full conversation — user prompts, file contents, tool output —
// so that mode is the only thing keeping them from other local users.
//
// The root moved from `<os-tmpdir>/pi-subagents-<uid>` to
// `<agentDir>/subagent-runs`: tmpdir() reaping destroyed the one artifact that
// could explain a bad run (the motivating incident was a 37-minute worker
// whose transcript was gone by the time anyone looked). No uid suffix anymore —
// the agent dir is already per-user. Durability's price is that nothing
// external ages transcripts out, which is `pruneOutputFiles`' job, tested here.
//
// Each test redirects the agent dir via PI_CODING_AGENT_DIR (evaluated per
// call by pi's getAgentDir) so runs never share state with real transcripts
// or the e2e suites.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutputFilePath, pruneOutputFiles } from "../src/output-file.js";

const AGENT = "agent-xyz";
const SESSION = "session-123";

let tmpAgentDir: string;
let root: string;
let originalEnv: string | undefined;

beforeEach(() => {
  // realpath: macOS resolves /var → /private/var, and the module joins the
  // raw value, so comparisons must use the same form.
  tmpAgentDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-outpath-")));
  originalEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  root = join(tmpAgentDir, "subagent-runs");
});

afterEach(() => {
  if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalEnv;
  rmSync(tmpAgentDir, { recursive: true, force: true });
});

describe("createOutputFilePath", () => {
  it("builds the documented layout: <agentDir>/subagent-runs/<encoded-cwd>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(root, "home-user-project", SESSION, "tasks", `${AGENT}.output`));
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(join(path, ".."))).toBe(true);
    expect(statSync(join(path, "..")).isDirectory()).toBe(true);
  });

  it("keeps distinct cwds in separate subdirectories under the shared root", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/user/other", "agent-2", SESSION);
    expect(a).not.toBe(b);
    expect(a.startsWith(root)).toBe(true);
    expect(b.startsWith(root)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("creates the root owner-only", () => {
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable root", () => {
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);

    createOutputFilePath("/home/user/project", AGENT, SESSION);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});

describe("pruneOutputFiles", () => {
  const DAY_MS = 24 * 3_600_000;

  /** Create a transcript and backdate its mtime by `ageDays`. */
  function plantTranscript(cwd: string, agentId: string, sessionId: string, ageDays: number): string {
    const path = createOutputFilePath(cwd, agentId, sessionId);
    writeFileSync(path, "{}\n", "utf-8");
    const then = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(path, then, then);
    return path;
  }

  it("removes transcripts older than the max age and their emptied directories", () => {
    const old = plantTranscript("/home/user/project", "old-agent", "old-session", 20);

    pruneOutputFiles(14 * DAY_MS);

    expect(existsSync(old)).toBe(false);
    // The whole emptied chain goes: tasks/, session/, encoded-cwd/.
    expect(existsSync(join(root, "home-user-project"))).toBe(false);
  });

  it("keeps transcripts younger than the max age", () => {
    const fresh = plantTranscript("/home/user/project", "fresh-agent", "fresh-session", 2);

    pruneOutputFiles(14 * DAY_MS);

    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps a directory that still holds a fresh transcript while removing the stale sibling", () => {
    const old = plantTranscript("/home/user/project", "old-agent", SESSION, 20);
    const fresh = plantTranscript("/home/user/project", "fresh-agent", SESSION, 1);

    pruneOutputFiles(14 * DAY_MS);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("is a no-op when the root does not exist", () => {
    expect(() => pruneOutputFiles()).not.toThrow();
  });
});
