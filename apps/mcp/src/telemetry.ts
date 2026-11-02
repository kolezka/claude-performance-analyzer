// Read-only access to the collector's SQLite store, for hook timing and hook registrations.
// Opened with mode=ro so nothing here can write to the file the collector owns.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventRow } from "@cpa/otlp";

export function telemetryPath(): string {
  return join(process.env.CC_TELEMETRY_DIR ?? join(homedir(), ".claude-telemetry"), "telemetry.sqlite");
}

export type Telemetry = { ok: true; db: Database; path: string } | { ok: false; path: string; reason: string };

export function openTelemetry(path = telemetryPath()): Telemetry {
  if (!existsSync(path)) return { ok: false, path, reason: `no telemetry database at ${path} (is the collector installed and Claude Code telemetry on?)` };
  try {
    const db = new Database(`file:${path}?mode=ro`, { readonly: true });
    db.query("SELECT 1 FROM events LIMIT 1").get();
    return { ok: true, db, path };
  } catch (err) {
    return { ok: false, path, reason: `telemetry database at ${path} could not be read: ${(err as Error).message}` };
  }
}

export interface TelemetryFilter {
  sessionIds: string[] | null;
  sinceMs: number;
}

export interface HookFiring {
  tsMs: number;
  sessionId: string | null;
  promptId: string | null;
  label: string;
  hookEvent: string;
  durationMs: number;
  numHooks: number;
  errors: number;
  blocking: number;
  cancelled: number;
  contextChars: number;
}

function sessionClause(f: TelemetryFilter): { sql: string; params: string[] } {
  if (f.sessionIds === null) return { sql: "", params: [] };
  if (f.sessionIds.length === 0) return { sql: " AND 0", params: [] };
  return { sql: ` AND session_id IN (${f.sessionIds.map(() => "?").join(",")})`, params: f.sessionIds };
}

// One row per hook_execution_complete: all hooks of one event fire together, in parallel, so
// total_duration_ms is the wall time that firing added, not a per-script time.
export function hookFirings(db: Database, f: TelemetryFilter): HookFiring[] {
  const s = sessionClause(f);
  const rows = db
    .query(
      `SELECT ts_ms, session_id, prompt_id,
         COALESCE(json_extract(attrs, '$.hook_name'), json_extract(attrs, '$.hook_event'), 'unknown') AS label,
         COALESCE(json_extract(attrs, '$.hook_event'), '') AS hook_event,
         json_extract(attrs, '$.total_duration_ms') AS ms,
         json_extract(attrs, '$.num_hooks') AS num_hooks,
         json_extract(attrs, '$.num_non_blocking_error') AS errors,
         json_extract(attrs, '$.num_blocking') AS blocking,
         json_extract(attrs, '$.num_cancelled') AS cancelled,
         json_extract(attrs, '$.additional_context_chars') AS ctx
       FROM events WHERE name = 'hook_execution_complete' AND ts_ms >= ?${s.sql} ORDER BY ts_ms`,
    )
    .all(f.sinceMs, ...s.params) as any[];
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return rows.map((r) => ({
    tsMs: r.ts_ms,
    sessionId: r.session_id,
    promptId: r.prompt_id,
    label: String(r.label),
    hookEvent: String(r.hook_event),
    durationMs: n(r.ms),
    numHooks: n(r.num_hooks),
    errors: n(r.errors),
    blocking: n(r.blocking),
    cancelled: n(r.cancelled),
    contextChars: n(r.ctx),
  }));
}

export function hookRegistrations(db: Database, f: TelemetryFilter): EventRow[] {
  const s = sessionClause(f);
  return (
    db
      .query(`SELECT rowid AS id, ts_ms, name, session_id, prompt_id, attrs FROM events WHERE name = 'hook_registered' AND ts_ms >= ?${s.sql}`)
      .all(f.sinceMs, ...s.params) as any[]
  ).map((r) => ({ id: r.id, tsMs: r.ts_ms, name: r.name, sessionId: r.session_id, promptId: r.prompt_id, attrs: JSON.parse(r.attrs) }));
}

// Every event of the given sessions, for turn breakdowns (active time vs hook time).
export function sessionEvents(db: Database, sessionIds: string[]): EventRow[] {
  if (!sessionIds.length) return [];
  return (
    db
      .query(
        `SELECT rowid AS id, ts_ms, name, session_id, prompt_id, attrs FROM events WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY ts_ms`,
      )
      .all(...sessionIds) as any[]
  ).map((r) => ({ id: r.id, tsMs: r.ts_ms, name: r.name, sessionId: r.session_id, promptId: r.prompt_id, attrs: JSON.parse(r.attrs) }));
}
