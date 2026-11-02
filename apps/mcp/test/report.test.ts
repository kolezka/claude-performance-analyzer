import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { gather } from "../src/gather";
import { charsTok, hookTimeReport, injectionReport, memoryReport, summaryReport } from "../src/report";
import { parseTranscript } from "../src/transcript";
import { hookFiring, SESSION_START_CMD, SID, sessionTranscript, T0, tempEnv, writeTelemetry, writeTranscript, writeUserSettingsHook, type TempEnv } from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
});
afterEach(() => env.restore());

const current = { CLAUDE_CODE_SESSION_ID: SID };

function withTelemetry() {
  writeUserSettingsHook(env, "SessionStart", SESSION_START_CMD);
  writeTelemetry(env, [
    { tsMs: T0, name: "hook_registered", sessionId: SID, promptId: null, attrs: { hook_event: "SessionStart", hook_source: "userSettings" } },
    hookFiring(SID, T0 + 100, "SessionStart:startup", "SessionStart", 1300, { additional_context_chars: "80" }),
    hookFiring(SID, T0 + 1_100, "UserPromptSubmit", "UserPromptSubmit", 900),
    hookFiring(SID, T0 + 60_100, "UserPromptSubmit", "UserPromptSubmit", 700),
  ]);
}

const blocks = () => parseTranscript(sessionTranscript()).blocks;
const sum = (list: { chars: number }[]) => list.reduce((a, b) => a + b.chars, 0);

test("summary totals injected text, repeats and the Hindsight share", async () => {
  withTelemetry();
  const text = summaryReport(await gather({}, current));
  const all = blocks();
  const mem = all.filter((b) => b.family === "hindsight");
  expect(text).toContain(`Injected by hooks: ${charsTok(sum(all))} in 6 blocks.`);
  // The second refresh is identical to the first one.
  expect(text).toContain(`identical repeats: ${charsTok(all[5]!.chars)}`);
  expect(text).toContain(`Hindsight memory: ${charsTok(sum(mem))}`);
  expect(text).toContain("1 recall too large for context, 1 read back by the agent");
  expect(text).toContain("Hook time: 2.9s wall time in 3 firings");
  // The cut-short hook line is called out, not silently dropped.
  expect(text).toContain("Skipped 1 unreadable hook line in the transcripts; not counted.");
});

test("a block with a matched command names its owner; others list the event's configured hooks", async () => {
  withTelemetry();
  const text = injectionReport(await gather({}, current), "source", 10);
  const settings = join(env.claudeDir, "settings.json");
  expect(text).toContain(`owner: node claude-sessionstart-hook.js, user settings (${settings})`);
  expect(text).toContain("owner: unattributed; SessionStart hooks configured: node claude-sessionstart-hook.js (user settings)");
  expect(text).toContain("Telemetry's own count for the same hooks: 80 chars");
});

test("every group_by produces rows that add up to the same total", async () => {
  const h = await gather({}, current);
  const total = sum(blocks());
  for (const g of ["source", "event", "prompt", "session", "project"] as const) {
    const text = injectionReport(h, g, 50);
    expect(text).toContain(`Injected by hooks: ${charsTok(total)}`);
    expect(text).toContain("1. ");
  }
  expect(injectionReport(h, "prompt", 50)).toContain("session start");
  expect(injectionReport(h, "project", 50)).toContain("1. demo:");
});

test("memory report splits tags, per prompt cost and read-back of persisted recall", async () => {
  const text = memoryReport(await gather({}, current));
  expect(text).toContain("- <hindsight_knowledge_refresh>:");
  expect(text).toContain("1 identical repeat");
  expect(text).toContain("- <hindsight_memory>:");
  expect(text).toContain("full size 12.8KB");
  expect(text).toContain("read the full file back for 1 of them");
});

test("hook time without telemetry says unavailable and still lists transcript command runs", async () => {
  const text = hookTimeReport(await gather({}, current), 10);
  expect(text).toContain("Hook time from telemetry: unavailable, no telemetry database");
  expect(text).toContain(`- SessionStart: ${SESSION_START_CMD} | 1 run, total 1.2s`);
});

test("hook time with telemetry ranks hooks by total and shows per-prompt time", async () => {
  withTelemetry();
  const text = hookTimeReport(await gather({}, current), 10);
  expect(text).toContain("UserPromptSubmit | 2 | 1.6s | 700ms | 900ms | 900ms | 0 | 0");
  expect(text.indexOf("UserPromptSubmit |")).toBeLessThan(text.indexOf("SessionStart:startup |"));
  expect(text).toContain("Per prompt: 1.4s on average.");
});
