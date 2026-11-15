// Pure helpers for the Models page.
import type { LatencyStats } from "@cpa/analytics";

export type ModelCard = {
  name: string;
  count: number;
  share: number;
  p50: number;
  p95: number;
  maxMs: number;
  failures: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  // Cache read over all input tokens; null when the model saw no input.
  cacheHit: number | null;
};

const extraNum = (m: LatencyStats, key: string) => Number(m.extra?.[key] ?? 0) || 0;

// Busiest model first; ties break on name so the order is stable across refreshes.
export function modelCards(models: LatencyStats[]): ModelCard[] {
  const total = models.reduce((s, m) => s + m.count, 0);
  return [...models]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((m) => {
      const input = extraNum(m, "input");
      const cacheRead = extraNum(m, "cacheRead");
      const cacheCreation = extraNum(m, "cacheCreation");
      const allInput = input + cacheRead + cacheCreation;
      return {
        name: m.name,
        count: m.count,
        share: total ? m.count / total : 0,
        p50: m.p50,
        p95: m.p95,
        maxMs: m.maxMs,
        failures: m.failures,
        costUsd: extraNum(m, "costUsd"),
        input,
        output: extraNum(m, "output"),
        cacheRead,
        cacheCreation,
        cacheHit: allInput ? cacheRead / allInput : null,
      };
    });
}

// Cache hit below this reads as a warning, matching the draft (67% shown in warn colour).
export const LOW_CACHE_HIT = 0.75;

export function cacheHitLow(ratio: number, totalInput: number): boolean {
  return totalInput > 0 && ratio < LOW_CACHE_HIT;
}

// API error rows from summary.errors, e.g. ["API 529", 4].
export function apiErrors(errors: [string, number][]): [string, number][] {
  return errors.filter(([kind]) => kind.startsWith("API "));
}
