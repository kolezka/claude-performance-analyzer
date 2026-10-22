import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCollector } from "./server";

let collector: Awaited<ReturnType<typeof startCollector>>;
let routes: string[];

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
                  { key: "event.name", value: { stringValue: "tool_result" } },
                  { key: "tool_name", value: { stringValue: "Bash" } },
                  { key: "duration_ms", value: { intValue: "5" } },
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
  const live = (await (await fetch(`${collector.url}/api/live`)).json()) as { id: number }[];
  const id = live[0]!.id;
  routes = ["/api/summary", "/api/status", "/api/live", "/api/turn", `/api/event?id=${id}`, "/api/item?kind=tools&name=Bash", "/api/setup", "/api/turns", "/api/hosts", "/"];
});
afterAll(() => collector.stop());

test("GET /api/* rejects a spoofed Host header (DNS rebinding)", async () => {
  for (const route of routes) {
    const res = await fetch(`${collector.url}${route}`, { headers: { host: "evil.example" } });
    expect([route, res.status]).toEqual([route, 403]);
  }
});

test("GET /api/* still works with the real Host header", async () => {
  for (const route of routes) {
    const res = await fetch(`${collector.url}${route}`);
    expect([route, res.status]).toEqual([route, 200]);
  }
});

test("the bracketed IPv6 loopback Host is our own too", async () => {
  for (const route of routes) {
    const res = await fetch(`${collector.url}${route}`, { headers: { host: `[::1]:${collector.port}` } });
    expect([route, res.status]).toEqual([route, 200]);
  }
});

test("the dashboard and its generated assets are served through the gate", async () => {
  const res = await fetch(`${collector.url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(assets.length).toBeGreaterThanOrEqual(1);
  for (const asset of assets) {
    const a = await fetch(`${collector.url}${asset}`);
    expect([asset, a.status]).toEqual([asset, 200]);
    expect(a.headers.get("content-type") ?? "").toMatch(/javascript|css/);
    expect((await fetch(`${collector.url}${asset}`, { headers: { host: "evil.example" } })).status).toBe(403);
  }
});
