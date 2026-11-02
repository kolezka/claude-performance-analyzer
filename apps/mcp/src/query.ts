// Read-only SQL over the gathered harness data, for questions the named tools do not answer.
// SQLite runs synchronously, so a query that never ends would freeze the whole server; each
// query therefore runs in a child process that is killed when it runs too long.
import { join } from "node:path";
import { UserError } from "./errors";
import type { Harness } from "./gather";
import { checkSql, type QueryRows } from "./query-db";
import { projectName, repeatSet, tokensOf } from "./report";
import { telemetryPath } from "./telemetry";

export { QUERY_SCHEMA } from "./query-db";

const CHILD = join(import.meta.dir, "query-child.ts");
const DEFAULT_TIMEOUT_MS = 10_000;

function timeoutMs(): number {
  const n = Number(process.env.CPA_MCP_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function queryRows(h: Harness): QueryRows {
  const project = new Map(h.scope.sessions.map((s) => [s.sessionId, projectName(s.cwd)]));
  const repeats = repeatSet(h.blocks);
  return {
    blocks: h.blocks.map((b) => [
      b.sessionId, b.agentId, project.get(b.sessionId) ?? null, b.tsMs, b.promptId, b.hookEvent, b.hookName,
      b.kind, b.chars, tokensOf(b.chars), b.family, b.tag, b.signature, b.command, repeats.has(b) ? 1 : 0,
      b.persisted?.reportedSize ?? null, b.persisted ? (b.persisted.readBack ? 1 : 0) : null, b.preview,
    ]),
    runs: h.runs.map((r) => [r.sessionId, r.agentId, project.get(r.sessionId) ?? null, r.tsMs, r.promptId, r.hookEvent, r.hookName, r.command, r.durationMs, r.exitCode]),
    sessions: h.scope.sessions.map((s) => [s.sessionId, project.get(s.sessionId) ?? null, s.cwd, s.gitBranch, s.firstMs, s.lastMs, s.prompts.length, s.subagents.length]),
  };
}

export async function runIsolatedQuery(h: Harness, sql: string): Promise<string> {
  const clean = checkSql(sql);
  const limit = timeoutMs();
  const started = performance.now();
  const child = Bun.spawn([process.execPath, CHILD], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: limit, killSignal: "SIGKILL" });
  child.stdin.write(JSON.stringify({ rows: queryRows(h), sql: clean, telemetry: telemetryPath() }));
  child.stdin.end();
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  if (child.signalCode) {
    if (performance.now() - started >= limit) throw new UserError(`Query timed out after ${limit / 1000}s and was stopped. Narrow it or add LIMIT.`);
    throw new UserError(`Query process was killed (${child.signalCode}), likely out of memory.`);
  }
  let reply: { ok: boolean; text?: string; error?: string };
  try {
    reply = JSON.parse(out);
  } catch {
    throw new Error(`Query process failed (exit ${child.exitCode}): ${err.trim().slice(-500) || "no output"}`);
  }
  if (!reply.ok) throw new UserError(reply.error ?? "Query failed.");
  return reply.text ?? "";
}
