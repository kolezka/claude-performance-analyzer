// Builds session metadata from its events: inferred repo, branch, terminal, cost.
import { extractPaths } from "@cpa/analytics";
import type { Attrs, EventRow } from "@cpa/otlp";
import { gitRoot, type RepoInfo } from "./repos";

// The only event types buildSessionInfo reads. Resource attrs (terminal, version, branch) are
// merged onto every row of a batch, so restricting to these still sees them.
export const SESSION_EVENT_NAMES = ["user_prompt", "api_request", "tool_result"];

export interface SessionInfo {
  sessionId: string;
  repo: RepoInfo | null;
  pathsSeen: number;
  otherRepos: string[];
  branch: string | null;
  terminal: string | null;
  claudeVersion: string | null;
  models: string[];
  firstMs: number;
  lastMs: number;
  prompts: number;
  costUsd: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// tool_parameters.git_branch, tolerant of the same truncated-JSON tails extractPaths handles.
function gitBranchFromToolParams(attrs: Attrs): string | null {
  const raw = attrs.tool_parameters;
  if (typeof raw !== "string") return null;
  try {
    const obj = JSON.parse(raw);
    return typeof obj.git_branch === "string" ? obj.git_branch : null;
  } catch {
    const m = raw.match(/"git_branch"\s*:\s*"([^"]*)"/);
    return m ? m[1]! : null;
  }
}

// Repo = the git root most of the session's tool calls touched (ties broken by recency).
export function buildSessionInfo(sessionId: string, events: EventRow[], home: string): SessionInfo | null {
  if (!events.length) return null;

  const rootHits = new Map<string, { repo: RepoInfo; count: number; lastMs: number }>();
  let branch: string | null = null;
  let branchMs = -Infinity;
  let terminal: string | null = null;
  let claudeVersion: string | null = null;
  const models = new Set<string>();
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let prompts = 0;
  let costUsd = 0;

  for (const e of events) {
    firstMs = Math.min(firstMs, e.tsMs);
    lastMs = Math.max(lastMs, e.tsMs);
    const a = e.attrs;
    if (!terminal && typeof a["terminal.type"] === "string") terminal = a["terminal.type"];
    if (!claudeVersion && typeof a["service.version"] === "string") claudeVersion = a["service.version"];

    const headBranch = a["vcs.ref.head.name"];
    if (typeof headBranch === "string" && e.tsMs >= branchMs) {
      branch = headBranch;
      branchMs = e.tsMs;
    }

    if (e.name === "user_prompt") prompts++;

    if (e.name === "api_request") {
      if (typeof a.model === "string") models.add(a.model);
      costUsd += num(a.cost_usd);
    }

    if (e.name === "tool_result") {
      const paramBranch = gitBranchFromToolParams(a);
      if (paramBranch && e.tsMs >= branchMs) {
        branch = paramBranch;
        branchMs = e.tsMs;
      }
      for (const p of extractPaths(a, home)) {
        const repo = gitRoot(p);
        if (!repo) continue;
        const hit = rootHits.get(repo.root);
        if (hit) {
          hit.count++;
          hit.lastMs = Math.max(hit.lastMs, e.tsMs);
        } else {
          rootHits.set(repo.root, { repo, count: 1, lastMs: e.tsMs });
        }
      }
    }
  }

  const ranked = [...rootHits.values()].sort((x, y) => y.count - x.count || y.lastMs - x.lastMs);
  const top = ranked[0] ?? null;

  return {
    sessionId,
    repo: top ? top.repo : null,
    pathsSeen: top ? top.count : 0,
    otherRepos: ranked.slice(1).map((r) => r.repo.name),
    branch,
    terminal,
    claudeVersion,
    models: [...models],
    firstMs,
    lastMs,
    prompts,
    costUsd,
  };
}
