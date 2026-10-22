import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { proxyAssets, startDashboardServer } from "./assets";
import { openStore } from "./db";
import { createHandler } from "./http";
import { createListener, type Listener } from "./listener";

const PORT = Number(process.env.PORT ?? 4318);
const DATA_DIR = process.env.CC_TELEMETRY_DIR ?? `${homedir()}/.claude-telemetry`;
const RETENTION_MS = 14 * 24 * 3600_000;

mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(`${DATA_DIR}/telemetry.sqlite`);
store.prune(Date.now() - RETENTION_MS);
setInterval(() => store.prune(Date.now() - RETENTION_MS), 3600_000);

const dashboard = startDashboardServer();

let listener: Listener;
const handler = createHandler({
  store,
  port: PORT,
  assets: proxyAssets(`http://127.0.0.1:${dashboard.port}`),
  rebind: (remoteEnabled) => listener.rebind(remoteEnabled),
  publish: (message) => listener.publish(message),
  // The listener is gone or no longer matches the stored hosts. Exit after the 500 goes out so
  // launchd starts a fresh collector, which binds according to the (rolled back) host list.
  onFatal: () => setTimeout(() => process.exit(1), 100),
});
listener = createListener({ port: PORT, fetch: handler });

const isPortTaken = (err: unknown) => (err as { code?: string }).code === "EADDRINUSE";

// launchd sets CC_WAIT_FOR_PORT for the collector bundled in the app. If another collector
// holds the port, this one waits and takes over once it stops, instead of exiting for good.
async function serveWhenFree() {
  let logged = false;
  for (;;) {
    try {
      return listener.start(store.hosts().length > 0);
    } catch (err) {
      if (!isPortTaken(err) || !process.env.CC_WAIT_FOR_PORT) throw err;
      if (!logged) console.error(`port ${PORT} is in use, probably by another collector. Waiting for it.`);
      logged = true;
      await Bun.sleep(1000);
    }
  }
}

const server = await serveWhenFree();

console.log(`claude telemetry collector on ${server.url} (data: ${DATA_DIR}${listener.remoteEnabled ? ", accepting remote hosts" : ""})`);
