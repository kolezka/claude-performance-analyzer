// The tools a coding agent sees. All read-only: they report what the harness costs and who owns
// each part; the agent decides what to change.
import { gather, UserError, type ScopeArgs } from "./gather";
import type { ToolDef } from "./protocol";
import { QUERY_SCHEMA, runIsolatedQuery } from "./query";
import { hookTimeReport, injectionReport, memoryReport, summaryReport, type GroupBy } from "./report";

const SCOPE_PROPS = {
  session: {
    type: "string",
    description: "'current' (default, the session calling this tool), 'all' for every recent session, or a session id or 8+ character prefix.",
  },
  since: {
    type: "string",
    description: "Only data newer than this: 15m, 1h, 24h, 7d. Default: the whole session, or 24h with session='all'.",
  },
  project: { type: "string", description: "With session='all': only sessions whose working directory contains this text." },
};

const LIMIT_PROP = { type: "integer", minimum: 1, maximum: 50, description: "Max rows per list (default 10)." };

function scopeArgs(args: Record<string, unknown>): ScopeArgs {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { session: str(args.session), since: str(args.since), project: str(args.project) };
}

function limitOf(args: Record<string, unknown>): number {
  const n = Number(args.limit ?? 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 50) : 10;
}

const GROUPS: GroupBy[] = ["source", "event", "prompt", "session", "project"];

export function harnessTools(env: Record<string, string | undefined> = process.env): ToolDef[] {
  return [
    {
      name: "harness_summary",
      description:
        "Start here. What the Claude Code harness costs: hook wall time, text hooks inject into the model's context (estimated tokens), and Hindsight memory's share. Defaults to the calling session.",
      inputSchema: { type: "object", properties: SCOPE_PROPS, additionalProperties: false },
      run: async (args) => summaryReport(await gather(scopeArgs(args), env)),
    },
    {
      name: "hook_time",
      description:
        "Hook timing: per hook event (firings, total, p50, p95, max, errors, blocks) from telemetry, active turn time share, and per-command run times with the plugin or settings file that owns each command.",
      inputSchema: { type: "object", properties: { ...SCOPE_PROPS, limit: LIMIT_PROP }, additionalProperties: false },
      run: async (args) => hookTimeReport(await gather(scopeArgs(args), env), limitOf(args)),
    },
    {
      name: "injected_context",
      description:
        "Text hooks put into the model's context, counted as the model received it (persisted output counts as its preview). Group by source (default: each distinct block with owner and preview), event, prompt, session or project. Flags identical repeats.",
      inputSchema: {
        type: "object",
        properties: { ...SCOPE_PROPS, group_by: { type: "string", enum: GROUPS }, limit: LIMIT_PROP },
        additionalProperties: false,
      },
      run: async (args) => {
        const groupBy = (typeof args.group_by === "string" ? args.group_by : "source") as GroupBy;
        if (!GROUPS.includes(groupBy)) throw new UserError(`group_by must be one of ${GROUPS.join(", ")}`);
        return injectionReport(await gather(scopeArgs(args), env), groupBy, limitOf(args));
      },
    },
    {
      name: "memory_cost",
      description:
        "Hindsight memory injection: split by tag (recall <hindsight_memory> vs <hindsight_knowledge*> banners), per prompt, repeats, recalls too large for context and whether the agent read them back, and the owning hook.",
      inputSchema: { type: "object", properties: SCOPE_PROPS, additionalProperties: false },
      run: async (args) => memoryReport(await gather(scopeArgs(args), env)),
    },
    {
      name: "harness_query",
      description: `Read-only SQL (SQLite, one SELECT) for questions the other tools do not answer. Max 100 rows; stopped after 10s.\n${QUERY_SCHEMA}`,
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "One SELECT or WITH query." }, ...SCOPE_PROPS },
        required: ["sql"],
        additionalProperties: false,
      },
      run: async (args) => {
        if (typeof args.sql !== "string" || !args.sql.trim()) throw new UserError("sql is required");
        return runIsolatedQuery(await gather(scopeArgs(args), env), args.sql);
      },
    },
  ];
}
