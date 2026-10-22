// The collector's one public request handler. A peer-address gate runs before anything else:
// only the three OTLP ingest posts are open to Tailscale peers (with a token), everything else
// is for this Mac's own loopback clients, with Host/Origin checks on top.
import { networkInterfaces } from "node:os";
import { decodeOtlp, parseLogs, parseMetrics, parseTraces, type EventRow, type Signal } from "@cpa/otlp";
import {
  buildTurnRows,
  eventDetails,
  extractPaths,
  idleGaps,
  itemDurationMs,
  itemFailed,
  itemKey,
  itemRecentDetail,
  liveEvent,
  percentile,
  promptBreakdowns,
  status,
  summarize,
  turnTimeline,
  type ItemKind,
  ITEM_EVENT_NAMES,
} from "@cpa/analytics";
import { applyEnv, planEnv, settingsPath, telemetryEnv } from "@cpa/claude-settings";
import { authorizeIngest, classifyPeer } from "./access";
import { BoundedCache } from "./bounded-cache";
import type { Store } from "./db";
import { buildHookDefinitions, hookCallFromAttrs, type HookCall, type HookDefinition } from "./hooks";
import { createToken, hashToken, hostContext, LOCAL_HOST, LOCAL_HOST_ID, type HostContext, type HostCredentials } from "./hosts";
import { ListenerError } from "./listener";
import { gitRoot, type RepoInfo } from "./repos";
import { branchAsOf, buildSessionInfo, pathAsOf, repoAsOf, SESSION_EVENT_NAMES, type SessionInfo } from "./sessions";

// The part of Bun's Server the handler uses. Always the server that accepted the request, so
// requestIP reports the real socket peer.
export interface PeerServer {
  requestIP(req: Request): { address: string } | null;
  upgrade(req: Request): boolean;
}

export interface HandlerOptions {
  store: Store;
  // The configured port, captured at startup. Host/Origin checks and env blocks use it.
  port: number;
  // Serves the dashboard HTML and its generated assets, after the gate has passed.
  assets: (req: Request) => Response | Promise<Response>;
  // Switches the public listener between loopback-only and dual-stack. Synchronous; throws
  // ListenerError when the new binding fails.
  rebind: (remoteEnabled: boolean) => void;
  publish: (message: string) => void;
  // Called when the listener no longer matches the stored hosts and could not be fixed in
  // process. Production exits so launchd starts a clean collector.
  onFatal?: (message: string) => void;
  now?: () => number;
  tailscaleAddress?: () => string | null;
}

export type Handler = (req: Request, server: PeerServer) => Response | undefined | Promise<Response | undefined>;

const INGEST_PATHS: Record<string, Signal> = { "/v1/logs": "logs", "/v1/traces": "traces", "/v1/metrics": "metrics" };
const LAST_SEEN_THROTTLE_MS = 60_000;
const NO_STORE = { "cache-control": "no-store" };

// First IPv4 address in Tailscale's 100.64.0.0/10 on this Mac's interfaces.
export function findTailscaleAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && classifyPeer(nic.address) === "tailscale") return nic.address;
    }
  }
  return null;
}

const notFound = () => new Response("Not Found", { status: 404 });
const forbidden = () => new Response("Forbidden", { status: 403 });
const jsonError = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });

async function readOtlp(req: Request, signal: Signal): Promise<any> {
  let bytes = new Uint8Array(await req.arrayBuffer());
  if (req.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
  if ((req.headers.get("content-type") ?? "").includes("protobuf")) return decodeOtlp(signal, bytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function windowFrom(url: URL): number {
  const raw = Number(url.searchParams.get("minutes") ?? 60);
  const minutes = Number.isFinite(raw) ? raw : 60;
  return Math.min(Math.max(minutes, 5), 14 * 24 * 60) * 60_000;
}

// Spans correlate to events by timestamp, not by prompt.id (spans carry no prompt id at all),
// so a turn's own spans are fetched by session and a time pad around its bounds rather than an
// exact window: a span's clock can lag or lead the log event it matches by a little.
const SPAN_PAD_MS = 15_000;

// Session metadata is cheap but not free (it walks events + the filesystem per path), so a
// memo avoids recomputing it for every row of an /api/item or /api/turns response. A session's
// kind, repo and branch barely change once it has a few events, so the memo can live far longer
// than a single request: 5 minutes keeps a hooks/turns query over hundreds of distinct sessions
// from recomputing all of them from scratch on every poll. Bounded well past 14 days' worth of
// sessions at the collector's own retention (~180/day) so a wide window never evicts mid-request.
const SESSION_MEMO_MS = 5 * 60_000;
const SESSION_CACHE_MAX = 4000;

interface Recent {
  id: number;
  tsMs: number;
  ms: number;
  ok: boolean;
  sessionId: string | null;
  repo: string | null;
  detail: string | null;
  promptId: string | null;
  sessionKind: "interactive" | "headless" | null;
  sessionLabel: string | null;
  branch: string | null;
  hooks: HookCall | null;
  folder: string | null;
  worktree: boolean;
}

export function createHandler(opts: HandlerOptions): Handler {
  const { store, port } = opts;
  const now = opts.now ?? Date.now;
  const tailscaleAddress = opts.tailscaleAddress ?? findTailscaleAddress;

  // Host blocks DNS rebinding: a page on some other domain cannot point a victim's browser
  // at 127.0.0.1 and have it talk to us, because the browser still sends that domain as Host.
  const OWN_HOSTS = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const OWN_ORIGINS = OWN_HOSTS.map((h) => `http://${h}`);
  const isOwnHost = (req: Request) => OWN_HOSTS.includes(req.headers.get("host") ?? "");
  // Writes (settings, hosts) also need our own Origin and a JSON body, which blocks
  // cross-site form posts.
  const isOwnPage = (req: Request) =>
    isOwnHost(req) && OWN_ORIGINS.includes(req.headers.get("origin") ?? "") && (req.headers.get("content-type") ?? "").includes("application/json");
  // Browsers always send Origin on a WebSocket, so a foreign one means another site's page.
  // Non-browser clients send none and get the same Host check as the GET endpoints.
  const isOwnSocket = (req: Request) => {
    const origin = req.headers.get("origin");
    return isOwnHost(req) && (origin === null || OWN_ORIGINS.includes(origin));
  };

  const sessionCache = new BoundedCache<SessionInfo | null>(SESSION_CACHE_MAX, SESSION_MEMO_MS);
  // Last last_seen write per host, so a busy host writes at most once a minute.
  const lastSeenWrites = new Map<string, number>();

  function sessionInfoFor(ctx: HostContext, sessionId: string): SessionInfo | null {
    const key = `${ctx.id}\u0000${sessionId}`;
    const cached = sessionCache.get(key);
    if (cached !== undefined) return cached;
    const info = buildSessionInfo(sessionId, store.sessionEventsByNames(sessionId, SESSION_EVENT_NAMES, ctx.id), ctx);
    sessionCache.set(key, info);
    return info;
  }

  const repoFor = (ctx: HostContext, sessionId: string | null) => (sessionId ? (sessionInfoFor(ctx, sessionId)?.repo ?? null) : null);
  const sessionKindFor = (ctx: HostContext, sessionId: string | null) => (sessionId ? (sessionInfoFor(ctx, sessionId)?.kind ?? null) : null);

  // The repo an individual call touched, falling back to the session's dominant repo only
  // when the call itself has no resolvable path (e.g. a hook, or a tool with no file/command).
  function repoForEvent(ctx: HostContext, e: EventRow): RepoInfo | null {
    if (!ctx.mayReadDisk) return null;
    for (const p of extractPaths(e.attrs, ctx.home)) {
      const repo = gitRoot(p);
      if (repo) return repo;
    }
    return repoFor(ctx, e.sessionId);
  }

  // Folder and worktree "as of" a moment. Local: the repo active then. Remote: no repo lookup,
  // so the call's own path as sent, else the session's last path at that moment.
  function placeAsOf(ctx: HostContext, info: SessionInfo | null, tsMs: number, promptId: string | null, ownPath: string | null) {
    if (!ctx.mayReadDisk) return { folder: ownPath ?? (info ? pathAsOf(info, tsMs, promptId) : null), worktree: false };
    const repo = info ? repoAsOf(info, tsMs, promptId) : null;
    return { folder: folderFor(ctx, repo), worktree: repo?.worktree != null };
  }

  // A repo's worktree path (falling back to its root) with $HOME shortened to "~", for display.
  function folderFor(ctx: HostContext, repo: RepoInfo | null): string | null {
    if (!repo) return null;
    const path = repo.worktree ?? repo.root;
    const home = ctx.home;
    if (!home) return path;
    return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  function summaryFor(ctx: HostContext, windowMs: number) {
    const since = now() - windowMs;
    return summarize(store.events(since, ctx.id), store.spans(since, ctx.id), windowMs);
  }

  function recentLive(ctx: HostContext, limit: number) {
    return store
      .events(now() - 3600_000, ctx.id)
      .map(liveEvent)
      .filter((e) => e !== null)
      .slice(-limit)
      .reverse();
  }

  function eventDetail(ctx: HostContext, url: URL) {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) return notFound();
    const row = store.event(id, ctx.id);
    if (!row) return notFound();
    const live = liveEvent(row);
    return Response.json({
      id: row.id,
      tsMs: row.tsMs,
      name: row.name,
      kind: live?.kind ?? row.name,
      label: live?.label ?? row.name,
      ms: live?.ms ?? null,
      ok: live?.ok ?? true,
      sessionId: row.sessionId,
      promptId: row.promptId,
      details: eventDetails(row),
      session: row.sessionId ? sessionInfoFor(ctx, row.sessionId) : null,
    });
  }

  function toRecent(ctx: HostContext, kind: ItemKind, e: EventRow): Recent {
    const info = e.sessionId ? sessionInfoFor(ctx, e.sessionId) : null;
    const repo = repoForEvent(ctx, e);
    // folder/worktree/branch are "as of this call": the repo and branch active at its own
    // timestamp, not the session's all-time dominant one a long session can have since moved on
    // from (e.g. a hook call logged after the session's work already shifted to another repo).
    const place = placeAsOf(ctx, info, e.tsMs, e.promptId, ctx.mayReadDisk ? null : (extractPaths(e.attrs, ctx.home)[0] ?? null));
    return {
      id: e.id as number,
      tsMs: e.tsMs,
      ms: itemDurationMs(kind, e.attrs),
      ok: !itemFailed(kind, e.attrs),
      sessionId: e.sessionId,
      repo: repo?.name ?? null,
      detail: itemRecentDetail(kind, e.attrs),
      promptId: e.promptId,
      sessionKind: info?.kind ?? null,
      sessionLabel: info?.kindLabel ?? null,
      branch: info ? branchAsOf(info, e.tsMs, e.promptId) : null,
      hooks: kind === "hooks" ? hookCallFromAttrs(e.attrs) : null,
      folder: place.folder,
      worktree: place.worktree,
    };
  }

  function itemDetail(ctx: HostContext, url: URL) {
    const kindParam = url.searchParams.get("kind");
    // `in` also matches Object.prototype members (toString, etc), so check own properties only.
    if (!kindParam || !Object.hasOwn(ITEM_EVENT_NAMES, kindParam)) return new Response("Bad Request", { status: 400 });
    const kind = kindParam as ItemKind;
    const name = url.searchParams.get("name") ?? "";
    const excludeHeadless = url.searchParams.get("excludeHeadless") === "1";

    const since = now() - windowFrom(url);
    // Hooks share one event name, so SQL narrows to the label first and skips parsing the rest.
    // The exact filter below still runs, so a loose SQL match costs speed, never correctness.
    const candidates = kind === "hooks" ? store.hookEventsByLabel(since, name, ctx.id) : store.eventsByName(since, ITEM_EVENT_NAMES[kind], ctx.id);
    const allRows = candidates.filter((e) => itemKey(kind, e.attrs) === name);

    const headlessCount = allRows.filter((e) => sessionKindFor(ctx, e.sessionId) === "headless").length;
    const rows = excludeHeadless ? allRows.filter((e) => sessionKindFor(ctx, e.sessionId) !== "headless") : allRows;

    const durations = rows.map((e) => itemDurationMs(kind, e.attrs)).sort((a, b) => a - b);
    const failures = rows.filter((e) => itemFailed(kind, e.attrs)).length;

    const repoBuckets = new Map<string, { name: string | null; root: string | null; label: string; count: number; totalMs: number; durations: number[] }>();
    for (const e of rows) {
      const repo = repoForEvent(ctx, e);
      const sessionKind = sessionKindFor(ctx, e.sessionId);
      const key = repo?.root ?? `unknown:${sessionKind ?? "interactive"}`;
      let bucket = repoBuckets.get(key);
      if (!bucket) {
        const label = repo ? repo.name : sessionKind === "headless" ? "No repo · headless SDK sessions" : "No repo · interactive sessions";
        bucket = { name: repo?.name ?? null, root: repo?.root ?? null, label, count: 0, totalMs: 0, durations: [] };
        repoBuckets.set(key, bucket);
      }
      const ms = itemDurationMs(kind, e.attrs);
      bucket.count++;
      bucket.totalMs += ms;
      bucket.durations.push(ms);
    }
    const repos = [...repoBuckets.values()]
      .map((b) => ({ name: b.name, root: b.root, label: b.label, count: b.count, totalMs: b.totalMs, p95: percentile([...b.durations].sort((a, c) => a - c), 95) }))
      .sort((a, b) => b.totalMs - a.totalMs);

    const sortedRecent = [...rows].sort((a, b) => b.tsMs - a.tsMs);
    const recent = sortedRecent.slice(0, 10).map((e) => toRecent(ctx, kind, e));
    const failed = sortedRecent
      .filter((e) => itemFailed(kind, e.attrs))
      .slice(0, 10)
      .map((e) => toRecent(ctx, kind, e));

    const definitions: HookDefinition[] =
      kind === "hooks"
        ? buildHookDefinitions(
            name,
            store.eventsByNameForSessions("hook_registered", [...new Set(rows.map((e) => e.sessionId).filter((s): s is string => s !== null))], ctx.id),
            (sessionId) => repoFor(ctx, sessionId)?.root ?? null,
            ctx,
          )
        : [];

    return Response.json({
      kind,
      name,
      count: rows.length,
      failures,
      totalMs: durations.reduce((a, b) => a + b, 0),
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      maxMs: durations.at(-1) ?? 0,
      headlessCount,
      repos,
      recent,
      failed,
      definitions,
    });
  }

  function turnsList(ctx: HostContext, url: URL) {
    const since = now() - windowFrom(url);
    const excludeHeadless = url.searchParams.get("excludeHeadless") === "1";
    const sort = url.searchParams.get("sort") === "slowest" ? "slowest" : "recent";
    const limitRaw = Number(url.searchParams.get("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 50);

    const breakdowns = [...promptBreakdowns(store.events(since, ctx.id)).values()];
    const filtered = excludeHeadless ? breakdowns.filter((p) => sessionKindFor(ctx, p.sessionId) !== "headless") : breakdowns;
    // "Slowest" ranks active time, not wall clock: a turn that sat idle for an hour and then
    // did 2 minutes of real work is not slower than one that ran busy for 10 minutes straight.
    const sorted = filtered.sort((a, b) => (sort === "slowest" ? b.activeMs - a.activeMs : b.startMs - a.startMs));
    const nowMs = now();

    const turns = sorted.slice(0, limit).map((p) => {
      const repo = repoFor(ctx, p.sessionId);
      const info = p.sessionId ? sessionInfoFor(ctx, p.sessionId) : null;
      // "As of the call": the repo/branch active when the turn began, not the session's all-time
      // dominant one (see toRecent's comment on repoAsOf/branchAsOf).
      const place = placeAsOf(ctx, info, p.startMs, p.promptId, null);
      return {
        promptId: p.promptId,
        startMs: p.startMs,
        endMs: p.endMs,
        wallMs: p.wallMs,
        activeMs: p.activeMs,
        idleMs: p.idleMs,
        inProgress: nowMs - p.endMs < 15_000,
        sessionId: p.sessionId,
        sessionKind: sessionKindFor(ctx, p.sessionId),
        sessionLabel: info?.kindLabel ?? null,
        repo: repo?.name ?? null,
        folder: place.folder,
        command: p.command,
        apiMs: p.apiMs,
        toolMs: p.toolMs,
        hookMs: p.hookMs,
      };
    });
    return Response.json(turns);
  }

  function turnDetail(ctx: HostContext, url: URL) {
    const events = store.promptEvents(url.searchParams.get("prompt"), ctx.id);
    const timeline = turnTimeline(events);
    if (!timeline) return Response.json(null);
    const info = timeline.sessionId ? sessionInfoFor(ctx, timeline.sessionId) : null;
    const { gaps, activeMs, idleMs } = idleGaps(events, timeline.startMs, timeline.endMs);
    const spans = timeline.sessionId ? store.spansForSession(timeline.sessionId, timeline.startMs - SPAN_PAD_MS, timeline.endMs + SPAN_PAD_MS, ctx.id) : [];
    const { lanes, rows, breakdown } = buildTurnRows(events, spans);
    // "As of the call": the repo/branch active when the turn began, not the session's all-time
    // dominant one (see toRecent's comment on repoAsOf/branchAsOf).
    const place = placeAsOf(ctx, info, timeline.startMs, timeline.promptId, null);
    return Response.json({
      ...timeline,
      sessionId: timeline.sessionId,
      sessionKind: info?.kind ?? null,
      sessionLabel: info?.kindLabel ?? null,
      repo: info?.repo?.name ?? null,
      folder: place.folder,
      branch: info ? branchAsOf(info, timeline.startMs, timeline.promptId) : null,
      gaps,
      activeMs,
      idleMs,
      breakdown,
      lanes,
      rows,
    });
  }

  const READS: Record<string, (ctx: HostContext, url: URL) => Response> = {
    "/api/summary": (ctx, url) => Response.json(summaryFor(ctx, windowFrom(url))),
    "/api/status": (ctx) => Response.json(status(summaryFor(ctx, 15 * 60_000))),
    "/api/live": (ctx) => Response.json(recentLive(ctx, 60)),
    "/api/turn": turnDetail,
    "/api/turns": turnsList,
    "/api/event": eventDetail,
    "/api/item": itemDetail,
  };

  // The selected host, resolved before any telemetry query. Unknown ids never reach SQL.
  function resolveHost(url: URL): HostContext | null {
    const id = url.searchParams.get("host") ?? LOCAL_HOST_ID;
    if (id === LOCAL_HOST_ID) return hostContext(id);
    return store.host(id) ? hostContext(id) : null;
  }

  // Push new events to open dashboards so they update without polling.
  function broadcast(hostId: string, rows: EventRow[]) {
    const events = rows.map(liveEvent).filter((e) => e !== null);
    opts.publish(JSON.stringify({ type: "events", host: hostId, events, changed: rows.length }));
  }

  function noteSeen(hostId: string) {
    if (hostId === LOCAL_HOST_ID) return;
    const t = now();
    const last = lastSeenWrites.get(hostId);
    if (last !== undefined && t - last < LAST_SEEN_THROTTLE_MS) return;
    store.touchHost(hostId, t);
    lastSeenWrites.set(hostId, t);
  }

  async function ingest(req: Request, server: PeerServer, signal: Signal) {
    const address = server.requestIP(req)?.address ?? null;
    const authorization = req.headers.get("authorization");
    const first = authorizeIngest(address, authorization, store);
    if (first instanceof Response) return first;
    let body: any;
    try {
      body = await readOtlp(req, signal);
    } catch (err) {
      console.error("ingest failed:", err);
      return new Response(String(err), { status: 400 });
    }
    // The body can take a while to arrive. Check the token again right before the synchronous
    // save, so a token rotated or a host removed in the meantime stores nothing.
    const auth = authorizeIngest(address, authorization, store);
    if (auth instanceof Response) return auth;
    if (auth.hostId !== first.hostId) return jsonError(401, "invalid token");
    try {
      if (signal === "logs") {
        const rows = parseLogs(body);
        store.addEvents(rows, auth.hostId);
        noteSeen(auth.hostId);
        broadcast(auth.hostId, rows);
      } else if (signal === "traces") {
        store.addSpans(parseTraces(body), auth.hostId);
        noteSeen(auth.hostId);
      } else {
        store.addMetrics(parseMetrics(body), auth.hostId);
        noteSeen(auth.hostId);
      }
      return Response.json({});
    } catch (err) {
      console.error("ingest failed:", err);
      return new Response(String(err), { status: 400 });
    }
  }

  function setup(req: Request) {
    // Always this Mac's own settings, whatever host a client has selected.
    const wanted = telemetryEnv(port);
    if (req.method === "GET") return Response.json(planEnv(settingsPath(), wanted));
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!isOwnPage(req)) return forbidden();
    try {
      const result = applyEnv(settingsPath(), wanted);
      console.log(`settings: added ${result.added.join(", ") || "nothing"}${result.backup ? `, backup ${result.backup}` : ""}`);
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 409 });
    }
  }

  function credentials(host: HostCredentials["host"], token: string, status: number) {
    const address = tailscaleAddress();
    const endpoint = `http://${address ?? "<THIS_MAC_TAILSCALE_IP>"}:${port}`;
    const body: HostCredentials = { host, token, env: telemetryEnv(endpoint, `Authorization=Bearer ${token}`), tailscaleAddress: address };
    return Response.json(body, { status, headers: NO_STORE });
  }

  const listenerLost = (message: string) => {
    console.error(`collector: ${message}`);
    opts.onFatal?.(message);
    return jsonError(500, "the collector could not restore its listener; restart it");
  };

  // A host mutation and the listener change it needs succeed or fail together.
  function withListener(mutate: (rebind: (remoteEnabled: boolean) => void) => Response): Response {
    let movedTo: boolean | null = null;
    const rebind = (remoteEnabled: boolean) => {
      opts.rebind(remoteEnabled);
      movedTo = remoteEnabled;
    };
    try {
      return store.db.transaction(() => mutate(rebind))();
    } catch (err) {
      // The data rolled back (anything up to and including COMMIT can fail) after the listener
      // already moved. Put it back so it matches the hosts that are actually stored.
      if (movedTo !== null) {
        try {
          opts.rebind(!movedTo);
        } catch (restoreErr) {
          return listenerLost(`${(err as Error).message}; then could not move the listener back: ${(restoreErr as Error).message}`);
        }
      }
      if (err instanceof ListenerError) {
        if (!err.restored) return listenerLost(err.message);
        console.error(`collector: ${err.message}`);
        return jsonError(503, "could not change the collector's listening address; nothing was changed");
      }
      throw err;
    }
  }

  function validName(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const name = raw.trim();
    if (name.length < 1 || name.length > 80) return null;
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
    return name;
  }

  async function createHostRoute(req: Request) {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "body must be JSON");
    }
    const name = validName(body?.name);
    if (name === null) return jsonError(400, "name must be 1 to 80 characters with no control characters");
    if (name === LOCAL_HOST.name || store.hosts().some((h) => h.name === name)) return jsonError(409, "a host with that name already exists");
    const token = createToken();
    return withListener((rebind) => {
      const wasEmpty = store.hosts().length === 0;
      const host = store.createHost(name, hashToken(token), now());
      if (wasEmpty) rebind(true);
      return credentials(host, token, 201);
    });
  }

  function rotateRoute(id: string) {
    const host = id === LOCAL_HOST_ID ? null : store.host(id);
    if (!host) return jsonError(404, "unknown host");
    const token = createToken();
    if (!store.rotateHostToken(id, hashToken(token))) return jsonError(404, "unknown host");
    return credentials(host, token, 200);
  }

  function deleteRoute(id: string) {
    if (id === LOCAL_HOST_ID || !store.host(id)) return jsonError(404, "unknown host");
    const res = withListener((rebind) => {
      store.removeHost(id);
      if (store.hosts().length === 0) rebind(false);
      return new Response(null, { status: 204, headers: NO_STORE });
    });
    if (res.status === 204) {
      lastSeenWrites.delete(id);
      sessionCache.clear();
    }
    return res;
  }

  function hostsRoute(req: Request, path: string): Response | Promise<Response> {
    if (path === "/api/hosts") {
      if (req.method === "GET") {
        if (!isOwnHost(req)) return forbidden();
        return Response.json([LOCAL_HOST, ...store.hosts()], { headers: NO_STORE });
      }
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!isOwnPage(req)) return forbidden();
      return createHostRoute(req);
    }
    const token = path.match(/^\/api\/hosts\/([^/]+)\/token$/);
    if (token) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!isOwnPage(req)) return forbidden();
      return rotateRoute(decodeURIComponent(token[1]!));
    }
    const one = path.match(/^\/api\/hosts\/([^/]+)$/);
    if (one) {
      if (req.method !== "DELETE") return new Response("Method Not Allowed", { status: 405 });
      if (!isOwnPage(req)) return forbidden();
      return deleteRoute(decodeURIComponent(one[1]!));
    }
    return notFound();
  }

  return (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const signal = INGEST_PATHS[path];
    if (signal && req.method === "POST") return ingest(req, server, signal);

    // Everything else is for this Mac only. Host and Origin are client-supplied, so the socket
    // peer is the gate and they are a second layer against DNS rebinding.
    if (classifyPeer(server.requestIP(req)?.address ?? null) !== "loopback") return forbidden();

    if (signal) return new Response("Method Not Allowed", { status: 405 });
    const read = READS[path];
    if (read) {
      if (!isOwnHost(req)) return forbidden();
      const ctx = resolveHost(url);
      if (!ctx) return jsonError(404, "unknown host");
      return read(ctx, url);
    }
    if (path === "/api/setup") {
      if (req.method === "GET" && !isOwnHost(req)) return forbidden();
      return setup(req);
    }
    if (path === "/api/hosts" || path.startsWith("/api/hosts/")) return hostsRoute(req, path);
    if (path === "/ws") {
      if (!isOwnSocket(req)) return forbidden();
      return server.upgrade(req) ? undefined : new Response("WebSocket upgrade required", { status: 426 });
    }
    if (!isOwnHost(req)) return forbidden();
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    return opts.assets(req);
  };
}
