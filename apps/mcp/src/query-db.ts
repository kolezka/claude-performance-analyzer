// The SQL side of harness_query: builds the query database from plain rows and runs one
// SELECT. Kept free of other imports so the child process that runs queries starts fast.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { UserError } from "./errors";

export const QUERY_SCHEMA = `Tables (transcript data for the chosen scope):
  blocks(session_id, agent_id, project, ts_ms, prompt_id, hook_event, hook_name, kind, chars, est_tokens, family, tag, signature, command, repeat, persisted_size, read_back, preview)
    one row per block of text a hook put into the model's context; family='hindsight' for Hindsight; repeat=1 when the session already got identical text
  hook_runs(session_id, agent_id, project, ts_ms, prompt_id, hook_event, hook_name, command, duration_ms, exit_code)
    single hook command runs the transcript records (only some events, e.g. SessionStart, PreToolUse)
  sessions(session_id, project, cwd, branch, first_ms, last_ms, prompts, subagent_files)
Telemetry, all sessions and times (read-only, attached as tel):
  tel.events(ts_ms, name, session_id, prompt_id, attrs JSON, host_id)  e.g. name='hook_execution_complete' with json_extract(attrs,'$.hook_name'), '$.total_duration_ms', '$.additional_context_chars'
  tel.spans(trace_id, span_id, parent_id, name, start_ms, end_ms, session_id, attrs JSON, host_id)
  tel.metrics(ts_ms, name, session_id, value, attrs JSON, host_id)`;

export interface QueryRows {
  blocks: unknown[][];
  runs: unknown[][];
  sessions: unknown[][];
}

const MAX_ROWS = 100;
const MAX_CELL = 160;
const MAX_TEXT = 64 * 1024;

export function checkSql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new UserError("Only SELECT (or WITH ... SELECT) queries are allowed.");
  if (trimmed.includes(";")) throw new UserError("One statement only.");
  return trimmed;
}

export function buildQueryDb(rows: QueryRows, telemetryFile: string | null): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE blocks (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    kind TEXT, chars INTEGER, est_tokens INTEGER, family TEXT, tag TEXT, signature TEXT, command TEXT, repeat INTEGER,
    persisted_size TEXT, read_back INTEGER, preview TEXT)`);
  db.run(`CREATE TABLE hook_runs (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    command TEXT, duration_ms INTEGER, exit_code INTEGER)`);
  db.run(`CREATE TABLE sessions (session_id TEXT, project TEXT, cwd TEXT, branch TEXT, first_ms INTEGER, last_ms INTEGER, prompts INTEGER, subagent_files INTEGER)`);
  const insert = (table: string, width: number, list: unknown[][]) => {
    const stmt = db.prepare(`INSERT INTO ${table} VALUES (${Array(width).fill("?").join(",")})`);
    for (const row of list) stmt.run(...(row as any[]));
  };
  db.transaction(() => {
    insert("blocks", 18, rows.blocks);
    insert("hook_runs", 10, rows.runs);
    insert("sessions", 8, rows.sessions);
  })();
  if (telemetryFile && existsSync(telemetryFile)) db.run(`ATTACH DATABASE ? AS tel`, [`file:${telemetryFile}?mode=ro`]);
  db.run("PRAGMA query_only = ON");
  return db;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

function capped(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n(cut at ${MAX_TEXT} characters; select fewer or shorter columns)` : text;
}

export function runQuery(db: Database, sql: string): string {
  const stmt = db.query(checkSql(sql));
  // Iterate instead of all(): a careless SELECT over tel.events must not load every row.
  const rows: Record<string, unknown>[] = [];
  let more = false;
  for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
    if (rows.length === MAX_ROWS) {
      more = true;
      break;
    }
    rows.push(r);
  }
  const cols = stmt.columnNames;
  const header = cols.map(cell);
  if (!rows.length) return capped(`0 rows. Columns: ${header.join(", ")}`);
  let text = capped([header.join(" | "), ...rows.map((r) => cols.map((c) => cell(r[c])).join(" | "))].join("\n"));
  if (more) text += `\n(stopped at ${MAX_ROWS} rows; add LIMIT or aggregate)`;
  return text;
}
