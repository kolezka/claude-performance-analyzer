// Disposable child for commit-fault.test.ts. Makes SQLite's commit fail with a real disk error
// (RLIMIT_FSIZE = 0 in this process only, SIGXFSZ ignored) after a host mutation has already
// moved the listener. Temp data only; prints one JSON line per scenario.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/db";
import { hashToken } from "../../src/hosts";
import { createHandler } from "../../src/http";
import { createListener, ListenerError, type Listener } from "../../src/listener";

const RLIMIT_FSIZE = 1;
const SIGXFSZ = 25;
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
});
const saved = new BigUint64Array(2);
if (libc.symbols.getrlimit(RLIMIT_FSIZE, ptr(saved)) !== 0) throw new Error("getrlimit failed");
libc.symbols.signal(SIGXFSZ, 1 as any); // SIG_IGN

function freePort() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

type Scenario = { action: "delete" | "add"; fault: boolean; restoreFails: boolean };

async function run({ action, fault, restoreFails }: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "cc-commit-fault-"));
  const path = join(dir, "telemetry.sqlite");
  const store = openStore(path);
  const host = action === "delete" ? store.createHost("remote", hashToken("disposable"), 1) : null;
  if (host) store.addEvents([{ tsMs: 123, name: "user_prompt", sessionId: "s", promptId: "p", attrs: { marker: "retained-row" } }], host.id);
  store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  if (statSync(`${path}-wal`).size !== 0) throw new Error("WAL not empty before the fault");

  const port = freePort();
  let listener!: Listener;
  const rebinds: boolean[] = [];
  const fatal: string[] = [];
  const handler = createHandler({
    store,
    port,
    assets: () => new Response("asset"),
    rebind: (wide) => {
      // The second call is the rollback restore. Simulate it failing while the listener stays
      // in the interim (wrong) mode.
      if (restoreFails && rebinds.length === 1) throw new ListenerError("injected restore failure", true);
      listener.rebind(wide);
      rebinds.push(wide);
    },
    publish: () => {},
    tailscaleAddress: () => null,
    onFatal: (message) => fatal.push(message),
  });
  listener = createListener({ port, fetch: handler });
  const startWide = action === "delete";
  listener.start(startWide);

  const origin = `http://127.0.0.1:${port}`;
  const req =
    action === "delete"
      ? new Request(`${origin}/api/hosts/${host!.id}`, { method: "DELETE", headers: { host: `127.0.0.1:${port}`, origin, "content-type": "application/json" }, body: "{}" })
      : new Request(`${origin}/api/hosts`, { method: "POST", headers: { host: `127.0.0.1:${port}`, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "new" }) });
  // Read the body before the fault so only SQLite's commit can fail.
  const body = await req.text();
  const ready = new Request(req.url, { method: req.method, headers: req.headers, body });

  let status: number | null = null;
  let error: string | null = null;
  let responseBody: unknown = null;
  try {
    if (fault && libc.symbols.setrlimit(RLIMIT_FSIZE, ptr(new BigUint64Array([0n, saved[1]!]))) !== 0) throw new Error("setrlimit failed");
    try {
      const res = (await handler(ready, { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false }))!;
      status = res.status;
      responseBody = res.status === 204 ? null : await res.json();
    } catch (e: any) {
      error = `${e.code ?? e.name}: ${e.message}`;
    }
  } finally {
    if (libc.symbols.setrlimit(RLIMIT_FSIZE, ptr(saved)) !== 0) throw new Error("could not restore RLIMIT_FSIZE");
  }

  const ipv6 = await fetch(`http://[::1]:${port}/api/hosts`, { signal: AbortSignal.timeout(1000) }).then((r) => r.status, () => "refused");
  console.log(
    JSON.stringify({
      action,
      fault,
      restoreFails,
      status,
      error,
      responseBody,
      rebinds,
      fatal: fatal.length,
      remoteEnabled: listener.remoteEnabled,
      startWide,
      hosts: store.hosts().map((h) => h.name),
      rows: host ? store.events(0, host.id).map((e) => e.attrs.marker) : [],
      ipv6,
    }),
  );
  await listener.stop();
  store.db.close();
}

try {
  for (const action of ["delete", "add"] as const) {
    await run({ action, fault: false, restoreFails: false });
    await run({ action, fault: true, restoreFails: false });
    await run({ action, fault: true, restoreFails: true });
  }
} finally {
  libc.close();
}
