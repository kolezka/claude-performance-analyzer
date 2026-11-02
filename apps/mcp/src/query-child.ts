// Runs one harness_query in its own process, so a runaway query can be killed without taking
// the MCP server down with it. Reads {rows, sql, telemetry} as JSON on stdin.
import { buildQueryDb, runQuery } from "./query-db";

const input = (await Bun.stdin.json()) as { rows: any; sql: string; telemetry: string | null };
let reply: { ok: true; text: string } | { ok: false; error: string };
try {
  reply = { ok: true, text: runQuery(buildQueryDb(input.rows, input.telemetry), input.sql) };
} catch (err) {
  reply = { ok: false, error: (err as Error).message };
}
process.stdout.write(JSON.stringify(reply));
