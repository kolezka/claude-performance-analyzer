// Pure helpers for the Tools & MCP page: selection parsing, shares and labels.
import type { LatencyStats } from "@cpa/analytics";

export type ItemKind = "tools" | "agents";

// The route keeps the selection as ?name=...; subagents add &kind=agents.
export function selectionFrom(params: Record<string, string>): { kind: ItemKind; name: string } | null {
  const name = params.name;
  if (!name) return null;
  return { kind: params.kind === "agents" ? "agents" : "tools", name };
}

// Share of in-turn time (api + tools + hooks) spent in tools.
export function toolShare(b: { api: number; tools: number; hooks: number }): number {
  const total = b.api + b.tools + b.hooks;
  return total ? b.tools / total : 0;
}

export function totals(list: LatencyStats[]): { count: number; totalMs: number; failures: number } {
  return list.reduce((t, s) => ({ count: t.count + s.count, totalMs: t.totalMs + s.totalMs, failures: t.failures + s.failures }), { count: 0, totalMs: 0, failures: 0 });
}

// Width of a bar relative to the largest total, as a CSS percent.
export function barWidth(totalMs: number, maxMs: number): string {
  if (maxMs <= 0 || totalMs <= 0) return "0%";
  return `${Math.max(1, Math.round((totalMs / maxMs) * 100))}%`;
}

// Splits "Agent: Explore" or "mcp: server/tool" labels into a main part and a muted hint.
export function splitToolLabel(name: string): { main: string; hint: string | null } {
  if (name.startsWith("mcp: ")) {
    const rest = name.slice(5);
    const slash = rest.indexOf("/");
    return slash === -1 ? { main: rest, hint: "mcp" } : { main: rest.slice(slash + 1), hint: `mcp ${rest.slice(0, slash)}` };
  }
  const colon = name.indexOf(": ");
  if (colon > 0) return { main: name.slice(colon + 2), hint: name.slice(0, colon) };
  return { main: name, hint: null };
}

export type Health = "ok" | "warn" | "crit";

// A server with any failed connect is critical; a slow typical connect (p50 over 2s) is a warning.
export function mcpHealth(s: LatencyStats): Health {
  if (s.failures > 0) return s.failures >= s.count ? "crit" : "warn";
  return s.p50 > 2000 ? "warn" : "ok";
}

// summary.permissions keys are "source / decision".
export function splitPermission(key: string): { source: string; decision: string } {
  const i = key.lastIndexOf(" / ");
  return i === -1 ? { source: key, decision: "?" } : { source: key.slice(0, i), decision: key.slice(i + 3) };
}

export function extraNum(s: LatencyStats, key: string): number {
  const v = s.extra?.[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
