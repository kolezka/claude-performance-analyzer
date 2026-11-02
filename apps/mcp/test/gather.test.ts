import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gather, parseSince, resolveScope, UserError } from "../src/gather";
import { attachmentLine, hookFiring, SID, sessionTranscript, T0, tempEnv, writeTelemetry, writeTranscript, type TempEnv } from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
});
afterEach(() => env.restore());

const current = { CLAUDE_CODE_SESSION_ID: SID };

test("parseSince accepts minutes, hours and days and rejects anything else", () => {
  expect(parseSince("15m")).toBe(15 * 60_000);
  expect(parseSince("24h")).toBe(24 * 3_600_000);
  expect(parseSince("7d")).toBe(7 * 86_400_000);
  expect(() => parseSince("yesterday")).toThrow(UserError);
});

test("current session needs CLAUDE_CODE_SESSION_ID and says so when it is missing", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  await expect(resolveScope({}, {})).rejects.toThrow("CLAUDE_CODE_SESSION_ID");
});

test("a session is found by id or prefix in any project folder, including one it moved to", async () => {
  // A session that switched into a worktree has its transcript under the worktree's folder.
  writeTranscript(env, "-work-demo--claude-worktrees-feature", SID, sessionTranscript());
  const byEnv = await resolveScope({}, current);
  expect(byEnv.sessions.map((s) => s.sessionId)).toEqual([SID]);
  const byPrefix = await resolveScope({ session: SID.slice(0, 8) }, {});
  expect(byPrefix.sessions.map((s) => s.sessionId)).toEqual([SID]);
  await expect(resolveScope({ session: "99999999" }, {})).rejects.toThrow("No transcript found");
});

test("subagent transcripts count toward their session", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  const subDir = join(env.claudeDir, "projects", "-work-demo", SID, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, "agent-abc.jsonl"), attachmentLine({ type: "hook_additional_context", hookName: "PreToolUse:Bash", hookEvent: "PreToolUse", content: ["sub ctx"] }, T0 + 5_000));
  const h = await gather({}, current);
  const sub = h.blocks.filter((b) => b.agentId === "abc");
  expect(sub.map((b) => b.chars)).toEqual(["sub ctx".length]);
});

test("missing telemetry is reported as unavailable, never as zero hook time", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  const h = await gather({}, current);
  expect(h.firings).toBeNull();
  expect(h.telemetryNote).toContain("no telemetry database");
  // Transcript data still comes through.
  expect(h.blocks).toHaveLength(6);
});

test("an unreadable telemetry file is reported as unreadable, not as empty", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  writeFileSync(join(env.telemetryDir, "telemetry.sqlite"), "this is not a database, just bytes ".repeat(200));
  const h = await gather({}, current);
  expect(h.firings).toBeNull();
  expect(h.telemetryNote).toContain("could not be read");
});

test("valid telemetry yields the session's hook firings (positive control)", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  writeTelemetry(env, [hookFiring(SID, T0 + 100, "SessionStart:startup", "SessionStart", 1300), hookFiring("other-session", T0 + 100, "Stop", "Stop", 50)]);
  const h = await gather({}, current);
  expect(h.telemetryNote).toBeNull();
  expect(h.firings!.map((f) => [f.label, f.durationMs])).toEqual([["SessionStart:startup", 1300]]);
});

test("session='all' with since keeps only newer blocks and prompts, and project filters by folder", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  const h = await gather({ session: "all", since: "1m" }, {}, T0 + 61_000);
  expect(h.scope.kind).toBe("all");
  expect(h.blocks.every((b) => b.tsMs >= T0 + 1_000)).toBe(true);
  expect(h.blocks).toHaveLength(4);
  expect(h.prompts).toBe(2);
  const none = await gather({ session: "all", since: "1m", project: "nomatch" }, {}, T0 + 61_000);
  expect(none.scope.sessions).toHaveLength(0);
});
