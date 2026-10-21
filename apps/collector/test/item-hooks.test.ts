import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function record(name: string, tsAgoMs: number, sessionId: string, attrs: Record<string, any>) {
  return {
    timeUnixNano: String((Date.now() - tsAgoMs) * 1e6),
    attributes: [{ key: "event.name", value: s(name) }, { key: "session.id", value: s(sessionId) }, ...Object.entries(attrs).map(([key, value]) => ({ key, value }))],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
let claudeDir: string;

beforeAll(async () => {
  claudeDir = mkdtempSync(join(tmpdir(), "cc-item-hooks-claude-"));
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /opt/log.js" }] }] } }),
  );
  collector = await startCollector({ CC_CLAUDE_DIR: claudeDir });
});
afterAll(() => collector.stop());

test("/api/item: excludeHeadless, the no-repo bucket split by session kind, and the hooks fields", async () => {
  const interactive = "item-hooks-interactive";
  const headless = "item-hooks-headless";

  const hookInteractive = record("hook_execution_complete", 4000, interactive, {
    "prompt.id": s("p-int-1"),
    hook_event: s("PreToolUse"),
    hook_name: s("PreToolUse:Bash"),
    hook_matcher: s("Bash"),
    num_hooks: i(1),
    num_success: i(1),
    num_non_blocking_error: i(0),
    num_blocking: i(0),
    num_cancelled: i(0),
    stdout_chars: i(12),
    additional_context_chars: i(5),
    system_message_chars: i(3),
    total_duration_ms: i(120),
  });
  const hookHeadless = record("hook_execution_complete", 3000, headless, {
    "prompt.id": s("p-head-1"),
    hook_event: s("PreToolUse"),
    hook_name: s("PreToolUse:Bash"),
    hook_matcher: s("Bash"),
    num_hooks: i(1),
    num_success: i(0),
    num_non_blocking_error: i(1),
    num_blocking: i(0),
    num_cancelled: i(0),
    stdout_chars: i(0),
    additional_context_chars: i(0),
    system_message_chars: i(0),
    total_duration_ms: i(80),
  });
  const registered = record("hook_registered", 6000, interactive, { hook_event: s("PreToolUse"), hook_type: s("command"), hook_source: s("userSettings") });

  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("api_request", 5000, interactive, { query_source: s("repl_main_thread"), model: s("claude-sonnet-5") }),
              record("api_request", 5000, headless, { query_source: s("sdk"), model: s("claude-sonnet-5") }),
              hookInteractive,
              hookHeadless,
              registered,
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const full = await (await fetch(`${collector.url}/api/item?kind=hooks&name=${encodeURIComponent("PreToolUse:Bash")}&minutes=1440`)).json();
  expect(full.headlessCount).toBe(1);
  expect(full.count).toBe(2);

  const interactiveBucket = full.repos.find((r: any) => r.label === "No repo · interactive sessions");
  const headlessBucket = full.repos.find((r: any) => r.label === "No repo · headless SDK sessions");
  expect(interactiveBucket?.count).toBe(1);
  expect(headlessBucket?.count).toBe(1);

  const recentInteractive = full.recent.find((r: any) => r.sessionId === interactive);
  expect(recentInteractive).toMatchObject({ promptId: "p-int-1", sessionKind: "interactive" });
  expect(recentInteractive.sessionLabel).toStartWith("Interactive");
  expect(recentInteractive.hooks).toMatchObject({ hookEvent: "PreToolUse", matcher: "Bash", count: 1, success: 1, errors: 0, blocking: 0, cancelled: 0, stdoutChars: 12, contextChars: 8 });

  expect(full.failed).toHaveLength(1);
  expect(full.failed[0]!.sessionId).toBe(headless);

  const userDef = full.definitions.find((d: any) => d.source === "user");
  expect(userDef).toMatchObject({ plugin: null, matcher: "Bash", command: "node /opt/log.js", summary: "node log.js", sessions: 1 });
  expect(userDef.configPath).toContain("settings.json");

  const filtered = await (await fetch(`${collector.url}/api/item?kind=hooks&name=${encodeURIComponent("PreToolUse:Bash")}&minutes=1440&excludeHeadless=1`)).json();
  expect(filtered.headlessCount).toBe(1); // still computed before the filter
  expect(filtered.count).toBe(1);
  expect(filtered.repos).toHaveLength(1);
  expect(filtered.repos[0]!.label).toBe("No repo · interactive sessions");
  expect(filtered.failed).toHaveLength(0);
});

function promptHook(tsAgoMs: number, sessionId: string, ms: number, success: number, errors: number) {
  return record("hook_execution_complete", tsAgoMs, sessionId, {
    hook_event: s("UserPromptSubmit"),
    hook_name: s("UserPromptSubmit"),
    num_hooks: i(3),
    num_success: i(success),
    num_non_blocking_error: i(errors),
    num_blocking: i(0),
    num_cancelled: i(0),
    total_duration_ms: i(ms),
  });
}

test("/api/item hooks: patterns, finding line, slowest, launcher, hidden-by-headless and the pattern filter", async () => {
  const interactive = "drill-interactive";
  const headlessA = "drill-headless-a";
  const headlessB = "drill-headless-b";
  const logRecords = [
    record("api_request", 9000, interactive, { query_source: s("repl_main_thread"), model: s("claude-sonnet-5") }),
    record("api_request", 9000, headlessA, { query_source: s("sdk"), model: s("claude-sonnet-5") }),
    record("api_request", 9000, headlessB, { query_source: s("sdk"), model: s("claude-sonnet-5") }),
    record("user_prompt", 8500, headlessA, { launcher: s("self-improvement-loop") }),
    record("user_prompt", 8500, headlessB, { launcher: s("self-improvement-loop") }),
    promptHook(8000, interactive, 300, 3, 0),
    promptHook(7000, interactive, 400, 3, 0),
    promptHook(6000, interactive, 900, 3, 0),
    promptHook(5000, headlessA, 250, 2, 1),
    promptHook(4000, headlessB, 280, 2, 1),
  ];
  const res = await fetch(`${collector.url}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }),
  });
  expect(res.status).toBe(200);

  const base = `${collector.url}/api/item?kind=hooks&name=UserPromptSubmit&minutes=1440`;
  const body = await (await fetch(base)).json();
  expect(body.patterns.map((p: any) => p.label)).toEqual(["3/3 OK", "2/3 OK · 1 error"]);
  expect(body.finding).toBe("2 calls reported errors, all headless, launched by self-improvement-loop. Failing script not reported.");
  expect(body.slowest[0].ms).toBe(900);
  expect(body.slowest).toHaveLength(5);
  expect(body.failed).toHaveLength(2);
  expect(body.failed.every((f: any) => f.launcher === "self-improvement-loop")).toBe(true);
  expect(body.failed[0].pattern).toBe("2/3 OK · 1 error");
  expect(body.hiddenByHeadless).toBeNull();

  const hidden = await (await fetch(`${base}&excludeHeadless=1`)).json();
  expect(hidden.hiddenByHeadless).toEqual({ calls: 2, errors: 2 });
  expect(hidden.finding).toBeNull();
  expect(hidden.patterns.map((p: any) => p.label)).toEqual(["3/3 OK"]);

  const failingKey = body.patterns.find((p: any) => p.errors > 0).key;
  const filtered = await (await fetch(`${base}&pattern=${encodeURIComponent(failingKey)}`)).json();
  expect(filtered.count).toBe(2);
  // Patterns and finding still describe the whole (headless-filtered) set, not the pattern slice.
  expect(filtered.patterns).toHaveLength(2);

  // Other kinds do not get the hook-only fields.
  const tools = await (await fetch(`${collector.url}/api/item?kind=tools&name=Bash&minutes=1440`)).json();
  expect(tools.patterns).toBeUndefined();
  expect(tools.slowest).toBeUndefined();
});
