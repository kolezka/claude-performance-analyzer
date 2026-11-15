// Pure helpers for the Telemetry settings page. The API sends key names only, never values,
// because the env block can hold secrets.
import type { EnvPlan } from "@cpa/claude-settings";

export type KeyStatus = "set" | "missing" | "conflict";
export type KeyRow = { key: string; status: KeyStatus; neededFor: string };

// What each wanted key unlocks in the dashboard. Unknown keys fall back to an empty string.
const NEEDED_FOR: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "everything",
  OTEL_LOGS_EXPORTER: "events, live feed",
  OTEL_METRICS_EXPORTER: "cost, tokens",
  OTEL_EXPORTER_OTLP_PROTOCOL: "delivery",
  OTEL_EXPORTER_OTLP_ENDPOINT: "delivery",
  OTEL_LOGS_EXPORT_INTERVAL: "live feed speed",
  OTEL_LOG_TOOL_DETAILS: "hook commands, Bash args",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "traces (beta)",
  OTEL_TRACES_EXPORTER: "time to first token, waterfall",
  OTEL_EXPORTER_OTLP_HEADERS: "remote auth",
};

export function neededFor(key: string): string {
  return NEEDED_FOR[key] ?? "";
}

const ORDER: Record<KeyStatus, number> = { set: 0, conflict: 1, missing: 2 };

// Every key the collector wants, set first, then conflicts, then missing. Stable within a group.
export function keyRows(plan: EnvPlan): KeyRow[] {
  const rows: KeyRow[] = [
    ...plan.present.map((key) => ({ key, status: "set" as const, neededFor: neededFor(key) })),
    ...plan.conflicts.map((key) => ({ key, status: "conflict" as const, neededFor: neededFor(key) })),
    ...plan.missing.map((key) => ({ key, status: "missing" as const, neededFor: neededFor(key) })),
  ];
  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function applyLabel(missing: number, applying: boolean): string {
  return applying ? "Updating..." : `Add ${plural(missing, "missing setting")}`;
}

// Short headline for the top banner. Null when nothing needs attention.
export function bannerText(plan: EnvPlan): string | null {
  if (plan.error) return "Cannot read Claude Code settings";
  if (plan.missing.length) return `${plural(plan.missing.length, "setting")} missing in`;
  if (plan.conflicts.length) return `${plural(plan.conflicts.length, "setting")} set to another value in`;
  return null;
}

// What the dashboard loses while keys are missing, deduplicated, e.g. "Without them: delivery, cost."
export function missingImpact(plan: EnvPlan): string {
  const parts = plan.missing.map(neededFor).filter(Boolean).flatMap((s) => s.split(", "));
  const uniq = [...new Set(parts)];
  return uniq.length ? `Missing until added: ${uniq.join(", ")}.` : "";
}
