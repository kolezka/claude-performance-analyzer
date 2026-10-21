// Pure helpers behind the hooks drill-down: success patterns, the finding line, which configured
// scripts could belong to a call, and which of them a call's duration rules out.
import { percentile } from "@cpa/analytics";
import { hookSummary, type HookCall, type HookDefinition } from "./hooks";

export function patternKey(c: HookCall): string {
  return `${c.success}/${c.count}:${c.errors}:${c.blocking}:${c.cancelled}`;
}

export function patternLabel(c: HookCall): string {
  let label = `${c.success}/${c.count} OK`;
  if (c.errors > 0) label += ` · ${c.errors} ${c.errors === 1 ? "error" : "errors"}`;
  if (c.blocking > 0) label += ` · ${c.blocking} blocked`;
  if (c.cancelled > 0) label += ` · ${c.cancelled} cancelled`;
  return label;
}

export interface HookPattern {
  key: string;
  label: string;
  count: number;
  errors: number;
  p95: number;
}

export function summarizePatterns(rows: { call: HookCall; ms: number }[]): HookPattern[] {
  const groups = new Map<string, { label: string; errors: number; durations: number[] }>();
  for (const { call, ms } of rows) {
    const key = patternKey(call);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label: patternLabel(call), errors: 0, durations: [] }));
    if (call.errors > 0) g.errors++;
    g.durations.push(ms);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, count: g.durations.length, errors: g.errors, p95: percentile(g.durations.sort((a, b) => a - b), 95) }))
    .sort((a, b) => b.count - a.count);
}

// States counts only and never names a script: telemetry does not say which one failed.
export function findingLine(rows: { call: HookCall; headless: boolean; launcher: string | null }[]): string | null {
  const failing = rows.filter((r) => r.call.errors > 0);
  if (!failing.length) return null;
  const headless = failing.filter((r) => r.headless).length;
  const interactive = failing.length - headless;
  const calls = `${failing.length} ${failing.length === 1 ? "call" : "calls"} reported errors`;

  const launcher = failing[0]!.launcher;
  const sameLauncher = launcher !== null && failing.every((r) => r.launcher === launcher);
  const launcherClause = sameLauncher ? `, launched by ${launcher}` : "";

  let kinds: string;
  if (interactive === 0) kinds = `, all headless${launcherClause}`;
  else if (headless === 0) kinds = `, all interactive${launcherClause}`;
  else kinds = `: ${headless} headless, ${interactive} interactive${launcherClause}`;
  return `${calls}${kinds}. Failing script not reported.`;
}

export type CandidateStatus = "matched" | "mismatch" | "unresolved" | "none";

// The session's registered scripts only count as "ran in this call" when the numbers agree.
// "unresolved": the session did register hooks, but current config no longer explains them.
export function candidates(call: HookCall, sessionDefs: HookDefinition[], registered = 0): { status: CandidateStatus; scripts: HookDefinition[] } {
  if (!sessionDefs.length) return { status: registered > 0 ? "unresolved" : "none", scripts: [] };
  return { status: call.count === sessionDefs.length ? "matched" : "mismatch", scripts: sessionDefs };
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
}

function scriptName(d: HookDefinition): string {
  return d.plugin ?? hookSummary(d.command ?? "");
}

function joinOr(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A script with a timeout below the call's duration could not have run that long. Null when
// nothing is ruled out, everything is, or the scripts are not known to be the ones that ran.
export function narrowingHint(ms: number, status: CandidateStatus, scripts: HookDefinition[]): string | null {
  if (status !== "matched") return null;
  const ruledOut = scripts.filter((d) => d.timeoutSec !== null && d.timeoutSec * 1000 < ms);
  const remaining = scripts.filter((d) => !ruledOut.includes(d));
  if (!ruledOut.length || !remaining.length) return null;

  const over =
    ruledOut.length === 1
      ? `the ${seconds(ruledOut[0]!.timeoutSec! * 1000)} timeout of ${scriptName(ruledOut[0]!)}`
      : `the timeouts of ${joinAnd(ruledOut.map((d) => `${scriptName(d)} (${seconds(d.timeoutSec! * 1000)})`))}`;
  const left = remaining.map((d) => `${scriptName(d)} (${d.timeoutSec === null ? "no timeout set" : `${seconds(d.timeoutSec * 1000)} timeout`})`);
  return `${seconds(ms)} is over ${over}, so only ${joinOr(left)} could take this long.`;
}
