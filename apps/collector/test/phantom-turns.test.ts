import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function record(name: string, tsAgoMs: number, sessionId: string, promptId: string | null, attrs: Record<string, any> = {}) {
  return {
    timeUnixNano: String((Date.now() - tsAgoMs) * 1e6),
    attributes: [
      { key: "event.name", value: s(name) },
      { key: "session.id", value: s(sessionId) },
      ...(promptId ? [{ key: "prompt.id", value: s(promptId) }] : []),
      ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
    ],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
const phantomSession = "phantom-sess";
const phantomPrompt = "p-phantom-turn";
const realSession = "real-sess";
const realPrompt = "p-real-turn";

beforeAll(async () => {
  collector = await startCollector();
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              // Session-start noise that happens to carry a prompt.id, but no user_prompt event:
              // never a real turn, and its session has no api_request/tool_result either.
              record("mcp_server_connection", 10_000, phantomSession, phantomPrompt, { server_name: s("outline"), status: s("connected") }),
              record("mcp_server_connection", 9_000, phantomSession, phantomPrompt, { status: s("disconnected") }),
              record("user_prompt", 8_000, realSession, realPrompt, { command_name: s("real") }),
              record("api_request", 7_000, realSession, realPrompt, { query_source: s("repl_main_thread"), duration_ms: i(300), model: s("m") }),
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

test("/api/turns never lists a promptId with no user_prompt event", async () => {
  const turns = (await (await fetch(`${collector.url}/api/turns?minutes=1440`)).json()) as any[];
  expect(turns.some((t) => t.promptId === phantomPrompt)).toBe(false);
  expect(turns.some((t) => t.promptId === realPrompt)).toBe(true);
});

test("/api/turn for the phantom prompt still answers sensibly (no spans, null session info) rather than throwing", async () => {
  // Reachable only by calling the id directly, since /api/turns no longer lists it.
  const turn = await (await fetch(`${collector.url}/api/turn?prompt=${encodeURIComponent(phantomPrompt)}`)).json();
  expect(turn.spans).toHaveLength(0);
  expect(turn.sessionKind).toBeNull();
  expect(turn.sessionLabel).toBeNull();
});
