import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function record(name: string, tsAgoMs: number, sessionId: string, promptId: string, attrs: Record<string, any>) {
  return {
    timeUnixNano: String((Date.now() - tsAgoMs) * 1e6),
    attributes: [
      { key: "event.name", value: s(name) },
      { key: "session.id", value: s(sessionId) },
      { key: "prompt.id", value: s(promptId) },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
    ],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
const sessionId = "turn-detail-sess";
const promptId = "p-turn-detail-1";

beforeAll(async () => {
  collector = await startCollector();
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("user_prompt", 5000, sessionId, promptId, { command_name: s("test") }),
              record("api_request", 4000, sessionId, promptId, { query_source: s("repl_main_thread"), duration_ms: i(300), model: s("m") }),
              record("tool_result", 3000, sessionId, promptId, { tool_name: s("Bash"), duration_ms: i(50), success: s("true"), tool_parameters: s(JSON.stringify({ command: "echo hi" })) }),
              record("hook_execution_complete", 2000, sessionId, promptId, { hook_name: s("PreToolUse:Bash"), hook_event: s("PreToolUse"), hook_matcher: s("Bash"), total_duration_ms: i(20), num_hooks: i(1) }),
              record("hook_execution_complete", 1000, sessionId, promptId, { hook_name: s("Stop"), hook_event: s("Stop"), num_hooks: i(3), total_duration_ms: i(10) }),
            ],
          },
        ],
      },
    ],
  };
  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`seed post failed: ${res.status}`);
});
afterAll(() => collector.stop());

test("/api/turn carries a rowid and short detail on each span, and session info at the top level", async () => {
  const turn = await (await fetch(`${collector.url}/api/turn?prompt=${encodeURIComponent(promptId)}`)).json();
  expect(turn.promptId).toBe(promptId);
  expect(turn.sessionId).toBe(sessionId);
  expect(turn.sessionKind).toBe("interactive");
  expect(turn.sessionLabel).toStartWith("Interactive");
  expect(turn.repo).toBeNull();

  const tool = turn.spans.find((sp: any) => sp.kind === "tool");
  expect(typeof tool.id).toBe("number");
  expect(tool.detail).toBe("echo hi");

  const hookWithMatcher = turn.spans.find((sp: any) => sp.label === "PreToolUse:Bash");
  expect(hookWithMatcher.detail).toBe("Bash");
  expect(typeof hookWithMatcher.id).toBe("number");

  const hookWithoutMatcher = turn.spans.find((sp: any) => sp.label === "Stop");
  expect(hookWithoutMatcher.detail).toBe("3 hooks");

  const api = turn.spans.find((sp: any) => sp.kind === "api");
  expect(typeof api.id).toBe("number");
});

test("/api/turn returns null for an unknown prompt without throwing", async () => {
  const res = await fetch(`${collector.url}/api/turn?prompt=does-not-exist`);
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
});
