// Read-only SQL over the gathered harness data, for questions the named tools do not answer.
// Transcript data goes into an in-memory database; telemetry is attached read-only as "tel".
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Harness } from "./gather";
import { projectName, repeatSet, tokensOf } from "./report";
import { telemetryPath } from "./telemetry";

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

const MAX_ROWS = 100;
const MAX_CELL = 160;

export function checkSql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT (or WITH ... SELECT) queries are allowed.");
  if (trimmed.includes(";")) throw new Error("One statement only.");
  return trimmed;
}

export function buildQueryDb(h: Harness): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE blocks (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    kind TEXT, chars INTEGER, est_tokens INTEGER, family TEXT, tag TEXT, signature TEXT, command TEXT, repeat INTEGER,
    persisted_size TEXT, read_back INTEGER, preview TEXT)`);
  db.run(`CREATE TABLE hook_runs (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    command TEXT, duration_ms INTEGER, exit_code INTEGER)`);
  db.run(`CREATE TABLE sessions (session_id TEXT, project TEXT, cwd TEXT, branch TEXT, first_ms INTEGER, last_ms INTEGER, prompts INTEGER, subagent_files INTEGER)`);

  const project = new Map(h.scope.sessions.map((s) => [s.sessionId, projectName(s.cwd)]));
  const repeats = repeatSet(h.blocks);
  const insBlock = db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insRun = db.prepare("INSERT INTO hook_runs VALUES (?,?,?,?,?,?,?,?,?,?)");
  const insSession = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (const b of h.blocks)
      insBlock.run(
        b.sessionId, b.agentId, project.get(b.sessionId) ?? null, b.tsMs, b.promptId, b.hookEvent, b.hookName,
        b.kind, b.chars, tokensOf(b.chars), b.family, b.tag, b.signature, b.command, repeats.has(b) ? 1 : 0,
        b.persisted?.reportedSize ?? null, b.persisted ? (b.persisted.readBack ? 1 : 0) : null, b.preview,
      );
    for (const r of h.runs)
      insRun.run(r.sessionId, r.agentId, project.get(r.sessionId) ?? null, r.tsMs, r.promptId, r.hookEvent, r.hookName, r.command, r.durationMs, r.exitCode);
    for (const s of h.scope.sessions)
      insSession.run(s.sessionId, project.get(s.sessionId) ?? null, s.cwd, s.gitBranch, s.firstMs, s.lastMs, s.prompts.length, s.subagents.length);
  })();

  const tel = telemetryPath();
  if (existsSync(tel)) db.run(`ATTACH DATABASE ? AS tel`, [`file:${tel}?mode=ro`]);
  db.run("PRAGMA query_only = ON");
  return db;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
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
  if (!rows.length) return `0 rows. Columns: ${stmt.columnNames.join(", ")}`;
  const cols = stmt.columnNames;
  const out = [cols.join(" | ")];
  for (const r of rows) out.push(cols.map((c) => cell(r[c])).join(" | "));
  if (more) out.push(`(stopped at ${MAX_ROWS} rows; add LIMIT or aggregate)`);
  return out.join("\n");
}
