import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import dashboard from "@cpa/dashboard/index.html";
import { openStore } from "./db";
import { decodeOtlp, parseLogs, parseMetrics, parseTraces, type EventRow, type Signal } from "@cpa/otlp";
import {
  eventDetails,
  extractPaths,
  itemDurationMs,
  itemFailed,
  itemKey,
  itemRecentDetail,
  liveEvent,
  percentile,
  status,
  summarize,
  turnTimeline,
  type ItemKind,
  ITEM_EVENT_NAMES,
} from "@cpa/analytics";
import { applyEnv, planEnv, settingsPath, telemetryEnv } from "@cpa/claude-settings";
import { BoundedCache } from "./bounded-cache";
import { gitRoot, type RepoInfo } from "./repos";
import { buildSessionInfo, SESSION_EVENT_NAMES, type SessionInfo } from "./sessions";

const HOME = homedir();

const PORT = Number(process.env.PORT ?? 4318);
const DATA_DIR = process.env.CC_TELEMETRY_DIR ?? `${HOME}/.claude-telemetry`;
const RETENTION_MS = 14 * 24 * 3600_000;

mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(`${DATA_DIR}/telemetry.sqlite`);
store.prune(Date.now() - RETENTION_MS);
setInterval(() => store.prune(Date.now() - RETENTION_MS), 3600_000);

async function readOtlp(req: Request, signal: Signal): Promise<any> {
  let bytes = new Uint8Array(await req.arrayBuffer());
  if (req.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
  if ((req.headers.get("content-type") ?? "").includes("protobuf")) return decodeOtlp(signal, bytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function ingest<T>(signal: Signal, parse: (b: any) => T[], save: (rows: T[]) => void, onSaved?: (rows: T[]) => void) {
  return async (req: Request) => {
    try {
      const rows = parse(await readOtlp(req, signal));
      save(rows);
      onSaved?.(rows);
      return Response.json({});
    } catch (err) {
      console.error("ingest failed:", err);
      return new Response(String(err), { status: 400 });
    }
  };
}

function windowFrom(url: URL): number {
  const raw = Number(url.searchParams.get("minutes") ?? 60);
  const minutes = Number.isFinite(raw) ? raw : 60;
  return Math.min(Math.max(minutes, 5), 14 * 24 * 60) * 60_000;
}

function summaryFor(windowMs: number) {
  const since = Date.now() - windowMs;
  return summarize(store.events(since), store.spans(since), windowMs);
}

// Push new events to open dashboards so they update without polling.
function broadcast(rows: EventRow[]) {
  const events = rows.map(liveEvent).filter((e) => e !== null);
  server.publish("live", JSON.stringify({ type: "events", events, changed: rows.length }));
}

function recentLive(limit: number) {
  return store
    .events(Date.now() - 3600_000)
    .map(liveEvent)
    .filter((e) => e !== null)
    .slice(-limit)
    .reverse();
}

// Session metadata is cheap but not free (it walks events + the filesystem per path), so a
// short memo avoids recomputing it for every row of an /api/item response. Bounded so a
// long-running collector does not grow this map forever as new sessions show up.
const SESSION_MEMO_MS = 10_000;
const SESSION_CACHE_MAX = 500;
const sessionCache = new BoundedCache<SessionInfo | null>(SESSION_CACHE_MAX, SESSION_MEMO_MS);
function sessionInfoFor(sessionId: string): SessionInfo | null {
  const cached = sessionCache.get(sessionId);
  if (cached !== undefined) return cached;
  const info = buildSessionInfo(sessionId, store.sessionEventsByNames(sessionId, SESSION_EVENT_NAMES), HOME);
  sessionCache.set(sessionId, info);
  return info;
}

function repoFor(sessionId: string | null) {
  return sessionId ? (sessionInfoFor(sessionId)?.repo ?? null) : null;
}

// The repo an individual call touched, falling back to the session's dominant repo only
// when the call itself has no resolvable path (e.g. a hook, or a tool with no file/command).
function repoForEvent(e: EventRow): RepoInfo | null {
  for (const p of extractPaths(e.attrs, HOME)) {
    const repo = gitRoot(p);
    if (repo) return repo;
  }
  return repoFor(e.sessionId);
}

function eventDetail(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return new Response("Not Found", { status: 404 });
  const row = store.event(id);
  if (!row) return new Response("Not Found", { status: 404 });

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
    session: row.sessionId ? sessionInfoFor(row.sessionId) : null,
  });
}

function itemDetail(req: Request) {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  // `in` also matches Object.prototype members (toString, etc), so check own properties only.
  if (!kindParam || !Object.hasOwn(ITEM_EVENT_NAMES, kindParam)) return new Response("Bad Request", { status: 400 });
  const kind = kindParam as ItemKind;
  const name = url.searchParams.get("name") ?? "";

  const since = Date.now() - windowFrom(url);
  const eventName = ITEM_EVENT_NAMES[kind];
  const rows = store.eventsByName(since, eventName).filter((e) => itemKey(kind, e.attrs) === name);

  const durations = rows.map((e) => itemDurationMs(kind, e.attrs)).sort((a, b) => a - b);
  const failures = rows.filter((e) => itemFailed(kind, e.attrs)).length;

  const repoBuckets = new Map<string, { name: string | null; root: string | null; count: number; totalMs: number; durations: number[] }>();
  for (const e of rows) {
    const repo = repoForEvent(e);
    const key = repo?.root ?? "unknown";
    let bucket = repoBuckets.get(key);
    if (!bucket) {
      bucket = { name: repo?.name ?? null, root: repo?.root ?? null, count: 0, totalMs: 0, durations: [] };
      repoBuckets.set(key, bucket);
    }
    const ms = itemDurationMs(kind, e.attrs);
    bucket.count++;
    bucket.totalMs += ms;
    bucket.durations.push(ms);
  }
  const repos = [...repoBuckets.values()]
    .map((b) => ({ name: b.name, root: b.root, count: b.count, totalMs: b.totalMs, p95: percentile([...b.durations].sort((a, c) => a - c), 95) }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const recent = [...rows]
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 10)
    .map((e) => ({
      id: e.id as number,
      tsMs: e.tsMs,
      ms: itemDurationMs(kind, e.attrs),
      ok: !itemFailed(kind, e.attrs),
      sessionId: e.sessionId,
      repo: repoForEvent(e)?.name ?? null,
      detail: itemRecentDetail(kind, e.attrs),
    }));

  return Response.json({
    kind,
    name,
    count: rows.length,
    failures,
    totalMs: durations.reduce((a, b) => a + b, 0),
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    maxMs: durations.at(-1) ?? 0,
    repos,
    recent,
  });
}

// Host blocks DNS rebinding: a page on some other domain cannot point a victim's browser
// at 127.0.0.1 and have it talk to us, because the browser still sends that domain as Host.
const OWN_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];

function isOwnHost(req: Request): boolean {
  return OWN_HOSTS.includes(req.headers.get("host") ?? "");
}

// The setup endpoint writes user settings, so only our own page may call it.
// Origin (on top of Host) blocks cross-site form posts.
function isOwnPage(req: Request): boolean {
  const origin = req.headers.get("origin") ?? "";
  return isOwnHost(req) && OWN_HOSTS.some((h) => origin === `http://${h}`) && (req.headers.get("content-type") ?? "").includes("application/json");
}

function setup(req: Request) {
  const wanted = telemetryEnv(PORT);
  if (req.method === "GET") return Response.json(planEnv(settingsPath(), wanted));
  if (!isOwnPage(req)) return new Response("Forbidden", { status: 403 });
  try {
    const result = applyEnv(settingsPath(), wanted);
    console.log(`settings: added ${result.added.join(", ") || "nothing"}${result.backup ? `, backup ${result.backup}` : ""}`);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}

// GET endpoints read telemetry (including file paths and repo names), so they get the same
// Host check as setup, without requiring an Origin header a same-origin GET never sends.
function guarded<T extends (req: Request) => Response | Promise<Response>>(handler: T) {
  return (req: Request) => (isOwnHost(req) ? handler(req) : new Response("Forbidden", { status: 403 }));
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/": dashboard,
    "/v1/logs": { POST: ingest("logs", parseLogs, store.addEvents, broadcast) },
    "/v1/traces": { POST: ingest("traces", parseTraces, store.addSpans) },
    "/v1/metrics": { POST: ingest("metrics", parseMetrics, store.addMetrics) },
    "/api/summary": guarded((req) => Response.json(summaryFor(windowFrom(new URL(req.url))))),
    "/api/status": guarded(() => Response.json(status(summaryFor(15 * 60_000)))),
    "/api/live": guarded(() => Response.json(recentLive(60))),
    "/api/turn": guarded((req) => Response.json(turnTimeline(store.promptEvents(new URL(req.url).searchParams.get("prompt"))))),
    "/api/event": guarded(eventDetail),
    "/api/item": guarded(itemDetail),
    "/api/setup": { GET: guarded(setup), POST: setup },
    "/ws": (req, srv) => (srv.upgrade(req) ? undefined : new Response("WebSocket upgrade required", { status: 426 })),
  },
  websocket: {
    open: (ws) => {
      ws.subscribe("live");
    },
    message: () => {},
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: false, console: true } : false,
});

console.log(`claude telemetry collector on ${server.url} (data: ${DATA_DIR})`);
