import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { freePort, otlpJson } from "./server";

const SIGNALS = ["logs", "traces", "metrics"] as const;
type Signal = (typeof SIGNALS)[number];
const TABLE = { logs: "events", traces: "spans", metrics: "metrics" } as const;

function start(port: number, dir: string, wait: boolean) {
  const binary = process.env.CPA_TEST_COLLECTOR_BIN;
  return Bun.spawn(binary ? [binary] : ["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env, PORT: String(port), CC_TELEMETRY_DIR: dir,
      CC_SETTINGS_PATH: join(dir, "settings.json"), CC_CLAUDE_DIR: join(dir, "claude"),
      NODE_ENV: "production", CC_WAIT_FOR_PORT: wait ? "1" : "",
    },
    stdout: "ignore", stderr: "pipe",
  });
}

async function waitForWaiting(proc: ReturnType<typeof start>) {
  const reader = proc.stderr.getReader();
  const timeout = setTimeout(() => proc.kill(), 10_000);
  let output = "";
  try {
    while (!output.includes("Waiting for it.")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`collector did not wait for ownership: ${output}`);
      output += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function waitForHosts(url: string, proc: ReturnType<typeof start>) {
  for (let n = 0; n < 100; n++) {
    if (proc.exitCode !== null) throw new Error(`collector exited ${proc.exitCode}`);
    try {
      const response = await fetch(`${url}/api/hosts`);
      if (response.ok) {
        const hosts = await response.json();
        if (Array.isArray(hosts) && hosts[0]?.id === "local") return hosts as { id: string; name: string }[];
      }
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("new collector did not acquire ownership");
}

// Schema-v0 writers omit column lists. Keep those prepared statements alive while the new
// process waits, so an early ALTER TABLE or prune is observable through the old owner's API.
function legacyStore(path: string) {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE events (ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, prompt_id TEXT, attrs TEXT NOT NULL)");
  db.run("CREATE TABLE spans (trace_id TEXT, span_id TEXT, parent_id TEXT, name TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_id TEXT, attrs TEXT NOT NULL)");
  db.run("CREATE TABLE metrics (ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, value REAL NOT NULL, attrs TEXT NOT NULL)");
  const event = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)");
  const span = db.prepare("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const metric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, ?)");
  const write = (signal: Signal, marker: string, time = Date.now()) => {
    const attrs = JSON.stringify({ marker, tool_name: "Bash", duration_ms: 7 });
    if (signal === "logs") event.run(time, "tool_result", marker, "p", attrs);
    else if (signal === "traces") span.run("trace", "span", null, "legacy-span", time, time + 7, marker, attrs);
    else metric.run(time, "legacy.metric", marker, 7, attrs);
    return JSON.parse((db.query(`SELECT attrs FROM ${TABLE[signal]} WHERE session_id = ?`).get(marker) as { attrs: string }).attrs).marker;
  };
  return { db, write };
}

for (const wait of [true, false]) {
  test(`occupied-port startup leaves the legacy writer and data unchanged (wait=${wait})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-startup-owner-"));
    const old = legacyStore(join(dir, "telemetry.sqlite"));
    old.write("logs", "expired-but-owned", Date.now() - 20 * 24 * 3600_000);
    const holder = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        if (req.method !== "POST") return new Response("legacy-owner");
        const { signal, marker } = await req.json() as { signal: Signal; marker: string };
        try { return Response.json({ marker: old.write(signal, marker) }); }
        catch (error) { return new Response(String(error), { status: 400 }); }
      },
    });
    const url = `http://127.0.0.1:${holder.port}`;
    const write = async (signal: Signal, marker: string) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal, marker }) });
      const body = await response.text();
      expect([signal, response.status, body]).toEqual([signal, 200, JSON.stringify({ marker })]);
    };
    for (const signal of SIGNALS) await write(signal, `before-${signal}`);
    const proc = start(holder.port!, dir, wait);
    try {
      if (wait) {
        await waitForWaiting(proc);
        expect(proc.exitCode).toBeNull();
      } else {
        const timeout = setTimeout(() => proc.kill(), 10_000);
        try {
          const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
          expect(code).not.toBe(0);
          expect(stderr).toContain("EADDRINUSE");
        } finally { clearTimeout(timeout); }
      }
      expect(await (await fetch(url)).text()).toBe("legacy-owner");
      for (const signal of SIGNALS) await write(signal, `during-${signal}`);
      expect(old.db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(old.db.query("SELECT session_id FROM events WHERE session_id = 'expired-but-owned'").get()).toEqual({ session_id: "expired-but-owned" });
      for (const table of Object.values(TABLE)) {
        expect((old.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "host_id")).toBe(false);
      }
      if (wait) {
        await holder.stop(true);
        await waitForHosts(url, proc);
        expect(old.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(old.db.query("SELECT session_id FROM events WHERE session_id = 'expired-but-owned'").get()).toBeNull();
        for (const signal of SIGNALS) {
          const marker = `new-${signal}`;
          const response = await fetch(`${url}/v1/${signal}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(otlpJson(signal, marker, marker)) });
          expect(response.status).toBe(200);
          const row = old.db.query(`SELECT host_id, attrs FROM ${TABLE[signal]} WHERE session_id = ?`).get(marker) as { host_id: string; attrs: string };
          expect([row.host_id, JSON.parse(row.attrs).marker]).toEqual(["local", marker]);
        }
        const live = await (await fetch(`${url}/api/live`)).json();
        expect(live).toContainEqual(expect.objectContaining({ sessionId: "new-logs", ms: 7 }));
      }
    } finally {
      proc.kill();
      await proc.exited;
      await holder.stop(true);
      old.db.close();
    }
  }, 25_000);
}

test("startup restores the persisted remote listener after claiming the port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-startup-remote-"));
  const store = openStore(join(dir, "telemetry.sqlite"));
  const host = store.createHost("persisted remote", "0".repeat(64), Date.now());
  store.db.close();
  const port = freePort();
  const proc = start(port, dir, false);
  try {
    const hosts = await waitForHosts(`http://127.0.0.1:${port}`, proc);
    expect(hosts.map((h) => h.id)).toEqual(["local", host.id]);
    const ipv6 = await fetch(`http://[::1]:${port}/api/hosts`);
    expect(ipv6.status).toBe(200);
    expect((await ipv6.json()).map((h: { id: string }) => h.id)).toEqual(["local", host.id]);
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 15_000);
