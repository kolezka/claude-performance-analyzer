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

  // Fast turn: started recently, short wall clock, last event 2.5s ago (looks in progress).
  const fastSession = "turns-fast";
  const fastPrompt = "p-turns-fast";
  // Slow turn: started long ago, long wall clock, last event 20s ago (not in progress).
  const slowSession = "turns-slow";
  const slowPrompt = "p-turns-slow";

  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("user_prompt", 3000, fastSession, fastPrompt, { command_name: s("fast") }),
              record("api_request", 2500, fastSession, fastPrompt, { query_source: s("repl_main_thread"), duration_ms: i(400), model: s("m") }),
              record("user_prompt", 60_000, slowSession, slowPrompt, { command_name: s("slow") }),
              record("api_request", 20_000, slowSession, slowPrompt, { query_source: s("sdk"), duration_ms: i(400), model: s("m") }),
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

async function turns(qs: string) {
  return (await (await fetch(`${collector.url}/api/turns?${qs}`)).json()) as any[];
}

test("/api/turns sorts by startMs (recent) or wallMs (slowest), and reports inProgress", async () => {
  const recent = await turns("minutes=1440&sort=recent");
  const iFast = recent.findIndex((t) => t.promptId === "p-turns-fast");
  const iSlow = recent.findIndex((t) => t.promptId === "p-turns-slow");
  expect(iFast).toBeGreaterThanOrEqual(0);
  expect(iSlow).toBeGreaterThanOrEqual(0);
  expect(iFast).toBeLessThan(iSlow);

  const slowest = await turns("minutes=1440&sort=slowest");
  const jFast = slowest.findIndex((t) => t.promptId === "p-turns-fast");
  const jSlow = slowest.findIndex((t) => t.promptId === "p-turns-slow");
  expect(jSlow).toBeLessThan(jFast);

  const fastTurn = recent.find((t) => t.promptId === "p-turns-fast")!;
  const slowTurn = recent.find((t) => t.promptId === "p-turns-slow")!;
  expect(fastTurn.inProgress).toBe(true);
  expect(slowTurn.inProgress).toBe(false);
  expect(fastTurn.sessionKind).toBe("interactive");
  expect(slowTurn.sessionKind).toBe("headless");
  expect(fastTurn.command).toBe("fast");
  expect(slowTurn.wallMs).toBeGreaterThan(fastTurn.wallMs);
});

test("/api/turns excludeHeadless drops headless sessions' turns", async () => {
  const filtered = await turns("minutes=1440&sort=recent&excludeHeadless=1");
  expect(filtered.some((t) => t.promptId === "p-turns-slow")).toBe(false);
  expect(filtered.some((t) => t.promptId === "p-turns-fast")).toBe(true);
});

test("/api/turns clamps limit to [1, 50]", async () => {
  const many = await turns("minutes=1440&limit=999");
  expect(many.length).toBeLessThanOrEqual(50);
  const one = await turns("minutes=1440&limit=1");
  expect(one).toHaveLength(1);
});
