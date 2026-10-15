import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function logRecord(name: string, msAgo: number, sessionId: string, promptId: string, attrs: Record<string, any>) {
  return {
    timeUnixNano: String((NOW_MS - msAgo) * 1e6),
    attributes: [
      { key: "event.name", value: s(name) },
      { key: "session.id", value: s(sessionId) },
      { key: "prompt.id", value: s(promptId) },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
    ],
  };
}

function spanRecord(name: string, startAgo: number, endAgo: number, sessionId: string, attrs: Record<string, any>) {
  return {
    traceId: "t1",
    spanId: Math.random().toString(36).slice(2),
    name,
    startTimeUnixNano: String((NOW_MS - startAgo) * 1e6),
    endTimeUnixNano: String((NOW_MS - endAgo) * 1e6),
    attributes: [{ key: "session.id", value: s(sessionId) }, ...Object.entries(attrs).map(([key, value]) => ({ key, value }))],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
const NOW_MS = Date.now();
const sessionId = "lanes-sess";
const promptId = "p-lanes-1";

beforeAll(async () => {
  collector = await startCollector();

  const logs = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              logRecord("user_prompt", 10_000, sessionId, promptId, { command_name: s("test") }),
              logRecord("hook_execution_complete", 9_900, sessionId, promptId, { hook_event: s("UserPromptSubmit"), hook_name: s("UserPromptSubmit"), total_duration_ms: i(5), num_hooks: i(1) }),
              logRecord("api_request", 9_500, sessionId, promptId, { query_source: s("repl_main_thread"), duration_ms: i(300), model: s("claude-sonnet-5") }),
              logRecord("tool_result", 9_000, sessionId, promptId, { tool_name: s("Bash"), duration_ms: i(50), success: s("true") }),
              logRecord("api_request", 7_000, sessionId, promptId, { query_source: s("agent:custom"), "agent.name": s("route-sonnet"), duration_ms: i(400), model: s("claude-haiku-5-5") }),
              logRecord("hook_execution_complete", 6_090, sessionId, promptId, { hook_event: s("PreToolUse"), hook_name: s("PreToolUse:Read"), hook_matcher: s("Read"), total_duration_ms: i(5) }),
              logRecord("tool_result", 6_000, sessionId, promptId, { tool_name: s("Read"), duration_ms: i(80), success: s("true"), tool_use_id: s("tu-sub-1") }),
              logRecord("hook_execution_complete", 5_990, sessionId, promptId, { hook_event: s("PostToolUse"), hook_name: s("PostToolUse:Read"), hook_matcher: s("Read"), total_duration_ms: i(5) }),
              logRecord("api_request", 4_000, sessionId, promptId, { query_source: s("generate_session_title"), duration_ms: i(200), model: s("claude-opus-5-5") }),
            ],
          },
        ],
      },
    ],
  };
  const logsRes = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(logs) });
  if (logsRes.status !== 200) throw new Error(`logs post failed: ${logsRes.status}`);

  const traces = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              spanRecord("claude_code.llm_request", 7_400, 7_000, sessionId, { model: s("claude-haiku-5-5"), agent_id: s("agent-sub-1") }),
              spanRecord("claude_code.tool", 6_080, 6_000, sessionId, { tool_use_id: s("tu-sub-1"), agent_id: s("agent-sub-1") }),
            ],
          },
        ],
      },
    ],
  };
  const tracesRes = await fetch(`${collector.url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(traces) });
  if (tracesRes.status !== 200) throw new Error(`traces post failed: ${tracesRes.status}`);
});
afterAll(() => collector.stop());

test("/api/turn groups rows into main, subagent and background lanes with pretty model labels and attached hooks", async () => {
  const turn = await (await fetch(`${collector.url}/api/turn?prompt=${promptId}`)).json();

  expect(turn.breakdown).toEqual({ apiMs: 900, toolMs: 130, hookMs: 15 });

  expect(turn.lanes.map((l: any) => l.kind)).toEqual(["main", "subagent", "background"]);
  const subagentLane = turn.lanes.find((l: any) => l.kind === "subagent");
  expect(subagentLane).toMatchObject({ id: "agent-sub-1", title: "Subagent · route-sonnet", model: "Haiku 5.5" });
  const backgroundLane = turn.lanes.find((l: any) => l.kind === "background");
  expect(backgroundLane).toMatchObject({ id: "background", title: "Background" });

  const mainRows = turn.rows.filter((r: any) => r.lane === "main");
  expect(mainRows.map((r: any) => [r.kind, r.label])).toEqual([
    ["hooks", "Prompt hooks"],
    ["api", "Sonnet 5"],
    ["tool", "Bash"],
  ]);

  const subagentTool = turn.rows.find((r: any) => r.lane === "agent-sub-1" && r.kind === "tool");
  expect(subagentTool.label).toBe("Read");
  // Nanosecond-string round-tripping through float64 at real epoch magnitudes can be off by a
  // millisecond, so these check proximity rather than an exact delta (see otlp/src/json.ts).
  expect(subagentTool.pre).not.toBeNull();
  expect(Math.abs(subagentTool.pre.endMs - (subagentTool.startMs - 10))).toBeLessThanOrEqual(1);
  expect(subagentTool.post).not.toBeNull();
  expect(Math.abs(subagentTool.post.startMs - (subagentTool.endMs + 5))).toBeLessThanOrEqual(1);
  expect(subagentTool.hookMs).toBe(10);

  const subagentApi = turn.rows.find((r: any) => r.lane === "agent-sub-1" && r.kind === "api");
  expect(subagentApi.label).toBe("Haiku 5.5"); // not a background row, so no query_source suffix

  const backgroundApi = turn.rows.find((r: any) => r.lane === "background");
  expect(backgroundApi.label).toBe("Opus 5.5 · generate session title");
});
