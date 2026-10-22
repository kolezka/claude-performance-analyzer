import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function writePlugin(claudeDir: string, name: string, hook: Record<string, unknown>) {
  const dir = join(claudeDir, "plugin-installs", name);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [hook] }] } }));
  return dir;
}

let collector: Awaited<ReturnType<typeof startCollector>>;

beforeAll(async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "cc-hook-call-claude-"));
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /opt/hindsight-hook.js", timeout: 30 }] }] } }),
  );
  const silDir = writePlugin(claudeDir, "self-improvement-loop", { type: "command", command: "sil hook", timeout: 5 });
  const sgDir = writePlugin(claudeDir, "security-guidance", { type: "command", command: "python3 guard.py" });
  mkdirSync(join(claudeDir, "plugins"), { recursive: true });
  writeFileSync(
    join(claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "self-improvement-loop@m": [{ scope: "user", installPath: silDir, lastUpdated: "2026-10-01T00:00:00Z" }],
        "security-guidance@m": [{ scope: "user", installPath: sgDir, lastUpdated: "2026-10-01T00:00:00Z" }],
      },
    }),
  );
  collector = await startCollector({ CC_CLAUDE_DIR: claudeDir });
});
afterAll(() => collector.stop());

function hookCall(tsAgoMs: number, sessionId: string, count: number, success: number, errors: number, ms: number) {
  return record("hook_execution_complete", tsAgoMs, sessionId, {
    "prompt.id": s(`p-${ms}`),
    hook_event: s("UserPromptSubmit"),
    hook_name: s("UserPromptSubmit"),
    num_hooks: i(count),
    num_success: i(success),
    num_non_blocking_error: i(errors),
    num_blocking: i(0),
    num_cancelled: i(0),
    total_duration_ms: i(ms),
  });
}

test("/api/hook-call: one call with session context, candidate scripts and the narrowing hint", async () => {
  const session = "hook-call-session";
  const reg = (attrs: Record<string, any>) => record("hook_registered", 9000, session, { hook_event: s("UserPromptSubmit"), hook_type: s("command"), ...attrs });
  const logRecords = [
    record("api_request", 8500, session, { query_source: s("sdk"), model: s("claude-sonnet-5"), "service.version": s("2.9.0") }),
    record("user_prompt", 8400, session, { launcher: s("self-improvement-loop") }),
    reg({ hook_source: s("userSettings") }),
    reg({ hook_source: s("pluginHook"), "plugin.name": s("self-improvement-loop") }),
    reg({ hook_source: s("pluginHook"), "plugin.name": s("security-guidance") }),
    hookCall(8000, session, 3, 2, 1, 25_523),
    hookCall(7000, session, 1, 1, 0, 7),
  ];
  const res = await fetch(`${collector.url}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }),
  });
  expect(res.status).toBe(200);

  const item = await (await fetch(`${collector.url}/api/item?kind=hooks&name=UserPromptSubmit&minutes=1440`)).json();
  const slowId = item.recent.find((r: any) => r.ms === 25_523).id;
  const fastId = item.recent.find((r: any) => r.ms === 7).id;

  const slowRes = await fetch(`${collector.url}/api/hook-call?id=${slowId}`);
  expect(slowRes.status).toBe(200);
  const slow = await slowRes.json();
  expect(slow.name).toBe("UserPromptSubmit");
  expect(slow.call).toMatchObject({ id: slowId, ms: 25_523, ok: false, pattern: "2/3 OK · 1 error", launcher: "self-improvement-loop" });
  expect(slow.session).toMatchObject({ sessionId: session, launcher: "self-improvement-loop", claudeVersion: "2.9.0" });
  expect(slow.session.kindLabel).toStartWith("Headless");
  expect(slow.candidates.status).toBe("matched");
  expect(slow.candidates.scripts).toHaveLength(3);
  const user = slow.candidates.scripts.find((d: any) => d.source === "user");
  expect(user.timeoutSec).toBe(30);
  expect(slow.hint).toBe(
    "25.5s is over the 5s timeout of self-improvement-loop, so only security-guidance (no timeout set) or node hindsight-hook.js (30s timeout) could take this long.",
  );

  const fast = await (await fetch(`${collector.url}/api/hook-call?id=${fastId}`)).json();
  expect(fast.candidates.status).toBe("mismatch");
  expect(fast.hint).toBeNull();

  expect((await fetch(`${collector.url}/api/hook-call?id=999999`)).status).toBe(404);
  expect((await fetch(`${collector.url}/api/hook-call?id=abc`)).status).toBe(404);
});

test("/api/hook-call: a row that is not a hook call is a 404", async () => {
  const session = "hook-call-not-hook";
  const res = await fetch(`${collector.url}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [record("tool_result", 1000, session, { tool_name: s("ZzNotAHookTool"), duration_ms: i(5) })] }] }] }),
  });
  expect(res.status).toBe(200);
  const item = await (await fetch(`${collector.url}/api/item?kind=tools&name=ZzNotAHookTool&minutes=1440`)).json();
  expect(item.recent).toHaveLength(1);
  expect((await fetch(`${collector.url}/api/hook-call?id=${item.recent[0].id}`)).status).toBe(404);
});
