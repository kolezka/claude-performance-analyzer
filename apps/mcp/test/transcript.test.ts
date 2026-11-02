import { expect, test } from "bun:test";
import { contextFromStdout, parseTranscript, signatureOf, unwrapPersisted } from "../src/transcript";
import {
  CWD,
  modeLine,
  PERSISTED_PATH,
  persistedBlock,
  promptLine,
  readLine,
  REFRESH,
  RULES,
  SESSION_START_CMD,
  SID,
  sessionTranscript,
  T0,
  toolResultLine,
} from "./fixtures";

test("parses injected blocks, hook runs, prompts and read-backs from a transcript", () => {
  const d = parseTranscript(sessionTranscript());
  expect(d.sessionId).toBe(SID);
  expect(d.cwd).toBe(CWD);
  expect(d.gitBranch).toBe("main");
  expect(d.prompts).toEqual([
    { id: "p1", tsMs: T0 + 1_000 },
    { id: "p2", tsMs: T0 + 60_000 },
  ]);
  expect(d.runs).toHaveLength(1);
  expect(d.runs[0]).toMatchObject({ hookEvent: "SessionStart", command: SESSION_START_CMD, durationMs: 1200, exitCode: 0, promptId: null });
  expect(d.readPaths).toEqual([PERSISTED_PATH]);
  expect(d.badLines).toBe(1);

  const summary = d.blocks.map((b) => [b.hookEvent, b.kind, b.promptId, b.tag, b.family, b.command]);
  expect(summary).toEqual([
    ["SessionStart", "context", null, "hindsight_knowledge", "hindsight", SESSION_START_CMD],
    ["SessionStart", "context", null, null, null, null],
    ["UserPromptSubmit", "context", "p1", "hindsight_memory", "hindsight", null],
    ["UserPromptSubmit", "context", "p1", "hindsight_knowledge_refresh", "hindsight", null],
    ["Stop", "blocking_error", "p1", null, null, "sh stop-guard.sh"],
    ["UserPromptSubmit", "context", "p2", "hindsight_knowledge_refresh", "hindsight", null],
  ]);
  expect(d.blocks[1]!.signature).toBe("Promoted rules for world default:");
  expect(d.blocks[1]!.chars).toBe(RULES.length);
  // Identical text gets the same hash, so repeats can be spotted.
  expect(d.blocks[3]!.hash).toBe(d.blocks[5]!.hash);
  expect(d.blocks[3]!.chars).toBe(REFRESH.length);
});

test("persisted output counts as the preview the model saw, not the full file", () => {
  const block = persistedBlock("12.8KB", PERSISTED_PATH, "<hindsight_memory>\nfact\n</hindsight_memory>");
  const d = parseTranscript(sessionTranscript());
  const recall = d.blocks.find((b) => b.tag === "hindsight_memory")!;
  expect(recall.chars).toBe(block.replace("fact", "recalled fact").length);
  expect(recall.persisted).toEqual({ reportedSize: "12.8KB", path: PERSISTED_PATH, readBack: false });
  expect(recall.preview.startsWith("[persisted 12.8KB] <hindsight_memory>")).toBe(true);
});

test("assistant lines put message before type, and a Read of saved hook output is still seen", () => {
  const line = readLine(PERSISTED_PATH, T0);
  expect(line.indexOf('"message"')).toBeLessThan(line.indexOf('"type":"assistant"'));
  expect(parseTranscript([line, toolResultLine("p1", "t1", false, T0 + 1)].join("\n")).readPaths).toEqual([PERSISTED_PATH]);
});

test("first and last times skip bookkeeping lines that carry no timestamp", () => {
  const d = parseTranscript([modeLine(), modeLine(), promptLine("p1", "hi", T0 + 5), promptLine("p2", "yo", T0 + 9), modeLine(), ""].join("\n"));
  expect(d.firstMs).toBe(T0 + 5);
  expect(d.lastMs).toBe(T0 + 9);
});

test("a block matches the command whose stdout printed it; one that no run printed stays unattributed", () => {
  const d = parseTranscript(sessionTranscript());
  const start = d.blocks.filter((b) => b.hookEvent === "SessionStart");
  expect(start.map((b) => b.command)).toEqual([SESSION_START_CMD, null]);
});

test("contextFromStdout reads JSON additionalContext, or plain stdout only where Claude Code adds it", () => {
  const json = JSON.stringify({ hookSpecificOutput: { additionalContext: "ctx" } });
  expect(contextFromStdout("PreToolUse", json)).toBe("ctx");
  expect(contextFromStdout("UserPromptSubmit", "plain text\n")).toBe("plain text");
  expect(contextFromStdout("SessionStart", "plain")).toBe("plain");
  expect(contextFromStdout("PreToolUse", "plain")).toBeNull();
  expect(contextFromStdout("SessionStart", "{broken")).toBeNull();
  expect(contextFromStdout("SessionStart", "   ")).toBeNull();
  expect(contextFromStdout("SessionStart", JSON.stringify({ systemMessage: "only for the user" }))).toBeNull();
});

test("unwrapPersisted splits header facts from the preview body", () => {
  expect(unwrapPersisted("plain text")).toBeNull();
  const u = unwrapPersisted(persistedBlock("3KB", "/x/hook-1.txt", "<tag>\nbody\n</tag>"))!;
  expect(u.persisted).toEqual({ reportedSize: "3KB", path: "/x/hook-1.txt", readBack: false });
  expect(u.body).toBe("<tag>\nbody\n</tag>");
});

test("signatureOf groups by leading tag, else by first line with numbers masked", () => {
  expect(signatureOf("<hindsight_knowledge_refresh>\n98 pages", "hindsight_knowledge_refresh")).toBe("<hindsight_knowledge_refresh>");
  expect(signatureOf("  98 knowledge pages\nmore", null)).toBe("# knowledge pages");
  expect(signatureOf("x".repeat(100), null)).toHaveLength(60);
});
