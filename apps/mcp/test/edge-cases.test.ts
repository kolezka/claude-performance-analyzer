// Inputs that once produced wrong numbers or a hung server without saying so.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { gather, UserError } from "../src/gather";
import { createServer } from "../src/protocol";
import { runIsolatedQuery } from "../src/query";
import { harnessTools } from "../src/tools";
import { parseTranscript } from "../src/transcript";
import {
  attachmentLine,
  hookContext,
  hookFiring,
  hookSuccess,
  PERSISTED_PATH,
  persistedBlock,
  promptLine,
  readLine,
  renderedContext,
  SID,
  sessionTranscript,
  CWD,
  T0,
  tempEnv,
  toolResultLine,
  writeTelemetry,
  writeTranscript,
  type TempEnv,
} from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
});
afterEach(() => env.restore());

const current = { CLAUDE_CODE_SESSION_ID: SID };
const ctxJson = (text: string) => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });

test("a runaway query times out and the server keeps answering", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  process.env.CPA_MCP_QUERY_TIMEOUT_MS = "1500";
  try {
    const query = harnessTools(current).find((t) => t.name === "harness_query")!;
    const started = performance.now();
    await expect(Promise.resolve(query.run({ sql: "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT count(*) FROM x" }))).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await query.run({ sql: "SELECT count(*) AS n FROM blocks" })).toBe("n\n6");
  } finally {
    delete process.env.CPA_MCP_QUERY_TIMEOUT_MS;
  }
}, 20_000);

test("a persisted preview goes to the command whose output it is a prefix of, and an ambiguous one to nobody", () => {
  const header = "H".repeat(400);
  const a = `${header}\nalpha ${"a".repeat(3000)}`;
  const b = `${header}\nbeta ${"b".repeat(3000)}`;
  const runs = [hookSuccess("SessionStart", "cmd-a", ctxJson(a), 10, T0), hookSuccess("SessionStart", "cmd-b", ctxJson(b), 10, T0 + 1)];
  const distinct = parseTranscript([...runs, hookContext("SessionStart", [persistedBlock("3KB", "/x/hook-b.txt", b.slice(0, 2048))], T0 + 2)].join("\n"));
  expect(distinct.blocks.map((x) => x.command)).toEqual(["cmd-b"]);
  const ambiguous = parseTranscript([...runs, hookContext("SessionStart", [persistedBlock("3KB", "/x/hook-?.txt", header.slice(0, 300))], T0 + 2)].join("\n"));
  expect(ambiguous.blocks.map((x) => x.command)).toEqual([null]);
});

test("outputs printed for one event stay matchable across separate context attachments", () => {
  const d = parseTranscript(
    [
      hookSuccess("SessionStart", "cmd-a", ctxJson("alpha"), 10, T0),
      hookSuccess("SessionStart", "cmd-b", ctxJson("beta"), 10, T0 + 1),
      hookContext("SessionStart", ["alpha"], T0 + 2),
      hookContext("SessionStart", ["beta"], T0 + 3),
    ].join("\n"),
  );
  expect(d.blocks.map((x) => x.command)).toEqual(["cmd-a", "cmd-b"]);
});

test("a hook line cut short inside its content is counted as unreadable, not skipped silently", () => {
  const full = hookContext("UserPromptSubmit", ["x".repeat(5000)], T0);
  const cut = full.slice(0, full.indexOf("x".repeat(100)) + 100);
  expect(cut).not.toContain('"type":"attachment"');
  const d = parseTranscript([promptLine("p1", "hi", T0 - 10), cut].join("\n"));
  expect(d.badLines).toBe(1);
});

test("a transcript without hook attachments still knows its session, folder and branch", async () => {
  const text = [promptLine("p1", "hi", T0), promptLine("p2", "again", T0 + 10)].join("\n");
  const d = parseTranscript(text);
  expect([d.sessionId, d.cwd]).toEqual([SID, CWD]);
  writeTranscript(env, "-work-demo", SID, text);
  const h = await gather({ session: "all", since: "1m", project: "demo" }, {}, T0 + 30_000);
  expect(h.scope.sessions.map((s) => s.sessionId)).toEqual([SID]);
});

test("an unreadable transcript folder is an error, not zero sessions", async () => {
  rmSync(join(env.claudeDir, "projects"), { recursive: true });
  await expect(gather({ session: "all" }, {})).rejects.toThrow(UserError);
  await expect(gather({ session: "all" }, {})).rejects.toThrow("Cannot read transcripts");
  await expect(gather({}, current)).rejects.toThrow("Cannot read transcripts");
});

test("only a successful, whole-file Read counts as reading persisted output back", () => {
  const recall = hookContext("UserPromptSubmit", [persistedBlock("12KB", PERSISTED_PATH, "<hindsight_memory>\nx\n</hindsight_memory>")], T0 + 1);
  const base = [promptLine("p1", "hi", T0), recall];
  const failed = parseTranscript([...base, readLine(PERSISTED_PATH, T0 + 2, "t1"), toolResultLine("p1", "t1", true, T0 + 3)].join("\n"));
  expect(failed.readPaths).toEqual([]);
  const partial = parseTranscript([...base, readLine(PERSISTED_PATH, T0 + 2, "t2", { limit: 1 }), toolResultLine("p1", "t2", false, T0 + 3)].join("\n"));
  expect(partial.readPaths).toEqual([]);
  const unanswered = parseTranscript([...base, readLine(PERSISTED_PATH, T0 + 2, "t3")].join("\n"));
  expect(unanswered.readPaths).toEqual([]);
  const ok = parseTranscript([...base, readLine(PERSISTED_PATH, T0 + 2, "t4"), toolResultLine("p1", "t4", false, T0 + 3)].join("\n"));
  expect(ok.readPaths).toEqual([PERSISTED_PATH]);
});

test("with since, no turn-time share is computed from turns that started before the window", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  writeTelemetry(env, [
    { tsMs: T0, name: "user_prompt", sessionId: SID, promptId: "p1", attrs: {} },
    { ...hookFiring(SID, T0 + 500, "UserPromptSubmit", "UserPromptSubmit", 400), promptId: "p1" },
    { tsMs: T0 + 90_000, name: "api_request", sessionId: SID, promptId: "p1", attrs: { duration_ms: "1000" } },
  ]);
  const whole = await gather({}, current, T0 + 100_000);
  expect(whole.activeMs).toBeGreaterThan(0);
  const windowed = await gather({ since: "1m" }, current, T0 + 100_000);
  expect(windowed.firings).toEqual([]);
  expect(windowed.activeMs).toBeNull();
});

test("counts include the wrapper text Claude Code adds around hook output", () => {
  const content = ["first block", "second block"];
  const rendered = renderedContext("SessionStart", content);
  const d = parseTranscript(attachmentLine({ type: "hook_additional_context", hookName: "SessionStart", hookEvent: "SessionStart", content }, T0, SID, rendered));
  expect(d.blocks.reduce((sum, b) => sum + b.chars, 0)).toBe(rendered.length);
  // Without a recorded rendering the raw text is all there is.
  const raw = parseTranscript(attachmentLine({ type: "hook_additional_context", hookName: "SessionStart", hookEvent: "SessionStart", content }, T0));
  expect(raw.blocks.reduce((sum, b) => sum + b.chars, 0)).toBe(content.join("").length);
});

test("output a hook printed in one prompt is never credited to another prompt's or another tool call's block", () => {
  const d = parseTranscript(
    [
      promptLine("p1", "one", T0),
      hookSuccess("PreToolUse", "old-command", ctxJson("shared"), 5, T0 + 1, "toolu_A"),
      hookContext("PreToolUse", ["other"], T0 + 2, "PreToolUse:Bash", "toolu_A"),
      promptLine("p2", "two", T0 + 10_000),
      hookContext("PreToolUse", ["shared"], T0 + 10_001, "PreToolUse:Read", "toolu_B"),
      hookSuccess("SessionStart", "start-cmd", ctxJson("again"), 5, T0 + 10_002),
      promptLine("p3", "three", T0 + 20_000),
      hookContext("SessionStart", ["again"], T0 + 20_001),
    ].join("\n"),
  );
  expect(d.blocks.map((b) => b.command)).toEqual([null, null, null]);
  // The same tool call still links its run to its block.
  const linked = parseTranscript(
    [promptLine("p1", "one", T0), hookSuccess("PreToolUse", "guard", ctxJson("note"), 5, T0 + 1, "toolu_C"), hookContext("PreToolUse", ["note"], T0 + 2, "PreToolUse:Bash", "toolu_C")].join("\n"),
  );
  expect(linked.blocks.map((b) => b.command)).toEqual(["guard"]);
});

test("a Read that returned only part of the saved file is not a read-back, even with no limit asked", () => {
  const base = [promptLine("p1", "hi", T0), readLine(PERSISTED_PATH, T0 + 2, "t5")];
  const firstPart = parseTranscript([...base, toolResultLine("p1", "t5", false, T0 + 3, { startLine: 1, numLines: 2000, totalLines: 3000 })].join("\n"));
  expect(firstPart.readPaths).toEqual([]);
  const whole = parseTranscript([...base, toolResultLine("p1", "t5", false, T0 + 3, { startLine: 1, numLines: 36, totalLines: 36 })].join("\n"));
  expect(whole.readPaths).toEqual([PERSISTED_PATH]);
});

test("a query killed while its input is still being sent fails cleanly, with no stray pipe error", async () => {
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  const h = await gather({}, current);
  const big = h.blocks[0]!;
  // About 20 MB of input, so the child is killed long before it has read it all.
  h.blocks = Array.from({ length: 10_000 }, (_, i) => ({ ...big, tsMs: i, hash: String(i), preview: "p".repeat(2048) }));
  process.env.CPA_MCP_QUERY_TIMEOUT_MS = "1";
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(runIsolatedQuery(h, "SELECT count(*) FROM blocks")).rejects.toThrow(UserError);
    await Bun.sleep(200);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    delete process.env.CPA_MCP_QUERY_TIMEOUT_MS;
  }
  expect(unhandled).toEqual([]);
}, 20_000);

test("every query answer stays under the output cap, including one with no rows", async () => {
  delete process.env.CPA_MCP_QUERY_TIMEOUT_MS;
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  const h = await gather({}, current);
  const text = await runIsolatedQuery(h, `SELECT 1 AS "${"c".repeat(100_000)}" WHERE 0`);
  expect(text.length).toBeLessThan(70_000);
}, 20_000);

test("notifications never get a reply, whatever the method", async () => {
  const server = createServer({ name: "t", version: "1" }, []);
  expect(await server.handle({ jsonrpc: "2.0", method: "tools/list" })).toBeNull();
  expect(await server.handle({ jsonrpc: "2.0", method: "initialize", params: {} })).toBeNull();
});
