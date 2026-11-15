// Pure helpers for the Hooks page: table order, default selection, recent-call bars and labels.
import type { LatencyStats } from "@cpa/analytics";

export type HookSort = "total" | "p95";

// p95 above this is flagged in warn colour, matching Overview.
export const SLOW_P95_MS = 2000;
// Recent-call bars above this are drawn in warn colour.
export const SLOW_CALL_MS = 1000;

export function parseSort(raw: string | undefined): HookSort {
  return raw === "p95" ? "p95" : "total";
}

export function sortHooks(hooks: LatencyStats[], by: HookSort): LatencyStats[] {
  const key = by === "p95" ? (h: LatencyStats) => h.p95 : (h: LatencyStats) => h.totalMs;
  return [...hooks].sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
}

// The URL name when it exists in the list, else the slowest by total. Null on an empty list.
export function pickHook(hooks: LatencyStats[], requested: string | undefined): string | null {
  if (requested && hooks.some((h) => h.name === requested)) return requested;
  return sortHooks(hooks, "total")[0]?.name ?? null;
}

// Bars oldest first, height as a share of the slowest call (min 4% so a 0 ms call stays visible).
export function callBars<T extends { ms: number; tsMs: number }>(calls: T[]): { call: T; height: number; slow: boolean }[] {
  const ordered = [...calls].sort((a, b) => a.tsMs - b.tsMs);
  const max = Math.max(1, ...ordered.map((c) => c.ms));
  return ordered.map((call) => ({ call, height: Math.max(4, (call.ms / max) * 100), slow: call.ms > SLOW_CALL_MS }));
}

export type CandidateStatus = "matched" | "mismatch" | "unresolved" | "remote" | "none";

export function candidateNote(status: CandidateStatus, scripts: number): string {
  switch (status) {
    case "matched":
      return scripts === 1 ? "This call ran the one script configured for it." : `This call ran all ${scripts} scripts configured for it.`;
    case "mismatch":
      return "The number of scripts this call ran does not match the config, so the list may be out of date.";
    case "unresolved":
      return "The session registered hooks here, but their config could not be read.";
    case "remote":
      return "Registered on the remote host. Its config is not on this Mac.";
    case "none":
      return "No hook registration was seen for this session.";
  }
}
