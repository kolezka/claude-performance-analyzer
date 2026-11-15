// Pure logic for the Errors page: counters, grouped error rows and the recent failed calls list.
import type { LatencyStats, Summary } from "@cpa/analytics";

export type Counter = { label: string; value: number; sub: string };

export type ErrorKind = "api" | "tool" | "hook" | "mcp" | "denied" | "compact";

// One grouped row. link is set when another page can show the item in detail.
export type ErrorGroup = {
  kind: ErrorKind;
  title: string;
  count: number;
  note: string;
  link: { page: "tools" | "hooks"; name: string } | null;
};

// A single failed call from /api/item failed[]; only these carry a promptId for "Open turn".
export type FailedCall = {
  id: number;
  tsMs: number;
  ms: number;
  kind: "tool" | "hook";
  name: string;
  detail: string | null;
  repo: string | null;
  promptId: string | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Permission keys are "source / decision". Anything but an accept counts as a denial.
export function isDenial(key: string): boolean {
  const decision = key.split(" / ").at(-1)?.trim().toLowerCase() ?? "";
  return decision !== "accept" && decision !== "allow";
}

const failing = (list: LatencyStats[]) => list.filter((s) => s.failures > 0).sort((a, b) => b.failures - a.failures);

function topNames(list: LatencyStats[], max = 3): string {
  if (!list.length) return "none";
  const head = list.slice(0, max).map((s) => `${s.name} ${s.failures}`);
  return list.length > max ? `${head.join(" · ")} · +${list.length - max} more` : head.join(" · ");
}

export function counters(s: Summary, fmtMs: (ms: number) => string): Counter[] {
  const api = s.errors.filter(([k]) => k.startsWith("API"));
  const apiTotal = api.reduce((n, [, c]) => n + c, 0);
  const apiSub = !api.length ? "none" : api.length === 1 ? `all ${api[0]![0].replace(/^API /, "")}` : api.map(([k, c]) => `${k.replace(/^API /, "")} ${c}`).join(" · ");

  const tools = failing(s.tools);
  const toolTotal = tools.reduce((n, t) => n + t.failures, 0);

  const decisions = s.permissions.reduce((n, [, c]) => n + c, 0);
  const denied = s.permissions.filter(([k]) => isDenial(k)).reduce((n, [, c]) => n + c, 0);

  const { compactions, compactionMs } = s.kpis;
  return [
    { label: "API errors", value: apiTotal, sub: apiSub },
    { label: "Tool failures", value: toolTotal, sub: topNames(tools) },
    { label: "Permission denials", value: denied, sub: decisions ? `of ${plural(decisions, "decision")}` : "no decisions" },
    { label: "Compactions", value: compactions, sub: compactions ? `${fmtMs(compactionMs)} spent` : "none" },
  ];
}

// Every error source in the window as one row per item, largest count first within each kind.
export function groups(s: Summary, fmtMs: (ms: number) => string): ErrorGroup[] {
  const out: ErrorGroup[] = [];
  for (const [k, c] of s.errors)
    out.push({ kind: "api", title: k.startsWith("API ") ? `API error ${k.slice(4)}` : k, count: c, note: plural(c, "request"), link: null });
  for (const t of failing(s.tools))
    out.push({ kind: "tool", title: t.name, count: t.failures, note: `${plural(t.failures, "failure")} of ${plural(t.count, "call")}`, link: { page: "tools", name: t.name } });
  for (const h of failing(s.hooks))
    out.push({ kind: "hook", title: h.name, count: h.failures, note: `${plural(h.failures, "run")} with errors of ${h.count}`, link: { page: "hooks", name: h.name } });
  for (const m of failing(s.mcpConnections))
    out.push({ kind: "mcp", title: m.name, count: m.failures, note: `${plural(m.failures, "failed connection")} of ${m.count}`, link: null });
  for (const [k, c] of s.permissions.filter(([key]) => isDenial(key)))
    out.push({ kind: "denied", title: `Permission ${k}`, count: c, note: plural(c, "decision"), link: null });
  if (s.kpis.compactions)
    out.push({ kind: "compact", title: "Compaction", count: s.kpis.compactions, note: `took ${fmtMs(s.kpis.compactionMs)} in total`, link: null });
  return out;
}

// Items worth a detail fetch for their failed calls: the worst few tools and hooks.
export function failedTargets(s: Summary, max = 3): { kind: "tools" | "hooks"; name: string }[] {
  return [
    ...failing(s.tools).slice(0, max).map((t) => ({ kind: "tools" as const, name: t.name })),
    ...failing(s.hooks).slice(0, max).map((h) => ({ kind: "hooks" as const, name: h.name })),
  ];
}

// Merges failed[] lists from several items, newest first, dropping duplicate ids.
export function mergeFailed(lists: FailedCall[][], limit = 20): FailedCall[] {
  const seen = new Set<number>();
  return lists
    .flat()
    .sort((a, b) => b.tsMs - a.tsMs)
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .slice(0, limit);
}
