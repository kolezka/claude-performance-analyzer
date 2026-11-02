// Resolves a tool call's scope (which sessions, since when) and gathers everything the reports
// need: injected blocks and hook runs from transcripts, hook firings from telemetry, owners.
import { promptBreakdowns } from "@cpa/analytics";
import { UserError } from "./errors";
import { findSession, loadSession, recentSessions, type SessionData } from "./locate";
import { buildOwnerIndex, type OwnerIndex } from "./owners";
import { hookFirings, hookRegistrations, openTelemetry, sessionEvents, type HookFiring } from "./telemetry";
import type { HookRun, InjectedBlock } from "./transcript";

export { UserError };

export interface ScopeArgs {
  session?: string;
  since?: string;
  project?: string;
}

export interface Scope {
  kind: "session" | "all";
  sessions: SessionData[];
  // 0 means no lower bound (a whole session).
  sinceMs: number;
  sinceLabel: string | null;
  project: string | null;
  // Project folders under ~/.claude/projects that could not be listed; their sessions are missing.
  unreadableFolders: string[];
}

export interface Harness {
  scope: Scope;
  blocks: InjectedBlock[];
  runs: HookRun[];
  firings: HookFiring[] | null;
  telemetryNote: string | null;
  owners: OwnerIndex | null;
  prompts: number;
  // Single-session scope only: active (non-idle) turn time and the hook time inside turns.
  activeMs: number | null;
  turnHookMs: number | null;
}

const SINCE = /^(\d+)\s*(m|min|h|d)$/i;

export function parseSince(since: string): number {
  const m = since.trim().match(SINCE);
  if (!m) throw new UserError(`since must look like 15m, 1h, 24h or 7d, got "${since}"`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}

export async function resolveScope(args: ScopeArgs, env: Record<string, string | undefined> = process.env, nowMs = Date.now()): Promise<Scope> {
  const session = (args.session ?? "current").trim() || "current";
  const sinceLabel = args.since?.trim() || null;
  const project = args.project?.trim() || null;

  if (session === "all") {
    const label = sinceLabel ?? "24h";
    const sinceMs = nowMs - parseSince(label);
    const found = recentSessions(sinceMs);
    const sessions: SessionData[] = [];
    for (const f of found.sessions) {
      const s = await loadSession(f);
      if (project && !(s.cwd ?? "").toLowerCase().includes(project.toLowerCase())) continue;
      sessions.push(s);
    }
    return { kind: "all", sessions, sinceMs, sinceLabel: label, project, unreadableFolders: found.unreadable };
  }

  let id = session;
  if (session === "current") {
    const envId = env.CLAUDE_CODE_SESSION_ID;
    if (!envId)
      throw new UserError(
        "No current session: CLAUDE_CODE_SESSION_ID is not set, so this server was not started by a Claude Code session. Pass session='all' or a session id.",
      );
    id = envId;
  }
  const found = findSession(id);
  const unreadable = found.unreadable.length ? ` ${found.unreadable.length} project folders could not be read.` : "";
  if (found.sessions.length === 0) throw new UserError(`No transcript found for session ${id} under ~/.claude/projects.${unreadable}`);
  if (found.sessions.length > 1)
    throw new UserError(`Session prefix ${id} matches ${found.sessions.length} sessions: ${found.sessions.map((f) => f.sessionId).join(", ")}`);
  const sinceMs = sinceLabel ? nowMs - parseSince(sinceLabel) : 0;
  return { kind: "session", sessions: [await loadSession(found.sessions[0]!)], sinceMs, sinceLabel, project: null, unreadableFolders: found.unreadable };
}

export async function gather(args: ScopeArgs, env: Record<string, string | undefined> = process.env, nowMs = Date.now()): Promise<Harness> {
  const scope = await resolveScope(args, env, nowMs);
  const blocks: InjectedBlock[] = [];
  const runs: HookRun[] = [];
  let prompts = 0;
  for (const s of scope.sessions) {
    const parts = [s.main, ...s.subagents].filter((d) => d !== null);
    const readPaths = new Set(parts.flatMap((d) => d.readPaths));
    for (const d of parts) {
      for (const b of d.blocks) {
        if (b.tsMs < scope.sinceMs) continue;
        if (b.persisted?.path) b.persisted.readBack = readPaths.has(b.persisted.path);
        blocks.push(b);
      }
      for (const r of d.runs) if (r.tsMs >= scope.sinceMs) runs.push(r);
    }
    prompts += s.prompts.filter((p) => p.tsMs >= scope.sinceMs).length;
  }

  const sessionIds = scope.sessions.map((s) => s.sessionId);
  const tel = openTelemetry();
  let firings: HookFiring[] | null = null;
  let telemetryNote: string | null = null;
  let owners: OwnerIndex | null = null;
  let activeMs: number | null = null;
  let turnHookMs: number | null = null;
  if (tel.ok) {
    try {
      firings = hookFirings(tel.db, { sessionIds, sinceMs: scope.sinceMs });
      if (firings.length === 0 && sessionIds.length > 0)
        telemetryNote = "telemetry has no hook firings for these sessions (telemetry may have been off, or the collector not running)";
      const regs = hookRegistrations(tel.db, { sessionIds, sinceMs: 0 });
      const cwdBySession = new Map(scope.sessions.map((s) => [s.sessionId, s.cwd]));
      const events = [...blocks.map((b) => b.hookEvent), ...runs.map((r) => r.hookEvent)];
      owners = buildOwnerIndex(regs, cwdBySession, events);
      // A since window cuts turns in half, so a share of active turn time would mix hook time
      // from before the window into the answer. Whole sessions only.
      if (scope.kind === "session" && scope.sinceMs === 0) {
        const turns = [...promptBreakdowns(sessionEvents(tel.db, sessionIds)).values()].filter((p) => p.endMs >= scope.sinceMs);
        activeMs = turns.reduce((sum, p) => sum + p.activeMs, 0);
        turnHookMs = turns.reduce((sum, p) => sum + p.hookMs, 0);
      }
    } finally {
      tel.db.close();
    }
  } else {
    telemetryNote = tel.reason;
  }

  return { scope, blocks, runs, firings, telemetryNote, owners, prompts, activeMs, turnHookMs };
}
