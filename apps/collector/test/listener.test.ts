import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { createHandler } from "../src/http";
import { createListener, ListenerError, type Listener } from "../src/listener";
import { freePort } from "./server";

let active: Listener | null = null;
afterEach(async () => {
  await active?.stop();
  active = null;
});

const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { headers }).then(
    async (r) => `${r.status} ${await r.text()}`,
    () => "refused",
  );

test("loopback-only by default; rebinding inside a request keeps that request's response", async () => {
  const port = freePort();
  const listener = (active = createListener({
    port,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/wide") listener.rebind(true);
      if (path === "/narrow") listener.rebind(false);
      return new Response(`ok ${path}`);
    },
  }));
  listener.start(false);
  expect(listener.remoteEnabled).toBe(false);
  expect(await get(`http://127.0.0.1:${port}/a`)).toBe("200 ok /a");
  expect(await get(`http://[::1]:${port}/a`)).toBe("refused");

  expect(await get(`http://127.0.0.1:${port}/wide`)).toBe("200 ok /wide");
  expect(listener.remoteEnabled).toBe(true);
  expect(await get(`http://[::1]:${port}/b`)).toBe("200 ok /b");
  expect(await get(`http://127.0.0.1:${port}/b`)).toBe("200 ok /b");

  expect(await get(`http://[::1]:${port}/narrow`)).toBe("200 ok /narrow");
  expect(listener.remoteEnabled).toBe(false);
  expect(await get(`http://[::1]:${port}/c`)).toBe("refused");
  expect(await get(`http://127.0.0.1:${port}/c`)).toBe("200 ok /c");

  // Same mode again is a no-op.
  listener.rebind(false);
  expect(await get(`http://127.0.0.1:${port}/d`)).toBe("200 ok /d");
});

test("a failed bind restores the previous binding and says so", async () => {
  const port = freePort();
  let failNext = 0;
  const listener = (active = createListener({
    port,
    fetch: () => new Response("alive"),
    serve: (options) => {
      if (failNext > 0) {
        failNext--;
        throw Object.assign(new Error("injected EADDRINUSE"), { code: "EADDRINUSE" });
      }
      return Bun.serve(options);
    },
  }));
  listener.start(false);
  failNext = 1;
  let caught: unknown;
  try {
    listener.rebind(true);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ListenerError);
  expect((caught as ListenerError).restored).toBe(true);
  expect(listener.remoteEnabled).toBe(false);
  expect(await get(`http://127.0.0.1:${port}/`)).toBe("200 alive");
  expect(await get(`http://[::1]:${port}/`)).toBe("refused");
});

test("a failed restore is reported as not restored", () => {
  const port = freePort();
  let failNext = 0;
  const listener = (active = createListener({
    port,
    fetch: () => new Response("alive"),
    serve: (options) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("injected");
      }
      return Bun.serve(options);
    },
  }));
  listener.start(false);
  failNext = 2;
  let caught: unknown;
  try {
    listener.rebind(true);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ListenerError);
  expect((caught as ListenerError).restored).toBe(false);
  expect(listener.server).toBeNull();
});

test("retired WebSockets close with 1001 and new ones get published messages", async () => {
  const port = freePort();
  const listener = (active = createListener({
    port,
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no")),
  }));
  listener.start(false);
  const old = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => ((old.onopen = resolve), (old.onerror = reject)));
  const closed = new Promise<number>((resolve) => (old.onclose = (e) => resolve(e.code)));

  listener.rebind(true);
  expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(1001);

  const fresh = new WebSocket(`ws://[::1]:${port}/ws`);
  await new Promise((resolve, reject) => ((fresh.onopen = resolve), (fresh.onerror = reject)));
  const got = new Promise<string>((resolve) => (fresh.onmessage = (m) => resolve(String(m.data))));
  await Bun.sleep(20);
  listener.publish("hello");
  expect(await Promise.race([got, Bun.sleep(2000).then(() => "timeout")])).toBe("hello");
  fresh.close();
});

test("shutdown with an open WebSocket does not hang", async () => {
  const port = freePort();
  const listener = createListener({ port, fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no")) });
  listener.start(true);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const started = Date.now();
  await Promise.race([listener.stop(), Bun.sleep(3000)]);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await get(`http://127.0.0.1:${port}/`)).toBe("refused");
});

test("adding the first host and removing the last change the real binding without losing either response", async () => {
  const port = freePort();
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-listener-")), "t.sqlite"));
  let listener!: Listener;
  const handler = createHandler({
    store,
    port,
    assets: () => new Response("asset"),
    rebind: (remote) => listener.rebind(remote),
    publish: (m) => listener.publish(m),
    tailscaleAddress: () => null,
  });
  listener = active = createListener({ port, fetch: handler });
  listener.start(store.hosts().length > 0);
  const write = (base: string, path: string, method: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const v4 = `http://127.0.0.1:${port}`;
  const v6 = `http://[::1]:${port}`;

  expect(await get(`${v6}/api/hosts`)).toBe("refused");
  const created = await write(v4, "/api/hosts", "POST", { name: "first" });
  expect(created.status).toBe(201);
  const { host } = (await created.json()) as { host: { id: string } };
  // Dual-stack now: IPv6 loopback reaches the API, and the peer gate still sees loopback.
  expect(await get(`${v6}/api/hosts`)).toStartWith("200 ");
  expect(await get(`${v4}/api/hosts`)).toStartWith("200 ");

  // Two consecutive mutations: a second host needs no rebind, removing it neither.
  const second = await write(v6, "/api/hosts", "POST", { name: "second" });
  expect(second.status).toBe(201);
  const secondId = ((await second.json()) as { host: { id: string } }).host.id;
  expect((await write(v6, `/api/hosts/${secondId}`, "DELETE")).status).toBe(204);
  expect(listener.remoteEnabled).toBe(true);

  const removed = await write(v6, `/api/hosts/${host.id}`, "DELETE");
  expect(removed.status).toBe(204);
  expect(listener.remoteEnabled).toBe(false);
  expect(await get(`${v6}/api/hosts`)).toBe("refused");
  expect(JSON.parse((await get(`${v4}/api/hosts`)).slice(4))).toEqual([{ id: "local", name: "This Mac", createdMs: null, lastSeenMs: null }]);
});
