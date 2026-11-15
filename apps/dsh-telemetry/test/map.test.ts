import { expect, test } from "bun:test";
import { parseLogs } from "@cpa/otlp";
import { summarize } from "@cpa/analytics";
import { Exporter, otlpLogsBody } from "../src/exporter.js";
import { logsUrl, parseHeaders } from "../src/index.js";
import { SessionMapper } from "../src/map.js";

const T = Date.parse("2026-11-15T12:00:00Z");
const header = { id: "session-abc", cwd: "/repo", agentPreset: "default" };

// One realistic turn in the order DSH writes it.
const turn = [
  { type: "turn/start", seq: 1, time: T, data: { turn: 1 } },
  { type: "step/start", seq: 2, time: T + 10, data: { turn: 1, step: 1 } },
  { type: "user/message", seq: 3, time: T + 11, data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "ctx" }] } },
  { type: "user/message", seq: 4, time: T + 12, data: { source: { kind: "user" }, content: [{ type: "text", text: "secret prompt text" }] } },
  { type: "request/context", seq: 5, time: T + 20, data: { provider: "p", model: "m1", contextWindow: 200000 } },
  {
    type: "assistant/message",
    seq: 6,
    time: T + 1010,
    data: {
      turn: 1,
      step: 1,
      message: { source: { provider: "p", model: "m1" }, content: [{ type: "tool-call" }] },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 1030, cacheReadTokens: 1000, cacheWriteTokens: 0 },
      stream: [
        { type: "chunk", time: T + 310, chunk: { type: "block-start" } },
        { type: "chunk", time: T + 1000, chunk: { type: "finish", reason: { kind: "tool-calls" } } },
      ],
    },
  },
  { type: "tool/call", seq: 7, time: T + 1020, data: { callId: "c1", name: "run_code", arguments: "{}" } },
  { type: "tool/ptc-dispatch-start", seq: 8, time: T + 1030, data: { rootCallId: "c1", subCallId: "s1", name: "bash", arguments: { command: "ls" } } },
  { type: "tool/ptc-dispatch", seq: 9, time: T + 1530, data: { rootCallId: "c1", subCallId: "s1", name: "bash", arguments: { command: "ls" }, isError: false, content: [{ type: "text", text: "a\nb" }] } },
  { type: "tool/ptc-dispatch-start", seq: 10, time: T + 1540, data: { subCallId: "s2", name: "mcp__outline__fetch", arguments: { id: "x" } } },
  { type: "tool/ptc-dispatch", seq: 11, time: T + 1640, data: { subCallId: "s2", name: "mcp__outline__fetch", isError: true, content: [] } },
  { type: "tool/result", seq: 12, time: T + 1700, data: { message: { toolCallId: "c1", content: [{ type: "text", text: "secret tool output" }] } } },
  { type: "subagent/catalog", seq: 13, time: T + 1800, data: { childId: "kid", childCreatedAt: T + 1800, mode: "continuable", label: "Do things" } },
  { type: "user/message", seq: 14, time: T + 5800, data: { source: { kind: "subagent-settled", senderSessionId: "kid" }, content: [] } },
  { type: "llm/retry", seq: 15, time: T + 5900, data: { retry: 1, maxRetries: 5, delayMs: 1000.5, provider: "p", failure: { message: "boom", code: "TIMEOUT" } } },
  { type: "agent/inbox/spliced", seq: 16, time: T + 5950, data: {} },
  { type: "todo/write", seq: 17, time: T + 5960, data: { todos: [{ content: "x" }] } },
  { type: "turn/end", seq: 18, time: T + 6000, data: { turn: 1, reason: { kind: "completed" } } },
];

function mapAll() {
  const m = new SessionMapper(header);
  return { m, records: turn.flatMap((e) => m.map(e)) };
}

test("maps a turn onto the analyzer vocabulary", () => {
  const { records } = mapAll();
  expect(records.map((r) => r.name)).toEqual([
    "user_prompt",
    "dsh.request_context",
    "api_request",
    "tool_result",
    "tool_result",
    "dsh.run_code",
    "dsh.subagent_spawned",
    "subagent_completed",
    "api_error",
    "dsh.todo/write",
    "dsh.turn_end",
  ]);
  const byName = (n: string) => records.filter((r) => r.name === n);
  expect(byName("user_prompt")[0]!.attrs).toMatchObject({ prompt_length: 18, "dsh.prompt_source": "user", "prompt.id": "session-abc:1" });
  expect(byName("api_request")[0]!.attrs).toMatchObject({ model: "m1", duration_ms: 1000, ttft_ms: 300, stop_reason: "tool-calls", cache_read_tokens: 1000, query_source: "repl_main_thread", "event.sequence": 6 });
  const [bash, mcp] = byName("tool_result");
  expect(bash!.attrs).toMatchObject({ tool_name: "bash", success: true, duration_ms: 500, tool_result_size_bytes: 3, "dsh.nested": true });
  expect(mcp!.attrs).toMatchObject({ success: false, duration_ms: 100 });
  expect(JSON.parse(String(mcp!.attrs.tool_parameters))).toMatchObject({ mcp_server_name: "outline", mcp_tool_name: "fetch" });
  expect(byName("subagent_completed")[0]!.attrs).toMatchObject({ agent_type: "continuable", duration_ms: 4000, label: "Do things" });
  expect(byName("api_error")[0]!.attrs).toMatchObject({ status_code: "TIMEOUT", "dsh.delay_ms": 1001 });
  expect(byName("dsh.turn_end")[0]!.attrs).toMatchObject({ duration_ms: 6000, success: true });
});

test("never exports prompt or tool output text", () => {
  const body = JSON.stringify(otlpLogsBody(new Map([["s", { resource: new SessionMapper(header).resource(), records: mapAll().records }]])));
  expect(body).not.toContain("secret prompt text");
  expect(body).not.toContain("secret tool output");
});

test("a subagent that settles twice closes once", () => {
  const { m } = mapAll();
  expect(m.map({ type: "user/message", seq: 99, time: T + 9000, data: { source: { kind: "subagent-settled", senderSessionId: "kid" } } })).toEqual([]);
});

test("a turn with no recognised trigger still gets one prompt row", () => {
  const m = new SessionMapper({ id: "child", origin: "subagent" });
  const names = [
    { type: "turn/start", time: T, data: { turn: 1 } },
    { type: "request/header", time: T + 5, data: {} },
    { type: "assistant/message", time: T + 50, data: { message: { source: { model: "m" } }, usage: {} } },
  ].flatMap((e) => m.map(e));
  expect(names.map((r) => r.name)).toEqual(["user_prompt", "api_request"]);
  expect(names[1]!.attrs.query_source).toBe("subagent");
});

test("collector parses and summarizes mapped output", () => {
  const { m, records } = mapAll();
  const events = parseLogs(otlpLogsBody(new Map([["s", { resource: m.resource(), records }]])));
  expect(events).toHaveLength(records.length);
  expect(events[0]).toMatchObject({ name: "user_prompt", sessionId: "session-abc", promptId: "session-abc:1" });
  const out = summarize(events, [], 3600_000, T + 7000);
  expect(out.kpis).toMatchObject({ sessions: 1, prompts: 1, apiRequests: 1, ttftP50: 300 });
  expect(out.tools.map((t: { name: string }) => t.name).sort()).toEqual(["bash", "mcp: outline/fetch"]);
  expect(out.subagents).toHaveLength(1);
});

test("exporter posts batches and survives a dead collector", async () => {
  const posted: any[] = [];
  const warnings: string[] = [];
  const ok = new Exporter({ url: "http://x/v1/logs", intervalMs: 60_000, fetch: (async (_u: string, init: any) => (posted.push(JSON.parse(init.body)), new Response("{}"))) as any });
  ok.push(new SessionMapper(header).resource(), mapAll().records);
  await ok.shutdown();
  expect(posted[0].resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(11);

  const dead = new Exporter({ url: "http://x/v1/logs", intervalMs: 60_000, warn: (w) => warnings.push(w), fetch: (async () => { throw new Error("ECONNREFUSED"); }) as any });
  dead.push({ "session.id": "s" }, mapAll().records);
  await dead.shutdown();
  expect(warnings).toHaveLength(1);
});

test("config helpers", () => {
  expect(logsUrl("http://h:4318/")).toBe("http://h:4318/v1/logs");
  expect(logsUrl("http://h/v1/logs")).toBe("http://h/v1/logs");
  expect(parseHeaders("Authorization=Bearer%20cpa_x, X-A=b")).toEqual({ Authorization: "Bearer cpa_x", "X-A": "b" });
});
