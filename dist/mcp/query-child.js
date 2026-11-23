// @bun
// apps/mcp/src/query-db.ts
import { constants, Database } from "bun:sqlite";
import { existsSync } from "fs";

// apps/mcp/src/errors.ts
class UserError extends Error {
}

// apps/mcp/src/query-db.ts
var MAX_ROWS = 100;
var MAX_CELL = 160;
var MAX_TEXT = 64 * 1024;
function checkSql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed))
    throw new UserError("Only SELECT (or WITH ... SELECT) queries are allowed.");
  if (trimmed.includes(";"))
    throw new UserError("One statement only.");
  return trimmed;
}
function buildQueryDb(rows, telemetryFile) {
  const db = new Database(":memory:", constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
  db.run(`CREATE TABLE blocks (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    kind TEXT, chars INTEGER, est_tokens INTEGER, family TEXT, tag TEXT, signature TEXT, command TEXT, repeat INTEGER,
    persisted_size TEXT, read_back INTEGER, preview TEXT)`);
  db.run(`CREATE TABLE hook_runs (session_id TEXT, agent_id TEXT, project TEXT, ts_ms INTEGER, prompt_id TEXT, hook_event TEXT, hook_name TEXT,
    command TEXT, duration_ms INTEGER, exit_code INTEGER)`);
  db.run(`CREATE TABLE sessions (session_id TEXT, project TEXT, cwd TEXT, branch TEXT, first_ms INTEGER, last_ms INTEGER, prompts INTEGER, subagent_files INTEGER)`);
  const insert = (table, width, list) => {
    const stmt = db.prepare(`INSERT INTO ${table} VALUES (${Array(width).fill("?").join(",")})`);
    for (const row of list)
      stmt.run(...row);
  };
  db.transaction(() => {
    insert("blocks", 18, rows.blocks);
    insert("hook_runs", 10, rows.runs);
    insert("sessions", 8, rows.sessions);
  })();
  if (telemetryFile && existsSync(telemetryFile))
    db.run(`ATTACH DATABASE ? AS tel`, [`file:${telemetryFile}?mode=ro`]);
  db.run("PRAGMA query_only = ON");
  return db;
}
function cell(v) {
  if (v === null || v === undefined)
    return "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}\u2026` : s;
}
function capped(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}
(cut at ${MAX_TEXT} characters; select fewer or shorter columns)` : text;
}
function runQuery(db, sql) {
  const stmt = db.query(checkSql(sql));
  const rows = [];
  let more = false;
  for (const r of stmt.iterate()) {
    if (rows.length === MAX_ROWS) {
      more = true;
      break;
    }
    rows.push(r);
  }
  const cols = stmt.columnNames;
  const header = cols.map(cell);
  if (!rows.length)
    return capped(`0 rows. Columns: ${header.join(", ")}`);
  let text = capped([header.join(" | "), ...rows.map((r) => cols.map((c) => cell(r[c])).join(" | "))].join(`
`));
  if (more)
    text += `
(stopped at ${MAX_ROWS} rows; add LIMIT or aggregate)`;
  return text;
}

// apps/mcp/src/query-child.ts
var input = await Bun.stdin.json();
var reply;
try {
  reply = { ok: true, text: runQuery(buildQueryDb(input.rows, input.telemetry), input.sql) };
} catch (err) {
  reply = { ok: false, error: err.message };
}
process.stdout.write(JSON.stringify(reply));
