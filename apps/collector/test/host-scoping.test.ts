import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventRow, SpanRow } from "@cpa/otlp";
import { openStore } from "../src/db";
import { createHandler } from "../src/http";

const PORT = 4318;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Local hook lookups must never read the real ~/.claude.
process.env.CC_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "cc-host-scope-claude-"));

// Three hosts share session "S" and prompt "P". Each host has its own request count, durations,
// model, plugin and subagent id, so any leak shows up as a foreign sentinel in a response.
const HOSTS = [
  { key: "local", n: 1, tool: 1111, hook: 2111, model: "model-local", plugin: "plug-local", agent: "agent-local", headless: false },
  { key: "h1", n: 2, tool: 1222, hook: 2222, model: "model-h1", plugin: "plug-h1", agent: "agent-h1", headless: true },
  { key: "h2", n: 3, tool: 1333, hook: 2333, model: "model-h2", plugin: "plug-h2", agent: "agent-h2", headless: false },
] as const;

function rowsFor(h: (typeof HOSTS)[number], now: number): { events: EventRow[]; spans: SpanRow[] } {
  const events: EventRow[] = [
    { tsMs: now - 9000, name: "hook_registered", sessionId: "S", promptId: null, attrs: { hook_event: "Stop", hook_source: "pluginHook", "plugin.name": h.plugin } },
    { tsMs: now - 8000, name: "user_prompt", sessionId: "S", promptId: "P", attrs: { prompt_length: h.n, launcher: `launcher-${h.key}` } },
  ];
  for (let i = 0; i < h.n; i++) {
    events.push({
      tsMs: now - 7000 + i,
      name: "api_request",
      sessionId: "S",
      promptId: "P",
      attrs: { model: h.model, duration_ms: 500 + i, cost_usd: 0.01, query_source: h.headless ? "sdk" : "repl_main_thread" },
    });
  }
  events.push(
    { tsMs: now - 6000, name: "tool_result", sessionId: "S", promptId: "P", attrs: { tool_name: "Bash", duration_ms: h.tool, tool_use_id: "tu-1", success: "true" } },
    { tsMs: now - 5000, name: "hook_execution_complete", sessionId: "S", promptId: "P", attrs: { hook_event: "Stop", hook_name: "Stop", total_duration_ms: h.hook, num_hooks: 1, num_success: 1 } },
  );
  if (h.key === "h2") events.push({ tsMs: now - 1000, name: "user_prompt", sessionId: "S2", promptId: "P-h2-latest", attrs: {} });
  const spans: SpanRow[] = [
    { traceId: "T", spanId: "X", parentId: null, name: "claude_code.tool", startMs: now - 6010, endMs: now - 6000, sessionId: "S", attrs: { tool_use_id: "tu-1", agent_id: h.agent } },
  ];
  return { events, spans };
}

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-host-scope-")), "t.sqlite"));
  const handler = createHandler({ store, port: PORT, assets: () => new Response(""), rebind: () => {}, publish: () => {}, tailscaleAddress: () => null });
  const ids: Record<string, string> = { local: "local" };
  const now = Date.now();
  for (const h of HOSTS) {
    if (h.key !== "local") ids[h.key] = store.createHost(h.key, `${h.n}`.repeat(64), h.n).id;
    const { events, spans } = rowsFor(h, now);
    store.addEvents(events, ids[h.key]);
    store.addSpans(spans, ids[h.key]);
  }
  const call = async (path: string) => {
    const req = new Request(`${ORIGIN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } });
    return (await handler(req, { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false }))!;
  };
  const get = async (path: string, hostKey: string) => {
    const res = await call(`${path}${path.includes("?") ? "&" : "?"}host=${ids[hostKey]}`);
    expect([path, hostKey, res.status]).toEqual([path, hostKey, 200]);
    return res.json() as Promise<any>;
  };
  return { store, ids, call, get };
}

const sentinels = (h: (typeof HOSTS)[number]) => [String(h.tool), String(h.hook), h.model, h.plugin, h.agent, `launcher-${h.key}`];

function expectOnly(hostKey: string, body: unknown, endpoint: string, needed: (h: (typeof HOSTS)[number]) => string[]) {
  const text = JSON.stringify(body);
  for (const h of HOSTS) {
    for (const s of h.key === hostKey ? needed(h) : sentinels(h)) {
      expect([endpoint, hostKey, s, text.includes(s)]).toEqual([endpoint, hostKey, s, h.key === hostKey]);
    }
  }
}

for (const order of [["local", "h1", "h2"], ["h2", "h1", "local"]] as const) {
  test(`all telemetry reads stay inside the selected host (${order.join(" → ")})`, async () => {
    const { store, ids, call, get } = setup();
    for (const key of order) {
      const h = HOSTS.find((x) => x.key === key)!;

      const summary = await get("/api/summary", key);
      expect(summary.kpis.apiRequests).toBe(h.n);
      expectOnly(key, summary, "summary", (x) => [String(x.tool), String(x.hook), x.model]);

      const status = await get("/api/status", key);
      expect(status.values.requests).toBe(String(h.n));

      const live = await get("/api/live", key);
      expectOnly(key, live, "live", (x) => [String(x.tool), String(x.hook)]);

      const turn = await get("/api/turn?prompt=P", key);
      expect(turn.rows.filter((r: any) => r.kind === "api")).toHaveLength(h.n);
      expectOnly(key, turn, "turn", (x) => [String(x.tool), x.agent]);
      // The latest turn is this host's own latest prompt.
      const latest = await get("/api/turn", key);
      expect(latest.promptId).toBe(key === "h2" ? "P-h2-latest" : "P");

      const turns = await get("/api/turns", key);
      expect(turns.map((t: any) => t.promptId).sort()).toEqual(key === "h2" ? ["P", "P-h2-latest"] : ["P"]);
      expect(turns.find((t: any) => t.promptId === "P").sessionKind).toBe(h.headless ? "headless" : "interactive");
      expectOnly(key, turns, "turns", (x) => [String(x.tool)]);

      const tools = await get("/api/item?kind=tools&name=Bash", key);
      expect(tools.count).toBe(1);
      expect(tools.headlessCount).toBe(h.headless ? 1 : 0);
      expectOnly(key, tools, "item tools", (x) => [String(x.tool)]);
      const visible = await get("/api/item?kind=tools&name=Bash&excludeHeadless=1", key);
      expect(visible.count).toBe(h.headless ? 0 : 1);

      const hooks = await get("/api/item?kind=hooks&name=Stop", key);
      expect(hooks.count).toBe(1);
      expectOnly(key, hooks, "item hooks", (x) => (x.key === "local" ? [String(x.hook)] : [String(x.hook), x.plugin]));
      expect(hooks.patterns).toEqual([expect.objectContaining({ key: "1/1:0:0:0", count: 1, p95: h.hook })]);
      expect(hooks.slowest[0].launcher).toBe(`launcher-${key}`);
      const filtered = await get("/api/item?kind=hooks&name=Stop&pattern=1%2F1%3A0%3A0%3A0", key);
      expect(filtered.count).toBe(1);
      const absentPattern = await get("/api/item?kind=hooks&name=Stop&pattern=0%2F1%3A1%3A0%3A0", key);
      expect(absentPattern.count).toBe(0);
      expect(absentPattern.patterns).toHaveLength(1);
      if (key !== "local") expect(absentPattern.definitions[0].plugin).toBe(h.plugin);

      const hookId = store.events(0, ids[key]).find((e) => e.name === "hook_execution_complete")!.id!;
      const hookCall = await get(`/api/hook-call?id=${hookId}`, key);
      expect(hookCall.call).toMatchObject({ ms: h.hook, pattern: "1/1 OK", launcher: `launcher-${key}` });
      expect(hookCall.session.launcher).toBe(`launcher-${key}`);
      expectOnly(key, hookCall, "hook call", (x) => [String(x.hook), `launcher-${x.key}`]);
      if (key !== "local") {
        expect(hookCall.candidates.status).toBe("remote");
        expect(hookCall.candidates.scripts).toEqual([expect.objectContaining({ plugin: h.plugin, command: null, configPath: null, timeoutSec: null })]);
        expect(hookCall.hint).toBeNull();
      }
      for (const other of HOSTS.filter((x) => x.key !== key)) {
        const foreignHook = store.events(0, ids[other.key]).find((e) => e.name === "hook_execution_complete")!.id!;
        expect((await call(`/api/hook-call?id=${foreignHook}&host=${ids[key]}`)).status).toBe(404);
      }

      const own = store.events(0, ids[key]).find((e) => e.name === "tool_result")!.id!;
      const event = await get(`/api/event?id=${own}`, key);
      expect(event.details).toBeDefined();
      expectOnly(key, event, "event", (x) => [String(x.tool), x.model]);
      for (const other of HOSTS.filter((x) => x.key !== key)) {
        const foreign = store.events(0, ids[other.key]).find((e) => e.name === "tool_result")!.id!;
        const res = await call(`/api/event?id=${foreign}&host=${ids[key]}`);
        expect([key, other.key, res.status]).toEqual([key, other.key, 404]);
      }
    }
  });
}

test("an unknown host is 404 on every read endpoint", async () => {
  const { call } = setup();
  for (const path of ["/api/summary", "/api/status", "/api/live", "/api/turn", "/api/turns", "/api/event?id=1", "/api/item?kind=tools&name=Bash", "/api/hook-call?id=1"]) {
    const res = await call(`${path}${path.includes("?") ? "&" : "?"}host=missing`);
    expect([path, res.status]).toEqual([path, 404]);
  }
});
