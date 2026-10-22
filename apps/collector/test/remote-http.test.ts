import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestType } from "@cpa/otlp";
import { proxyAssets, startDashboardServer } from "../src/assets";
import { openStore } from "../src/db";
import { createHandler, type PeerServer } from "../src/http";
import { ListenerError } from "../src/listener";
import { otlpJson, otlpProtobuf } from "./server";

const PORT = 4318;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TAILNET = "100.88.1.2";
const SIGNALS = ["logs", "traces", "metrics"] as const;
const TABLE = { logs: "events", traces: "spans", metrics: "metrics" } as const;

interface CallOptions {
  peer?: string | null;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

function harness(options: { assets?: (req: Request) => Response | Promise<Response>; rebind?: (remote: boolean) => void; settings?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-remote-http-"));
  const store = openStore(join(dir, "t.sqlite"));
  const rebinds: boolean[] = [];
  const published: any[] = [];
  let offsetMs = 0;
  const handler = createHandler({
    store,
    port: PORT,
    assets: options.assets ?? ((req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { "content-type": "text/plain" } })),
    rebind: (remote) => {
      options.rebind?.(remote);
      rebinds.push(remote);
    },
    publish: (m) => published.push(JSON.parse(m)),
    now: () => Date.now() + offsetMs,
    tailscaleAddress: () => "100.101.102.103",
  });
  async function call(path: string, o: CallOptions = {}) {
    const headers = { host: `127.0.0.1:${PORT}`, ...o.headers };
    const req = new Request(`${ORIGIN}${path}`, { method: o.method ?? "GET", headers, body: o.body ?? null });
    const upgraded: string[] = [];
    const server: PeerServer = {
      requestIP: () => (o.peer === null ? null : { address: o.peer ?? "127.0.0.1" }),
      upgrade: () => (upgraded.push(path), true),
    };
    const res = await handler(req, server);
    return { res, upgraded };
  }
  const json = { "content-type": "application/json", origin: ORIGIN };
  const write = (path: string, method: string, body: unknown = {}) => call(path, { method, headers: json, body: JSON.stringify(body) });
  const rows = (table: string) => store.db.query(`SELECT host_id, attrs FROM ${table}`).all() as { host_id: string; attrs: string }[];
  return { store, call, write, rows, rebinds, published, dir, advance: (ms: number) => (offsetMs += ms) };
}

async function addHost(h: ReturnType<typeof harness>, name = "linux-box") {
  const { res } = await h.write("/api/hosts", "POST", { name });
  expect(res!.status).toBe(201);
  return (await res!.json()) as { host: { id: string; name: string; createdMs: number | null; lastSeenMs: number | null }; token: string; env: Record<string, string>; tailscaleAddress: string | null };
}

function ingestRequest(signal: (typeof SIGNALS)[number], encoding: "json" | "protobuf", sessionId: string, marker: string): { headers: Record<string, string>; body: BodyInit } {
  return encoding === "json"
    ? { headers: { "content-type": "application/json" }, body: JSON.stringify(otlpJson(signal, sessionId, marker)) }
    : { headers: { "content-type": "application/x-protobuf" }, body: otlpProtobuf(signal, sessionId, marker, requestType) as unknown as BodyInit };
}

describe("remote ingest", () => {
  for (const signal of SIGNALS) {
    for (const encoding of ["json", "protobuf"] as const) {
      test(`${signal} over ${encoding}: token decides acceptance and the stored host`, async () => {
        const h = harness();
        const { host, token } = await addHost(h);
        const send = async (peer: string | null, authorization: string | null, marker: string) => {
          const r = ingestRequest(signal, encoding, "S", marker);
          const headers: Record<string, string> = { ...r.headers };
          if (authorization !== null) headers.authorization = authorization;
          return (await h.call(`/v1/${signal}`, { method: "POST", peer, headers, body: r.body })).res!.status;
        };
        expect(await send(TAILNET, null, "missing")).toBe(401);
        expect(await send(TAILNET, "Bearer cpa_wrong", "wrong")).toBe(401);
        expect(await send("192.168.1.20", `Bearer ${token}`, "outside")).toBe(403);
        expect(await send(TAILNET, `Bearer ${token}`, "valid-remote")).toBe(200);
        expect(await send("fd7a:115c:a1e0::42", `Bearer ${token}`, "valid-remote-v6")).toBe(200);
        expect(await send("127.0.0.1", null, "local")).toBe(200);
        expect(await send("::1", `Bearer ${token}`, "loopback-with-token")).toBe(200);
        expect(await send("127.0.0.1", "Bearer cpa_wrong", "loopback-bad-token")).toBe(401);

        const rotated = (await (await h.write(`/api/hosts/${host.id}/token`, "POST")).res!.json()) as { token: string };
        expect(await send(TAILNET, `Bearer ${token}`, "old-token")).toBe(401);
        expect(await send(TAILNET, `Bearer ${rotated.token}`, "rotated")).toBe(200);
        expect((await h.write(`/api/hosts/${host.id}`, "DELETE")).res!.status).toBe(204);
        expect(await send(TAILNET, `Bearer ${rotated.token}`, "deleted")).toBe(401);

        // Every accepted remote row was removed with the host; spoofed attrs never claimed "local".
        const stored = h.rows(TABLE[signal]).map((r) => [r.host_id, JSON.parse(r.attrs).marker]);
        expect(stored).toEqual([["local", "local"]]);
      });
    }
  }

  test("accepted rows carry the authenticated host even when attrs say local", async () => {
    const h = harness();
    const { host, token } = await addHost(h);
    for (const signal of SIGNALS) {
      const r = ingestRequest(signal, "json", "S", "spoofed");
      const res = (await h.call(`/v1/${signal}`, { method: "POST", peer: TAILNET, headers: { ...r.headers, authorization: `Bearer ${token}` }, body: r.body })).res!;
      expect(res.status).toBe(200);
      const rows = h.rows(TABLE[signal]);
      expect(rows.map((x) => x.host_id)).toEqual([host.id]);
      expect(JSON.parse(rows[0]!.attrs).host_id).toBe("local");
    }
    expect(h.published.at(-1)).toMatchObject({ type: "events", host: host.id, changed: 1 });
  });

  for (const action of ["rotate", "delete"] as const) {
    test(`a token ${action}d while the body is still arriving stores nothing`, async () => {
      const h = harness();
      const { host, token } = await addHost(h);
      await addHost(h, "keeps-listener-wide");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const bytes = new TextEncoder().encode(JSON.stringify(otlpJson("logs", "S", "late")));
      const body = new ReadableStream({
        async pull(controller) {
          await gate;
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const pending = h.call("/v1/logs", { method: "POST", peer: TAILNET, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body });
      await Bun.sleep(20);
      if (action === "rotate") expect((await h.write(`/api/hosts/${host.id}/token`, "POST")).res!.status).toBe(200);
      else expect((await h.write(`/api/hosts/${host.id}`, "DELETE")).res!.status).toBe(204);
      release();
      const res = (await pending).res!;
      expect(res.status).toBe(401);
      expect(h.rows("events")).toEqual([]);
      expect(h.published).toEqual([]);
    });
  }

  test("last_seen updates on accepted remote ingest, at most once a minute per host", async () => {
    const h = harness();
    const a = await addHost(h, "a");
    const b = await addHost(h, "b");
    const post = (token: string) => {
      const r = ingestRequest("metrics", "json", "S", "x");
      return h.call("/v1/metrics", { method: "POST", peer: TAILNET, headers: { ...r.headers, authorization: `Bearer ${token}` }, body: r.body });
    };
    expect(h.store.host(a.host.id)!.lastSeenMs).toBeNull();
    await post(a.token);
    const first = h.store.host(a.host.id)!.lastSeenMs!;
    expect(first).toBeGreaterThan(0);
    expect(h.store.host(b.host.id)!.lastSeenMs).toBeNull();
    h.advance(30_000);
    await post(a.token);
    expect(h.store.host(a.host.id)!.lastSeenMs).toBe(first);
    await post(b.token);
    expect(h.store.host(b.host.id)!.lastSeenMs).toBeGreaterThan(first);
    h.advance(31_000);
    await post(a.token);
    expect(h.store.host(a.host.id)!.lastSeenMs).toBeGreaterThanOrEqual(first + 61_000);
    // Rejected and local traffic never touch it.
    const before = h.store.host(a.host.id)!.lastSeenMs;
    h.advance(120_000);
    await post("cpa_wrong");
    expect(h.store.host(a.host.id)!.lastSeenMs).toBe(before);
  });
});

describe("peer gate", () => {
  const spoofed = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "content-type": "application/json" };
  let dashboard: ReturnType<typeof startDashboardServer>;
  let assetPaths: string[] = [];
  beforeAll(async () => {
    dashboard = startDashboardServer();
    const html = await (await fetch(`http://127.0.0.1:${dashboard.port}/`)).text();
    assetPaths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p.startsWith("/"));
  });
  afterAll(() => dashboard.stop(true));

  test("the dashboard HTML references generated assets", () => {
    expect(assetPaths.length).toBeGreaterThanOrEqual(1);
  });

  test("a tailnet peer spoofing localhost Host and Origin gets 403 everywhere but ingest, and changes nothing", async () => {
    const settings = join(mkdtempSync(join(tmpdir(), "cc-gate-")), "settings.json");
    writeFileSync(settings, "{}");
    process.env.CC_SETTINGS_PATH = settings;
    const h = harness({ assets: proxyAssets(`http://127.0.0.1:${dashboard.port}`) });
    const { host, token } = await addHost(h);
    const rebindsBefore = h.rebinds.length;
    const local = ingestRequest("logs", "json", "S", "local-row");
    expect((await h.call("/v1/logs", { method: "POST", headers: local.headers, body: local.body })).res!.status).toBe(200);
    const id = (await (await h.call("/api/live")).res!.json())[0].id;
    expect((await h.call(`/api/event?id=${id}`)).res!.status).toBe(200);
    const routes: [string, string][] = [
      ["GET", "/"],
      ...assetPaths.map((p): [string, string] => ["GET", p]),
      ["GET", "/api/summary"],
      ["GET", "/api/status"],
      ["GET", "/api/live"],
      ["GET", "/api/turn"],
      ["GET", "/api/turns"],
      ["GET", `/api/event?id=${id}`],
      ["GET", "/api/item?kind=tools&name=Bash"],
      ["GET", "/api/setup"],
      ["POST", "/api/setup"],
      ["GET", "/api/hosts"],
      ["POST", "/api/hosts"],
      ["POST", `/api/hosts/${host.id}/token`],
      ["DELETE", `/api/hosts/${host.id}`],
      ["GET", "/ws"],
      ["GET", "/nope"],
      ["HEAD", "/"],
      ["HEAD", "/api/summary"],
      ["GET", "/v1/logs"],
      ["PUT", "/v1/traces"],
      ["DELETE", "/v1/metrics"],
      ["OPTIONS", "/v1/logs"],
      ["HEAD", "/v1/logs"],
    ];
    for (const peer of [TAILNET, "fd7a:115c:a1e0::9", "192.168.1.20", "::ffff:100.88.1.2", null]) {
      for (const [method, path] of routes) {
        const hasBody = method === "POST" || method === "PUT" || method === "DELETE";
        const { res, upgraded } = await h.call(path, {
          peer,
          method,
          headers: { ...spoofed, upgrade: path === "/ws" ? "websocket" : "", authorization: `Bearer ${token}` },
          body: hasBody ? JSON.stringify({ name: "sneaky" }) : null,
        });
        expect([peer, method, path, res?.status]).toEqual([peer, method, path, 403]);
        expect(upgraded).toEqual([]);
      }
    }
    // Nothing moved: still one remote host, same token, no settings written, no new rebinds.
    expect(h.store.hosts().map((x) => x.name)).toEqual(["linux-box"]);
    const r = ingestRequest("logs", "json", "S", "still-valid");
    expect((await h.call("/v1/logs", { method: "POST", peer: TAILNET, headers: { ...r.headers, authorization: `Bearer ${token}` }, body: r.body })).res!.status).toBe(200);
    expect(readFileSync(settings, "utf8")).toBe("{}");
    expect(h.rebinds.length).toBe(rebindsBefore);
  });

  test("loopback positive controls return real bodies", async () => {
    const h = harness({ assets: proxyAssets(`http://127.0.0.1:${dashboard.port}`) });
    const root = (await h.call("/")).res!;
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("<div id=\"root\"></div>");
    for (const p of assetPaths) {
      const res = (await h.call(p)).res!;
      expect([p, res.status]).toEqual([p, 200]);
      const type = res.headers.get("content-type") ?? "";
      expect(type).toMatch(/javascript|css/);
      expect((await res.text()).length).toBeGreaterThan(100);
    }
    // The internal server never sees the caller's Host or Authorization.
    expect((await h.call("/", { headers: { authorization: "Bearer cpa_x" } })).res!.status).toBe(200);
    const summary = await (await h.call("/api/summary")).res!.json();
    expect(summary).toHaveProperty("windowMs");
    expect(await (await h.call("/api/live")).res!.json()).toEqual([]);
    expect(await (await h.call("/api/hosts")).res!.json()).toEqual([{ id: "local", name: "This Mac", createdMs: null, lastSeenMs: null }]);
    expect((await h.call("/ws", { headers: { upgrade: "websocket" } })).upgraded).toEqual(["/ws"]);
    expect((await h.call("/api/summary", { peer: "::1" })).res!.status).toBe(200);
    expect((await h.call("/api/summary", { peer: "::ffff:127.0.0.1" })).res!.status).toBe(200);
  });

  test("bracketed IPv6 loopback Host and Origin are our own; foreign ones are not", async () => {
    const h = harness();
    const v6 = { host: `[::1]:${PORT}` };
    expect((await h.call("/api/summary", { peer: "::1", headers: v6 })).res!.status).toBe(200);
    expect((await h.call("/api/summary", { headers: { host: "evil.example" } })).res!.status).toBe(403);
    expect((await h.call("/", { headers: { host: "evil.example" } })).res!.status).toBe(403);
    const created = await h.call("/api/hosts", { method: "POST", peer: "::1", headers: { ...v6, origin: `http://[::1]:${PORT}`, "content-type": "application/json" }, body: JSON.stringify({ name: "v6" }) });
    expect(created.res!.status).toBe(201);
    const foreign = await h.call("/api/hosts", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(foreign.res!.status).toBe(403);
    const noJson = await h.call("/api/hosts", { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify({ name: "x" }) });
    expect(noJson.res!.status).toBe(403);
  });
});

describe("host management", () => {
  test("list, create, reveal once, regenerate, delete", async () => {
    const h = harness();
    const created = await addHost(h, "  build box  ");
    expect(created.host).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "build box", createdMs: expect.any(Number), lastSeenMs: null });
    expect(created.token).toMatch(/^cpa_[A-Za-z0-9_-]{43}$/);
    expect(created.tailscaleAddress).toBe("100.101.102.103");
    expect(created.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://100.101.102.103:${PORT}`);
    expect(created.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${created.token}`);
    expect(created.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");

    const list = (await h.call("/api/hosts")).res!;
    expect(list.headers.get("cache-control")).toBe("no-store");
    const hosts = await list.json();
    expect(hosts).toEqual([{ id: "local", name: "This Mac", createdMs: null, lastSeenMs: null }, created.host]);
    expect(JSON.stringify(hosts)).not.toContain(created.token);

    const second = await addHost(h, "second");
    expect((await (await h.call("/api/hosts")).res!.json()).map((x: any) => x.name)).toEqual(["This Mac", "build box", "second"]);

    const regen = (await h.write(`/api/hosts/${created.host.id}/token`, "POST")).res!;
    expect(regen.status).toBe(200);
    expect(regen.headers.get("cache-control")).toBe("no-store");
    const regenBody = await regen.json();
    expect(regenBody.host).toEqual(created.host);
    expect(regenBody.token).not.toBe(created.token);
    expect(regenBody.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${regenBody.token}`);

    const del = (await h.write(`/api/hosts/${second.host.id}`, "DELETE")).res!;
    expect(del.status).toBe(204);
    expect((await (await h.call("/api/hosts")).res!.json()).map((x: any) => x.name)).toEqual(["This Mac", "build box"]);
  });

  test("missing Tailscale address yields a placeholder endpoint and null address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-remote-http-"));
    const handler = createHandler({
      store: openStore(join(dir, "t.sqlite")),
      port: PORT,
      assets: () => new Response(""),
      rebind: () => {},
      publish: () => {},
      tailscaleAddress: () => null,
    });
    const req = new Request(`${ORIGIN}/api/hosts`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    const res = (await handler(req, { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false }))!;
    const body = await res.json();
    expect(body.tailscaleAddress).toBeNull();
    expect(body.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://<THIS_MAC_TAILSCALE_IP>:${PORT}`);
  });

  test("invalid and duplicate names", async () => {
    const h = harness();
    await addHost(h, "taken");
    for (const name of ["", "   ", "x".repeat(81), "bad\nname", "tab\tname", "nul\u0000", 42, null]) {
      const res = (await h.write("/api/hosts", "POST", { name })).res!;
      expect([name, res.status]).toEqual([name, 400]);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect((await h.write("/api/hosts", "POST", { name: "x".repeat(80) })).res!.status).toBe(201);
    expect((await h.call("/api/hosts", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{not json" })).res!.status).toBe(400);
    for (const name of ["taken", " taken ", "This Mac"]) {
      const res = (await h.write("/api/hosts", "POST", { name })).res!;
      expect([name, res.status]).toEqual([name, 409]);
    }
    expect(h.store.hosts()).toHaveLength(2);
  });

  test("unknown and local hosts cannot be mutated", async () => {
    const h = harness();
    for (const id of ["local", "nope", "00000000-0000-0000-0000-000000000000"]) {
      expect((await h.write(`/api/hosts/${id}/token`, "POST")).res!.status).toBe(404);
      const del = (await h.write(`/api/hosts/${id}`, "DELETE")).res!;
      expect(del.status).toBe(404);
      expect(await del.json()).toEqual({ error: expect.any(String) });
    }
  });

  test("every read endpoint returns 404 for an unknown host before querying", async () => {
    const h = harness();
    const before = h.store.db.query("SELECT COUNT(*) AS n FROM events").get();
    for (const path of ["/api/summary", "/api/status", "/api/live", "/api/turn", "/api/turns", "/api/event?id=1", "/api/item?kind=tools&name=Bash"]) {
      const sep = path.includes("?") ? "&" : "?";
      const res = (await h.call(`${path}${sep}host=nope`)).res!;
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: "unknown host" });
      if (!path.startsWith("/api/event")) expect((await h.call(`${path}${sep}host=local`)).res!.status).toBe(200);
    }
    expect(h.store.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
  });

  test("first add binds wide and last remove binds narrow; failures roll back", async () => {
    let fail = false;
    const h = harness({
      rebind: () => {
        if (fail) throw new ListenerError("injected bind failure", true);
      },
    });
    const a = await addHost(h, "a");
    expect(h.rebinds).toEqual([true]);
    const b = await addHost(h, "b");
    expect(h.rebinds).toEqual([true]);
    expect((await h.write(`/api/hosts/${a.host.id}`, "DELETE")).res!.status).toBe(204);
    expect(h.rebinds).toEqual([true]);

    // Seed the last host's data, then make the narrowing fail: host and data must stay.
    const r = ingestRequest("logs", "json", "S", "keep");
    await h.call("/v1/logs", { method: "POST", peer: TAILNET, headers: { ...r.headers, authorization: `Bearer ${b.token}` }, body: r.body });
    fail = true;
    const failed = (await h.write(`/api/hosts/${b.host.id}`, "DELETE")).res!;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: expect.any(String) });
    expect(h.store.host(b.host.id)).not.toBeNull();
    expect(h.rows("events").map((x) => x.host_id)).toEqual([b.host.id]);
    fail = false;
    expect((await h.write(`/api/hosts/${b.host.id}`, "DELETE")).res!.status).toBe(204);
    // The harness records only rebinds that succeeded.
    expect(h.rebinds).toEqual([true, false]);
    expect(h.rows("events")).toEqual([]);

    // A failed first add leaves no host behind.
    fail = true;
    const bad = (await h.write("/api/hosts", "POST", { name: "c" })).res!;
    expect(bad.status).toBe(503);
    expect(h.store.hosts()).toEqual([]);
  });

  test("a listener that could not be restored fails loudly", async () => {
    const h = harness({
      rebind: () => {
        throw new ListenerError("injected: restore failed", false);
      },
    });
    const res = (await h.write("/api/hosts", "POST", { name: "c" })).res!;
    expect(res.status).toBe(500);
    expect(h.store.hosts()).toEqual([]);
  });

  test("setup always configures this Mac, whatever host is selected", async () => {
    const settings = join(mkdtempSync(join(tmpdir(), "cc-setup-host-")), "settings.json");
    writeFileSync(settings, "{}");
    process.env.CC_SETTINGS_PATH = settings;
    const h = harness();
    const { host } = await addHost(h);
    const res = (await h.call(`/api/setup?host=${host.id}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).res!;
    expect(res.status).toBe(200);
    const env = JSON.parse(readFileSync(settings, "utf8")).env;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ORIGIN);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });
});
