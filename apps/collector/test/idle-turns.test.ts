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

beforeAll(async () => {
  collector = await startCollector();

  // Idle turn: a 10-minute gap between the prompt and the next event, wall clock dwarfs it.
  const idleSession = "idle-turn-sess";
  const idlePrompt = "p-idle-turn";
  // Busy turn: short wall clock, almost entirely covered by a tool call.
  const busySession = "busy-turn-sess";
  const busyPrompt = "p-busy-turn";

  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("user_prompt", 700_000, idleSession, idlePrompt, { command_name: s("idle") }),
              record("api_request", 100_000, idleSession, idlePrompt, { query_source: s("repl_main_thread"), duration_ms: i(500), model: s("m") }),
              record("user_prompt", 50_000, busySession, busyPrompt, { command_name: s("busy") }),
              record("tool_result", 21_000, busySession, busyPrompt, { tool_name: s("Bash"), duration_ms: i(28_000), success: s("true") }),
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

test("/api/turns sort=slowest ranks by activeMs, so a long idle gap does not outrank a busier shorter turn", async () => {
  const turns = (await (await fetch(`${collector.url}/api/turns?minutes=1440&sort=slowest`)).json()) as any[];
  const idle = turns.find((t) => t.promptId === "p-idle-turn")!;
  const busy = turns.find((t) => t.promptId === "p-busy-turn")!;
  expect(idle.wallMs).toBeGreaterThan(busy.wallMs);
  expect(busy.activeMs).toBeGreaterThan(idle.activeMs);
  expect(idle.idleMs).toBeGreaterThan(590_000);

  const iBusy = turns.findIndex((t) => t.promptId === "p-busy-turn");
  const iIdle = turns.findIndex((t) => t.promptId === "p-idle-turn");
  expect(iBusy).toBeLessThan(iIdle);
});

test("/api/turn reports the idle gap and activeMs/idleMs for the idle prompt", async () => {
  const turn = await (await fetch(`${collector.url}/api/turn?prompt=p-idle-turn`)).json();
  expect(turn.gaps).toHaveLength(1);
  expect(turn.idleMs).toBeGreaterThan(590_000);
  expect(turn.activeMs).toBeLessThan(10_000);
});

test("/api/turn reports no gap for the busy prompt, whose tool call covers almost the whole window", async () => {
  const turn = await (await fetch(`${collector.url}/api/turn?prompt=p-busy-turn`)).json();
  expect(turn.gaps).toHaveLength(0);
  expect(turn.idleMs).toBe(0);
});
