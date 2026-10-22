import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { EventRow, MetricRow, SpanRow } from "@cpa/otlp";
import { LOCAL_HOST_ID, type Host } from "./hosts";

export type Store = ReturnType<typeof openStore>;

const SCHEMA_VERSION = 1;

// Version 1 partitions telemetry by host. Runs once, in one transaction: a failure part way
// leaves the old schema exactly as it was.
function migrate(db: Database) {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= SCHEMA_VERSION) return;
  db.transaction(() => {
    for (const table of ["events", "spans", "metrics"]) {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("host_id")) db.run(`ALTER TABLE ${table} ADD COLUMN host_id TEXT NOT NULL DEFAULT '${LOCAL_HOST_ID}'`);
    }
    db.run("CREATE INDEX events_host_ts ON events (host_id, ts_ms)");
    db.run("CREATE INDEX events_host_prompt ON events (host_id, prompt_id, ts_ms)");
    db.run("CREATE INDEX events_host_session ON events (host_id, session_id, ts_ms)");
    db.run("CREATE INDEX spans_host_start ON spans (host_id, start_ms)");
    db.run("CREATE INDEX spans_host_session ON spans (host_id, session_id, start_ms)");
    db.run("CREATE INDEX metrics_host_ts ON metrics (host_id, ts_ms)");
    db.run(`CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
      created_ms INTEGER NOT NULL, last_seen_ms INTEGER)`);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS events (
    ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, prompt_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS events_ts ON events (ts_ms)");
  db.run("CREATE INDEX IF NOT EXISTS events_prompt ON events (prompt_id, ts_ms)");
  db.run("CREATE INDEX IF NOT EXISTS events_session ON events (session_id, ts_ms)");
  db.run(`CREATE TABLE IF NOT EXISTS spans (
    trace_id TEXT, span_id TEXT, parent_id TEXT, name TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS spans_start ON spans (start_ms)");
  db.run("CREATE INDEX IF NOT EXISTS spans_session ON spans (session_id, start_ms)");
  db.run(`CREATE TABLE IF NOT EXISTS metrics (
    ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, value REAL NOT NULL, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS metrics_ts ON metrics (ts_ms)");
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  const insEvent = db.prepare("INSERT INTO events (ts_ms, name, session_id, prompt_id, attrs, host_id) VALUES (?, ?, ?, ?, ?, ?)");
  const insSpan = db.prepare(
    "INSERT INTO spans (trace_id, span_id, parent_id, name, start_ms, end_ms, session_id, attrs, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insMetric = db.prepare("INSERT INTO metrics (ts_ms, name, session_id, value, attrs, host_id) VALUES (?, ?, ?, ?, ?, ?)");

  const addEvents = db.transaction((rows: EventRow[], hostId: string = LOCAL_HOST_ID) => {
    for (const r of rows) insEvent.run(r.tsMs, r.name, r.sessionId, r.promptId, JSON.stringify(r.attrs), hostId);
  });
  const addSpans = db.transaction((rows: SpanRow[], hostId: string = LOCAL_HOST_ID) => {
    for (const r of rows)
      insSpan.run(r.traceId, r.spanId, r.parentId, r.name, r.startMs, r.endMs, r.sessionId, JSON.stringify(r.attrs), hostId);
  });
  const addMetrics = db.transaction((rows: MetricRow[], hostId: string = LOCAL_HOST_ID) => {
    for (const r of rows) insMetric.run(r.tsMs, r.name, r.sessionId, r.value, JSON.stringify(r.attrs), hostId);
  });

  const eventRow = (r: any): EventRow => ({
    id: r.id,
    tsMs: r.ts_ms,
    name: r.name,
    sessionId: r.session_id,
    promptId: r.prompt_id,
    attrs: JSON.parse(r.attrs),
  });
  const EVENT_COLUMNS = "rowid AS id, ts_ms, name, session_id, prompt_id, attrs";

  const spanRow = (r: any): SpanRow => ({
    traceId: r.trace_id,
    spanId: r.span_id,
    parentId: r.parent_id,
    name: r.name,
    startMs: r.start_ms,
    endMs: r.end_ms,
    sessionId: r.session_id,
    attrs: JSON.parse(r.attrs),
  });
  const SPAN_COLUMNS = "trace_id, span_id, parent_id, name, start_ms, end_ms, session_id, attrs";

  const hostRow = (r: any): Host => ({ id: r.id, name: r.name, createdMs: r.created_ms, lastSeenMs: r.last_seen_ms });
  const HOST_COLUMNS = "id, name, created_ms, last_seen_ms";

  const removeHost = db.transaction((id: string): boolean => {
    if (!db.query("SELECT 1 FROM hosts WHERE id = ?").get(id)) return false;
    db.run("DELETE FROM events WHERE host_id = ?", [id]);
    db.run("DELETE FROM spans WHERE host_id = ?", [id]);
    db.run("DELETE FROM metrics WHERE host_id = ?", [id]);
    db.run("DELETE FROM hosts WHERE id = ?", [id]);
    return true;
  });

  return {
    db,
    addEvents,
    addSpans,
    addMetrics,
    events(sinceMs: number, hostId: string = LOCAL_HOST_ID): EventRow[] {
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND ts_ms >= ? ORDER BY ts_ms`)
        .all(hostId, sinceMs)
        .map(eventRow);
    },
    // Same as events(), but filtered by event name in SQL so callers that only want one kind
    // (e.g. /api/item wants just tool_result rows) never load or parse the rest.
    eventsByName(sinceMs: number, name: string, hostId: string = LOCAL_HOST_ID): EventRow[] {
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND ts_ms >= ? AND name = ? ORDER BY ts_ms`)
        .all(hostId, sinceMs, name)
        .map(eventRow);
    },
    // hook_execution_complete rows whose hook label (hook_name, falling back to hook_event,
    // falling back to "unknown") equals `label`, matching hookLabel()'s own fallback exactly.
    // Every hook type shares the "hook_execution_complete" event name, so a 24h window can hold
    // many times more rows than match one label; json_extract() rejects the rest in SQLite
    // itself; a row that is not the label we want is never even JSON.parse'd into a JS object.
    hookEventsByLabel(sinceMs: number, label: string, hostId: string = LOCAL_HOST_ID): EventRow[] {
      return db
        .query(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE host_id = ? AND ts_ms >= ? AND name = 'hook_execution_complete'
           AND (
             json_extract(attrs, '$.hook_name') = ?
             OR (json_extract(attrs, '$.hook_name') IS NULL AND json_extract(attrs, '$.hook_event') = ?)
             OR (json_extract(attrs, '$.hook_name') IS NULL AND json_extract(attrs, '$.hook_event') IS NULL AND ? = 'unknown')
           )
           ORDER BY ts_ms`,
        )
        .all(hostId, sinceMs, label, label, label)
        .map(eventRow);
    },
    // Most recent prompt of this host when no id is given.
    promptEvents(promptId: string | null, hostId: string = LOCAL_HOST_ID): EventRow[] {
      const id =
        promptId ??
        (
          db
            .query("SELECT prompt_id FROM events WHERE host_id = ? AND prompt_id IS NOT NULL ORDER BY ts_ms DESC LIMIT 1")
            .get(hostId) as any
        )?.prompt_id;
      if (!id) return [];
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND prompt_id = ? ORDER BY ts_ms`)
        .all(hostId, id)
        .map(eventRow);
    },
    event(id: number, hostId: string = LOCAL_HOST_ID): EventRow | null {
      const r = db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE rowid = ? AND host_id = ?`).get(id, hostId) as any;
      return r ? eventRow(r) : null;
    },
    sessionEvents(sessionId: string, hostId: string = LOCAL_HOST_ID): EventRow[] {
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND session_id = ? ORDER BY ts_ms`)
        .all(hostId, sessionId)
        .map(eventRow);
    },
    // sessionEvents() restricted to the event names the caller actually needs, so a session
    // with a lot of hook/skill/mcp noise does not drag all of it in just to read 3 fields.
    sessionEventsByNames(sessionId: string, names: string[], hostId: string = LOCAL_HOST_ID): EventRow[] {
      if (names.length === 0) return [];
      const placeholders = names.map(() => "?").join(",");
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND session_id = ? AND name IN (${placeholders}) ORDER BY ts_ms`)
        .all(hostId, sessionId, ...names)
        .map(eventRow);
    },
    // One event name across several sessions, no time filter: hook_registered fires once at
    // session start, which can be well before the window an /api/item query is asking about.
    eventsByNameForSessions(name: string, sessionIds: string[], hostId: string = LOCAL_HOST_ID): EventRow[] {
      if (sessionIds.length === 0) return [];
      const placeholders = sessionIds.map(() => "?").join(",");
      return db
        .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE host_id = ? AND name = ? AND session_id IN (${placeholders}) ORDER BY ts_ms`)
        .all(hostId, name, ...sessionIds)
        .map(eventRow);
    },
    spans(sinceMs: number, hostId: string = LOCAL_HOST_ID): SpanRow[] {
      return db
        .query(`SELECT ${SPAN_COLUMNS} FROM spans WHERE host_id = ? AND start_ms >= ? ORDER BY start_ms`)
        .all(hostId, sinceMs)
        .map(spanRow);
    },
    // A turn's own spans: tool and llm_request spans carry the agent_id that groups a turn's
    // rows into lanes. Padded past the turn's own bounds, since a span's clock can lag or lead
    // the log event it correlates with by a little.
    spansForSession(sessionId: string, sinceMs: number, untilMs: number, hostId: string = LOCAL_HOST_ID): SpanRow[] {
      return db
        .query(`SELECT ${SPAN_COLUMNS} FROM spans WHERE host_id = ? AND session_id = ? AND start_ms >= ? AND start_ms <= ? ORDER BY start_ms`)
        .all(hostId, sessionId, sinceMs, untilMs)
        .map(spanRow);
    },
    // Retention is the same for every host, so this stays global.
    prune(olderThanMs: number) {
      db.run("DELETE FROM events WHERE ts_ms < ?", [olderThanMs]);
      db.run("DELETE FROM spans WHERE start_ms < ?", [olderThanMs]);
      db.run("DELETE FROM metrics WHERE ts_ms < ?", [olderThanMs]);
    },

    // Remote hosts in creation order. The local host has no row.
    hosts(): Host[] {
      return db.query(`SELECT ${HOST_COLUMNS} FROM hosts ORDER BY created_ms, rowid`).all().map(hostRow);
    },
    host(id: string): Host | null {
      const r = db.query(`SELECT ${HOST_COLUMNS} FROM hosts WHERE id = ?`).get(id);
      return r ? hostRow(r) : null;
    },
    // Throws on a duplicate name (UNIQUE); the caller maps that to a conflict.
    createHost(name: string, tokenHash: string, nowMs: number): Host {
      const id = crypto.randomUUID();
      db.run("INSERT INTO hosts (id, name, token_hash, created_ms, last_seen_ms) VALUES (?, ?, ?, ?, NULL)", [id, name, tokenHash, nowMs]);
      return { id, name, createdMs: nowMs, lastSeenMs: null };
    },
    rotateHostToken(id: string, tokenHash: string): boolean {
      return db.run("UPDATE hosts SET token_hash = ? WHERE id = ?", [tokenHash, id]).changes > 0;
    },
    removeHost: (id: string): boolean => removeHost(id),
    // Every stored hash is compared in constant time; there are only ever a handful of hosts.
    hostForTokenHash(hash: string): Host | null {
      const wanted = Buffer.from(hash, "hex");
      if (wanted.length !== 32) return null;
      let found: any = null;
      for (const r of db.query(`SELECT ${HOST_COLUMNS}, token_hash FROM hosts`).all() as any[]) {
        const stored = Buffer.from(r.token_hash, "hex");
        if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) found = r;
      }
      return found ? hostRow(found) : null;
    },
    touchHost(id: string, nowMs: number): void {
      db.run("UPDATE hosts SET last_seen_ms = ? WHERE id = ?", [nowMs, id]);
    },
  };
}
