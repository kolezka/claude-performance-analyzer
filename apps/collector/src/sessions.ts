// Builds session metadata from its events: inferred repo, branch, terminal, cost.
import { extractPaths } from "@cpa/analytics";
import type { Attrs, EventRow } from "@cpa/otlp";
import type { HostContext } from "./hosts";
import { gitRoot, type RepoInfo } from "./repos";

// The only event types buildSessionInfo reads. Resource attrs (terminal, version, branch) are
// merged onto every row of a batch, so restricting to these still sees them.
export const SESSION_EVENT_NAMES = ["user_prompt", "api_request", "tool_result"];

export interface RepoSample {
  tsMs: number;
  promptId: string | null;
  repo: RepoInfo;
}

export interface PathSample {
  tsMs: number;
  promptId: string | null;
  path: string;
}

export interface BranchSample {
  tsMs: number;
  promptId: string | null;
  branch: string;
}

export interface SessionInfo {
  sessionId: string;
  repo: RepoInfo | null;
  pathsSeen: number;
  otherRepos: string[];
  branch: string | null;
  terminal: string | null;
  claudeVersion: string | null;
  // Who started the session, from a `launcher` resource attr (OTEL_RESOURCE_ATTRIBUTES).
  launcher: string | null;
  models: string[];
  firstMs: number;
  lastMs: number;
  prompts: number;
  costUsd: number;
  kind: "interactive" | "headless";
  kindLabel: string;
  // Ascending by tsMs: every tool call's own repo and every branch signal seen, so a call's
  // folder/branch can be resolved "as of" its own moment instead of the session-wide dominant
  // one (a long session can move between repos and branches over its life).
  repoTimeline: RepoSample[];
  branchTimeline: BranchSample[];
  // Every path tool calls touched, as sent. A remote host has no repo lookup, so this is what
  // its folder column shows.
  pathTimeline: PathSample[];
}

function lastAtOrBefore<T extends { tsMs: number }>(samples: T[], tsMs: number): T | null {
  let lo = 0;
  let hi = samples.length - 1;
  let found: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.tsMs <= tsMs) {
      found = samples[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// A sample's value "as of" a moment: the latest one at or before it, else the first one after
// it for the same prompt (the call ran before the session's first touch, but something in its
// own turn later reveals where that turn was), else null (caller falls back to the session-wide
// dominant value).
function sampleAsOf<T extends { tsMs: number; promptId: string | null }>(samples: T[], tsMs: number, promptId: string | null): T | null {
  const before = lastAtOrBefore(samples, tsMs);
  if (before) return before;
  for (const s of samples) {
    if (s.tsMs > tsMs && s.promptId === promptId) return s;
  }
  return null;
}

export function repoAsOf(info: SessionInfo, tsMs: number, promptId: string | null): RepoInfo | null {
  return sampleAsOf(info.repoTimeline, tsMs, promptId)?.repo ?? info.repo;
}

export function pathAsOf(info: SessionInfo, tsMs: number, promptId: string | null): string | null {
  return sampleAsOf(info.pathTimeline, tsMs, promptId)?.path ?? null;
}

export function branchAsOf(info: SessionInfo, tsMs: number, promptId: string | null): string | null {
  return sampleAsOf(info.branchTimeline, tsMs, promptId)?.branch ?? info.branch;
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
// A context that may not read disk (a remote host) never resolves a repo: this Mac's files say
// nothing about another machine's paths.
export function buildSessionInfo(sessionId: string, events: EventRow[], context: HostContext): SessionInfo | null {
  if (!events.length) return null;

  const rootHits = new Map<string, { repo: RepoInfo; count: number; lastMs: number }>();
  let branch: string | null = null;
  let branchMs = -Infinity;
  let terminal: string | null = null;
  let claudeVersion: string | null = null;
  let launcher: string | null = null;
  const models = new Set<string>();
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let prompts = 0;
  let costUsd = 0;
  const querySources = new Set<string>();
  let sawNonInteractiveTerminal = false;
  // events is ts_ms-ordered (the SQL query guarantees it), so both timelines come out sorted
  // for free just by pushing in loop order.
  const repoTimeline: RepoSample[] = [];
  const branchTimeline: BranchSample[] = [];
  const pathTimeline: PathSample[] = [];

  for (const e of events) {
    firstMs = Math.min(firstMs, e.tsMs);
    lastMs = Math.max(lastMs, e.tsMs);
    const a = e.attrs;
    if (!terminal && typeof a["terminal.type"] === "string") terminal = a["terminal.type"];
    if (!claudeVersion && typeof a["service.version"] === "string") claudeVersion = a["service.version"];
    if (!launcher && typeof a.launcher === "string" && a.launcher !== "") launcher = a.launcher;
    if (a["terminal.type"] === "non-interactive") sawNonInteractiveTerminal = true;

    const headBranch = a["vcs.ref.head.name"];
    if (typeof headBranch === "string") {
      branchTimeline.push({ tsMs: e.tsMs, promptId: e.promptId, branch: headBranch });
      if (e.tsMs >= branchMs) {
        branch = headBranch;
        branchMs = e.tsMs;
      }
    }

    if (e.name === "user_prompt") prompts++;

    if (e.name === "api_request") {
      if (typeof a.model === "string") models.add(a.model);
      costUsd += num(a.cost_usd);
      if (typeof a.query_source === "string") querySources.add(a.query_source);
    }

    if (e.name === "tool_result") {
      const paramBranch = gitBranchFromToolParams(a);
      if (paramBranch) {
        branchTimeline.push({ tsMs: e.tsMs, promptId: e.promptId, branch: paramBranch });
        if (e.tsMs >= branchMs) {
          branch = paramBranch;
          branchMs = e.tsMs;
        }
      }
      // The first path that resolves to a repo wins the sample, same rule repoForEvent uses
      // for a single call; every resolved path still counts toward the all-time dominant vote.
      let sampleRepo: RepoInfo | null = null;
      for (const p of extractPaths(a, context.home)) {
        pathTimeline.push({ tsMs: e.tsMs, promptId: e.promptId, path: p });
        if (!context.mayReadDisk) continue;
        const repo = gitRoot(p);
        if (!repo) continue;
        if (!sampleRepo) sampleRepo = repo;
        const hit = rootHits.get(repo.root);
        if (hit) {
          hit.count++;
          hit.lastMs = Math.max(hit.lastMs, e.tsMs);
        } else {
          rootHits.set(repo.root, { repo, count: 1, lastMs: e.tsMs });
        }
      }
      if (sampleRepo) repoTimeline.push({ tsMs: e.tsMs, promptId: e.promptId, repo: sampleRepo });
    }
  }

  const ranked = [...rootHits.values()].sort((x, y) => y.count - x.count || y.lastMs - x.lastMs);
  const top = ranked[0] ?? null;
  const modelsArr = [...models];

  // Interactive: at least one api_request came from the REPL's own thread. Headless: an "sdk"
  // query source with no REPL thread (claude -p spawned by a plugin), or a non-interactive
  // terminal. Default to interactive when there is no evidence either way.
  const kind: SessionInfo["kind"] = querySources.has("repl_main_thread")
    ? "interactive"
    : querySources.has("sdk") || sawNonInteractiveTerminal
      ? "headless"
      : "interactive";
  const kindLabel =
    kind === "interactive" ? (terminal ? `Interactive · ${terminal}` : "Interactive") : modelsArr.length ? `Headless (SDK) · ${modelsArr[0]}` : "Headless (SDK)";

  return {
    sessionId,
    repo: top ? top.repo : null,
    pathsSeen: top ? top.count : 0,
    otherRepos: ranked.slice(1).map((r) => r.repo.name),
    branch,
    terminal,
    claudeVersion,
    launcher,
    models: modelsArr,
    firstMs,
    lastMs,
    prompts,
    costUsd,
    kind,
    kindLabel,
    repoTimeline,
    branchTimeline,
    pathTimeline,
  };
}
