import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "cc-hoststore-")), "t.sqlite");

// The schema as it shipped before hosts existed, with positional rows and known rowids.
function legacyDatabase(path: string) {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE events (ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, prompt_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX events_ts ON events (ts_ms)");
  db.run("CREATE INDEX events_prompt ON events (prompt_id, ts_ms)");
  db.run("CREATE INDEX events_session ON events (session_id, ts_ms)");
  db.run(`CREATE TABLE spans (trace_id TEXT, span_id TEXT, parent_id TEXT, name TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_id TEXT, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX spans_start ON spans (start_ms)");
  db.run("CREATE INDEX spans_session ON spans (session_id, start_ms)");
  db.run(`CREATE TABLE metrics (ts_ms INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT, value REAL NOT NULL, attrs TEXT NOT NULL)`);
  db.run("CREATE INDEX metrics_ts ON metrics (ts_ms)");
  db.run("INSERT INTO events (rowid, ts_ms, name, session_id, prompt_id, attrs) VALUES (7, 1000, 'tool_result', 'old-s', 'old-p', '{\"tool_name\":\"Bash\"}')");
  db.run("INSERT INTO events (rowid, ts_ms, name, session_id, prompt_id, attrs) VALUES (9, 2000, 'user_prompt', 'old-s', 'old-p', '{\"marker\":\"legacy\"}')");
  db.run("INSERT INTO spans VALUES ('t1', 'sp1', NULL, 'claude_code.tool', 1000, 1010, 'old-s', '{\"a\":1}')");
  db.run("INSERT INTO metrics VALUES (1500, 'claude_code.cost.usage', 'old-s', 0.25, '{\"m\":1}')");
  db.close();
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function indexColumns(db: Database, table: string): string[][] {
  const indexes = db.query(`PRAGMA index_list(${table})`).all() as { name: string }[];
  return indexes.map((i) => (db.query(`PRAGMA index_info(${i.name})`).all() as { seqno: number; name: string }[]).sort((a, b) => a.seqno - b.seqno).map((c) => c.name));
}

test("migrating a legacy database keeps every row and rowid and tags them local, once", () => {
  const path = tmpPath();
  legacyDatabase(path);

  for (let open = 0; open < 2; open++) {
    const s = openStore(path);
    for (const table of ["events", "spans", "metrics"]) {
      expect(columns(s.db, table).filter((c) => c === "host_id")).toEqual(["host_id"]);
    }
    expect((s.db.query("PRAGMA user_version").get() as any).user_version).toBe(1);

    const events = s.db.query("SELECT rowid AS id, ts_ms, name, session_id, prompt_id, attrs, host_id FROM events ORDER BY rowid").all();
    expect(events).toEqual([
      { id: 7, ts_ms: 1000, name: "tool_result", session_id: "old-s", prompt_id: "old-p", attrs: '{"tool_name":"Bash"}', host_id: "local" },
      { id: 9, ts_ms: 2000, name: "user_prompt", session_id: "old-s", prompt_id: "old-p", attrs: '{"marker":"legacy"}', host_id: "local" },
    ]);
    expect(s.db.query("SELECT span_id, attrs, host_id FROM spans").all()).toEqual([{ span_id: "sp1", attrs: '{"a":1}', host_id: "local" }]);
    expect(s.db.query("SELECT value, attrs, host_id FROM metrics").all()).toEqual([{ value: 0.25, attrs: '{"m":1}', host_id: "local" }]);

    // Default arguments still read the legacy rows as the local host.
    expect(s.event(9)?.attrs).toEqual({ marker: "legacy" });
    expect(s.promptEvents(null).map((e) => e.id)).toEqual([7, 9]);
    expect(s.sessionEvents("old-s")).toHaveLength(2);
    s.db.close();
  }
});

test("time, prompt and session indexes lead with host_id", () => {
  const s = openStore(tmpPath());
  const events = indexColumns(s.db, "events");
  expect(events).toContainEqual(["host_id", "ts_ms"]);
  expect(events).toContainEqual(["host_id", "prompt_id", "ts_ms"]);
  expect(events).toContainEqual(["host_id", "session_id", "ts_ms"]);
  expect(indexColumns(s.db, "spans")).toContainEqual(["host_id", "start_ms"]);
  expect(indexColumns(s.db, "spans")).toContainEqual(["host_id", "session_id", "start_ms"]);
  expect(indexColumns(s.db, "metrics")).toContainEqual(["host_id", "ts_ms"]);
});

test("a failed migration leaves the legacy schema untouched", () => {
  const path = tmpPath();
  legacyDatabase(path);
  // A clashing index name makes the migration fail after the first ALTER has run.
  const raw = new Database(path);
  raw.run("CREATE TABLE blocker (x)");
  raw.run("CREATE INDEX metrics_host_ts ON blocker (x)");
  raw.close();
  expect(() => openStore(path)).toThrow();
  const after = new Database(path);
  expect(columns(after, "events")).not.toContain("host_id");
  expect(columns(after, "spans")).not.toContain("host_id");
  expect((after.query("PRAGMA user_version").get() as any).user_version).toBe(0);
  after.close();
});

test("every reader only returns the requested host's rows when ids collide", () => {
  const s = openStore(tmpPath());
  const now = Date.now();
  const rows = (marker: string) => [
    { tsMs: now - 3000, name: "user_prompt", sessionId: "S", promptId: "P", attrs: { marker } },
    { tsMs: now - 2000, name: "tool_result", sessionId: "S", promptId: "P", attrs: { marker, tool_name: "Bash" } },
    { tsMs: now - 1000, name: "hook_execution_complete", sessionId: "S", promptId: "P", attrs: { marker, hook_name: "Stop" } },
    { tsMs: now - 500, name: "hook_registered", sessionId: "S", promptId: null, attrs: { marker, hook_event: "Stop", hook_source: "userSettings" } },
  ];
  s.addEvents(rows("local"));
  s.addEvents(rows("remote"), "h1");
  // The remote host also owns the most recent prompt overall; local latest must still be P.
  s.addEvents([{ tsMs: now, name: "user_prompt", sessionId: "S2", promptId: "P-remote-latest", attrs: { marker: "remote" } }], "h1");
  const span = (marker: string) => ({ traceId: "T", spanId: "X", parentId: null, name: "claude_code.tool", startMs: now - 1500, endMs: now - 1400, sessionId: "S", attrs: { marker } });
  s.addSpans([span("local")]);
  s.addSpans([span("remote")], "h1");
  s.addMetrics([{ tsMs: now, name: "m", sessionId: "S", value: 1, attrs: { marker: "local" } }]);
  s.addMetrics([{ tsMs: now, name: "m", sessionId: "S", value: 2, attrs: { marker: "remote" } }], "h1");

  const markers = (list: { attrs: Record<string, unknown> }[]) => [...new Set(list.map((r) => r.attrs.marker))];
  const since = now - 60_000;
  for (const [host, marker] of [["local", "local"], ["h1", "remote"]] as const) {
    expect(markers(s.events(since, host))).toEqual([marker]);
    expect(markers(s.eventsByName(since, "tool_result", host))).toEqual([marker]);
    expect(markers(s.hookEventsByLabel(since, "Stop", host))).toEqual([marker]);
    expect(markers(s.promptEvents("P", host))).toEqual([marker]);
    expect(markers(s.sessionEvents("S", host))).toEqual([marker]);
    expect(markers(s.sessionEventsByNames("S", ["tool_result", "user_prompt"], host))).toEqual([marker]);
    expect(markers(s.eventsByNameForSessions("hook_registered", ["S"], host))).toEqual([marker]);
    expect(markers(s.spans(since, host))).toEqual([marker]);
    expect(markers(s.spansForSession("S", since, now + 1000, host))).toEqual([marker]);
  }
  expect(s.promptEvents(null).map((e) => e.promptId)).toEqual(["P", "P", "P"]);
  expect(s.promptEvents(null, "h1")[0]?.promptId).toBe("P-remote-latest");
  expect(s.promptEvents(null, "unknown-host")).toEqual([]);

  // Rowid lookups do not cross hosts either.
  const localId = s.events(since)[0]!.id!;
  const remoteId = s.events(since, "h1")[0]!.id!;
  expect(s.event(localId)?.attrs.marker).toBe("local");
  expect(s.event(remoteId)).toBeNull();
  expect(s.event(remoteId, "h1")?.attrs.marker).toBe("remote");
  expect(s.event(localId, "h1")).toBeNull();

  // Raw metrics carry the authenticated host too.
  expect(s.db.query("SELECT host_id, value FROM metrics ORDER BY value").all()).toEqual([
    { host_id: "local", value: 1 },
    { host_id: "h1", value: 2 },
  ]);
  // Defaults mean "local", and inserts never rely on column order.
  expect(s.db.query("SELECT host_id, COUNT(*) AS n FROM events GROUP BY host_id ORDER BY host_id").all()).toEqual([
    { host_id: "h1", n: 5 },
    { host_id: "local", n: 4 },
  ]);
});
