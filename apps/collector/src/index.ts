import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { proxyAssets, startDashboardServer } from "./assets";
import { openStore, type Store } from "./db";
import { createHandler, type Handler } from "./http";
import { createListener } from "./listener";

const PORT = Number(process.env.PORT ?? 4318);
const DATA_DIR = process.env.CC_TELEMETRY_DIR ?? `${homedir()}/.claude-telemetry`;
const RETENTION_MS = 14 * 24 * 3600_000;

let handler: Handler | undefined;
const listener = createListener({
  port: PORT,
  fetch: (req, server) => {
    if (!handler) return new Response("Collector is starting", { status: 503 });
    // undefined is a successful WebSocket upgrade, not a missing handler.
    return handler(req, server);
  },
});

const isPortTaken = (err: unknown) => (err as { code?: string }).code === "EADDRINUSE";

// The old port owner may still be writing with the legacy schema. Waiting must not migrate
// or prune its database; claim loopback first, then restore the stored host listener mode.
async function serveWhenFree() {
  let logged = false;
  for (;;) {
    try {
      return listener.start(false);
    } catch (err) {
      if (!isPortTaken(err) || !process.env.CC_WAIT_FOR_PORT) throw err;
      if (!logged) console.error(`port ${PORT} is in use, probably by another collector. Waiting for it.`);
      logged = true;
      await Bun.sleep(1000);
    }
  }
}

await serveWhenFree();

let store: Store | undefined;
let dashboard: ReturnType<typeof startDashboardServer> | undefined;
try {
  mkdirSync(DATA_DIR, { recursive: true });
  const readyStore = openStore(`${DATA_DIR}/telemetry.sqlite`);
  store = readyStore;
  readyStore.prune(Date.now() - RETENTION_MS);
  dashboard = startDashboardServer();
  handler = createHandler({
    store: readyStore,
    port: PORT,
    assets: proxyAssets(`http://127.0.0.1:${dashboard.port}`),
    rebind: (remoteEnabled) => listener.rebind(remoteEnabled),
    publish: (message) => listener.publish(message),
    // Exit after the 500 goes out so launchd can restore the persisted listener mode.
    onFatal: () => setTimeout(() => process.exit(1), 100),
  });
  listener.rebind(readyStore.hosts().length > 0);
  setInterval(() => readyStore.prune(Date.now() - RETENTION_MS), 3600_000);
} catch (error) {
  await listener.stop();
  await dashboard?.stop(true);
  store?.db.close();
  throw error;
}

console.log(`claude telemetry collector on ${listener.server!.url} (data: ${DATA_DIR}${listener.remoteEnabled ? ", accepting remote hosts" : ""})`);
