// The public socket. Loopback only (127.0.0.1) while there are no remote hosts, dual-stack
// (::) while there are. Switching happens in process, from inside the request that asked for it.
import type { Server, ServerWebSocket } from "bun";

export class ListenerError extends Error {
  // restored: the previous binding is back. When false, nothing is listening any more.
  constructor(
    message: string,
    readonly restored: boolean,
  ) {
    super(message);
    this.name = "ListenerError";
  }
}

type Fetch = (req: Request, server: Server<undefined>) => Response | undefined | Promise<Response | undefined>;
type ServeOptions = Parameters<typeof Bun.serve>[0];

export interface ListenerOptions {
  // Captured once: a stopped server's own port is no longer usable to rebind.
  port: number;
  fetch: Fetch;
  // Injected by tests to simulate a bind failure.
  serve?: (options: any) => Server<undefined>;
}

export type Listener = ReturnType<typeof createListener>;

const TOPIC = "live";

export function createListener(opts: ListenerOptions) {
  const serve = opts.serve ?? ((o: ServeOptions) => Bun.serve(o));
  let current: Server<undefined> | null = null;
  let remote = false;
  const sockets = new Set<ServerWebSocket<undefined>>();
  const draining = new Set<Server<undefined>>();

  const bind = (remoteEnabled: boolean) =>
    serve({
      port: opts.port,
      hostname: remoteEnabled ? "::" : "127.0.0.1",
      fetch: opts.fetch,
      websocket: {
        open: (ws: ServerWebSocket<undefined>) => {
          sockets.add(ws);
          ws.subscribe(TOPIC);
        },
        close: (ws: ServerWebSocket<undefined>) => {
          sockets.delete(ws);
        },
        message: () => {},
      },
      development: false,
    });

  return {
    get server() {
      return current;
    },
    get remoteEnabled() {
      return remote;
    },
    start(remoteEnabled: boolean) {
      current = bind(remoteEnabled);
      remote = remoteEnabled;
      return current;
    },
    // Synchronous, so a caller can roll back its own change when this throws.
    rebind(remoteEnabled: boolean) {
      if (!current) throw new ListenerError("the collector is not listening", false);
      if (remoteEnabled === remote) return;
      const old = current;
      const retired = [...sockets];
      // Stop accepting without waiting: in-flight requests, including the one that asked for
      // this change, still get their response. Open WebSockets would hold a drain forever.
      draining.add(old);
      old.stop(false).finally(() => draining.delete(old));
      current = null;
      let failure: Error | null = null;
      try {
        current = bind(remoteEnabled);
        remote = remoteEnabled;
      } catch (err) {
        failure = err as Error;
        try {
          current = bind(remote);
        } catch (restoreErr) {
          for (const ws of retired) ws.close(1001, "collector stopped listening");
          throw new ListenerError(
            `could not listen on ${remoteEnabled ? "::" : "127.0.0.1"}:${opts.port} (${failure.message}) nor restore ${remote ? "::" : "127.0.0.1"} (${(restoreErr as Error).message})`,
            false,
          );
        }
      }
      // Live clients reconnect to the new socket.
      for (const ws of retired) ws.close(1001, "collector address changed");
      if (failure) throw new ListenerError(`could not listen on ${remoteEnabled ? "::" : "127.0.0.1"}:${opts.port}: ${failure.message}`, true);
    },
    publish(message: string) {
      current?.publish(TOPIC, message);
    },
    async stop() {
      for (const ws of sockets) ws.close(1001, "collector shutting down");
      const servers = [...draining, ...(current ? [current] : [])];
      current = null;
      await Promise.all(servers.map((s) => s.stop(true)));
    },
  };
}
