// Pure helpers for the Turns page: URL params, repo filter, bar shares, load-more limits.

export type TurnSort = "recent" | "slowest";

export interface TurnListItem {
  promptId: string;
  startMs: number;
  endMs: number;
  wallMs: number;
  activeMs: number;
  idleMs: number;
  inProgress: boolean;
  sessionId: string | null;
  sessionKind: string | null;
  sessionLabel: string | null;
  repo: string | null;
  folder: string | null;
  command: string | null;
  apiMs: number;
  toolMs: number;
  hookMs: number;
}

export const PAGE_STEP = 20;
export const MAX_LIMIT = 50;
// Repo filtering happens in the browser, so it always asks for the most the API serves.
export const NO_REPO = "(no repo)";

export function sortFrom(params: Record<string, string>): TurnSort {
  return params.sort === "slowest" ? "slowest" : "recent";
}

export function limitFor(requested: number, repo: string | null): number {
  if (repo) return MAX_LIMIT;
  return Math.min(Math.max(requested, 1), MAX_LIMIT);
}

export function nextLimit(current: number): number {
  return Math.min(current + PAGE_STEP, MAX_LIMIT);
}

// Load more is offered only while the server may have more rows than it sent.
export function canLoadMore(limit: number, received: number, repo: string | null): boolean {
  return !repo && limit < MAX_LIMIT && received >= limit;
}

export function repoKey(t: Pick<TurnListItem, "repo">): string {
  return t.repo ?? NO_REPO;
}

// Sorted repo names seen in the list; the selected one stays listed even when absent.
export function repoOptions(turns: Pick<TurnListItem, "repo">[], selected: string | null): string[] {
  const set = new Set(turns.map(repoKey));
  if (selected) set.add(selected);
  return [...set].sort((a, b) => {
    if (a === NO_REPO) return 1;
    if (b === NO_REPO) return -1;
    return a.localeCompare(b);
  });
}

export function filterByRepo<T extends Pick<TurnListItem, "repo">>(turns: T[], repo: string | null): T[] {
  return repo ? turns.filter((t) => repoKey(t) === repo) : turns;
}

export interface Shares {
  api: number;
  tools: number;
  hooks: number;
  // True when none of the three parts were measured (e.g. a /compact turn).
  empty: boolean;
}

// Percent widths of api/tools/hooks within their own sum.
export function shares(t: { apiMs: number; toolMs: number; hookMs: number }): Shares {
  const total = t.apiMs + t.toolMs + t.hookMs;
  if (!total) return { api: 0, tools: 0, hooks: 0, empty: true };
  return { api: (t.apiMs / total) * 100, tools: (t.toolMs / total) * 100, hooks: (t.hookMs / total) * 100, empty: false };
}

export function turnLabel(t: Pick<TurnListItem, "command">): string {
  return t.command ?? "prompt";
}
