import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

let collector: Awaited<ReturnType<typeof startCollector>>;

beforeAll(async () => {
  collector = await startCollector();
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1e6),
                attributes: [
                  { key: "event.name", value: s("tool_result") },
                  { key: "session.id", value: s("validation-sess") },
                  { key: "tool_name", value: s("Bash") },
                  { key: "duration_ms", value: i(5) },
                  { key: "success", value: s("true") },
                ],
              },
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

test("kind must be an own property of the event-name map, not inherited from Object.prototype", async () => {
  const res = await fetch(`${collector.url}/api/item?kind=toString&name=x`);
  expect(res.status).toBe(400);
});

test("a non-finite minutes value falls back to the default window instead of an empty query", async () => {
  const res = await fetch(`${collector.url}/api/item?kind=tools&name=Bash&minutes=12abc`);
  expect(res.status).toBe(200);
  const item = await res.json();
  expect(item.count).toBeGreaterThanOrEqual(1);
});
