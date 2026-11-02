// Turns gathered harness data into short plain-text answers. Every answer costs the asking
// agent tokens too, so rows are capped and raw injected text only appears as one-line previews.
import { basename } from "node:path";
import { fmtMs, percentile } from "@cpa/analytics";
import { hookSummary } from "@cpa/collector/src/hooks";
import { gitRoot } from "@cpa/collector/src/repos";
import type { Harness } from "./gather";
import { ownerText } from "./owners";
import type { HookFiring } from "./telemetry";
import type { HookRun, InjectedBlock } from "./transcript";

export const TOKEN_NOTE =
  "Tokens are estimates (chars / 4). Injected text is counted as the model received it: previews for output too large for context, plus Claude Code's reminder wrapper where the transcript records it.";

export const tokensOf = (chars: number) => Math.round(chars / 4);

export function fmtCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function charsTok(chars: number): string {
  return `${fmtCount(chars)} chars ≈ ${fmtCount(tokensOf(chars))} tok`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "n/a";
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "?";
}

const projectCache = new Map<string, string>();
export function projectName(cwd: string | null): string {
  if (!cwd) return "unknown project";
  let name = projectCache.get(cwd);
  if (!name) {
    const repo = gitRoot(cwd);
    name = repo ? (repo.worktree ? `${repo.name} (worktree ${basename(cwd)})` : repo.name) : basename(cwd);
    projectCache.set(cwd, name);
  }
  return name;
}

export function scopeLine(h: Harness): string {
  const s = h.scope;
  const bad = s.sessions.reduce((sum, x) => sum + x.badLines, 0);
  let badNote = bad ? ` Skipped ${plural(bad, "unreadable hook line")} in the transcripts; not counted.` : "";
  if (s.unreadableFolders.length)
    badNote += ` ${plural(s.unreadableFolders.length, "transcript folder")} could not be read, so their sessions are missing (first: ${s.unreadableFolders[0]}).`;
  if (s.kind === "session") {
    const sess = s.sessions[0]!;
    const where = [projectName(sess.cwd), sess.gitBranch ? `branch ${sess.gitBranch}` : null].filter(Boolean).join(", ");
    const window = s.sinceLabel ? `, last ${s.sinceLabel}` : `, ${when(sess.firstMs)} to ${when(sess.lastMs)}`;
    const subs = sess.subagents.length ? `, ${plural(sess.subagents.length, "subagent transcript")}` : "";
    return `Session ${sess.sessionId} (${where}): ${plural(h.prompts, "prompt")}${window}${subs}.${badNote}`;
  }
  const proj = s.project ? ` in projects matching "${s.project}"` : "";
  return `${plural(s.sessions.length, "session")} active in the last ${s.sinceLabel}${proj}: ${plural(h.prompts, "prompt")}.${badNote}`;
}

// ---------- hook time ----------

interface TimingRow {
  label: string;
  firings: number;
  totalMs: number;
  p50: number;
  p95: number;
  maxMs: number;
  errors: number;
  blocking: number;
  cancelled: number;
}

export function timingRows(firings: HookFiring[]): TimingRow[] {
  const groups = new Map<string, HookFiring[]>();
  for (const f of firings) (groups.get(f.label) ?? groups.set(f.label, []).get(f.label)!).push(f);
  return [...groups]
    .map(([label, list]) => {
      const sorted = list.map((f) => f.durationMs).sort((a, b) => a - b);
      return {
        label,
        firings: list.length,
        totalMs: sorted.reduce((a, b) => a + b, 0),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        maxMs: sorted.at(-1) ?? 0,
        errors: list.reduce((a, f) => a + f.errors, 0),
        blocking: list.reduce((a, f) => a + f.blocking, 0),
        cancelled: list.reduce((a, f) => a + f.cancelled, 0),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

interface CommandRow {
  hookEvent: string;
  command: string;
  runs: number;
  totalMs: number;
  p95: number;
  maxMs: number;
  failed: number;
}

export function commandRows(runs: HookRun[]): CommandRow[] {
  const groups = new Map<string, HookRun[]>();
  for (const r of runs) {
    const key = `${r.hookEvent}\u0000${r.command}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = list.map((r) => r.durationMs ?? 0).sort((a, b) => a - b);
      return {
        hookEvent: list[0]!.hookEvent,
        command: list[0]!.command,
        runs: list.length,
        totalMs: sorted.reduce((a, b) => a + b, 0),
        p95: percentile(sorted, 95),
        maxMs: sorted.at(-1) ?? 0,
        failed: list.filter((r) => r.exitCode !== null && r.exitCode !== 0).length,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

function shortCommand(command: string, max = 70): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function hookTimeReport(h: Harness, limit: number): string {
  const out = [scopeLine(h)];
  if (h.firings === null) {
    out.push(`Hook time from telemetry: unavailable, ${h.telemetryNote}.`);
  } else {
    const rows = timingRows(h.firings);
    const total = rows.reduce((a, r) => a + r.totalMs, 0);
    out.push(`Hook time from telemetry: ${fmtMs(total)} wall time in ${h.firings.length} firings. All hooks of one event run in parallel, so times are per firing, not per script.`);
    if (h.telemetryNote) out.push(`Note: ${h.telemetryNote}.`);
    if (h.activeMs && h.turnHookMs !== null)
      out.push(`Inside turns: ${fmtMs(h.turnHookMs)} of ${fmtMs(h.activeMs)} active turn time (${pct(h.turnHookMs, h.activeMs)}).`);
    if (h.prompts > 0) out.push(`Per prompt: ${fmtMs(total / h.prompts)} on average.`);
    if (rows.length) {
      out.push("", "hook | firings | total | p50 | p95 | max | errors | blocked");
      for (const r of rows.slice(0, limit))
        out.push(
          `${r.label} | ${r.firings} | ${fmtMs(r.totalMs)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.maxMs)} | ${r.errors} | ${r.blocking}${r.cancelled ? ` (${r.cancelled} cancelled)` : ""}`,
        );
      if (rows.length > limit) out.push(`(${rows.length - limit} more hooks)`);
    }
  }

  const cmds = commandRows(h.runs);
  const events = [...new Set(cmds.map((c) => c.hookEvent))].join(", ");
  out.push("", `Per command, from transcripts. Claude Code logs single runs only for some hooks${events ? `; here: ${events}` : ""}.`);
  if (!cmds.length) out.push("None recorded in this scope.");
  for (const c of cmds.slice(0, limit)) {
    const owners = h.owners ? ownerText(h.owners.byCommand(c.hookEvent, c.command)) : "owner unknown (no telemetry)";
    const failed = c.failed ? `, ${c.failed} failed` : "";
    out.push(
      `- ${c.hookEvent}: ${shortCommand(c.command)} | ${plural(c.runs, "run")}, total ${fmtMs(c.totalMs)}, p95 ${fmtMs(c.p95)}, max ${fmtMs(c.maxMs)}${failed} | ${owners}`,
    );
  }
  if (cmds.length > limit) out.push(`(${cmds.length - limit} more commands)`);
  return out.join("\n");
}

// ---------- injected context ----------

export type GroupBy = "source" | "event" | "prompt" | "session" | "project";

interface InjectionRow {
  key: string;
  label: string;
  blocks: InjectedBlock[];
  chars: number;
  repeats: number;
  persisted: number;
}

// A block repeats when the same session already received the identical text before.
export function repeatSet(blocks: InjectedBlock[]): Set<InjectedBlock> {
  const seen = new Set<string>();
  const repeats = new Set<InjectedBlock>();
  for (const b of [...blocks].sort((x, y) => x.tsMs - y.tsMs)) {
    const key = `${b.sessionId}|${b.agentId ?? ""}|${b.hash}`;
    if (seen.has(key)) repeats.add(b);
    else seen.add(key);
  }
  return repeats;
}

function sessionCwd(h: Harness, sessionId: string): string | null {
  return h.scope.sessions.find((s) => s.sessionId === sessionId)?.cwd ?? null;
}

export function injectionRows(h: Harness, groupBy: GroupBy): InjectionRow[] {
  const repeats = repeatSet(h.blocks);
  const rows = new Map<string, InjectionRow>();
  for (const b of h.blocks) {
    let key: string;
    let label: string;
    switch (groupBy) {
      case "event":
        key = label = b.hookEvent;
        break;
      case "prompt":
        key = `${b.sessionId}|${b.promptId ?? ""}`;
        label = b.promptId ? `prompt ${b.promptId.slice(0, 8)}` : "session start";
        if (h.scope.kind === "all") label = `${b.sessionId.slice(0, 8)} ${label}`;
        if (b.agentId) label += " (subagents)";
        break;
      case "session":
        key = b.sessionId;
        label = `${b.sessionId.slice(0, 8)} ${projectName(sessionCwd(h, b.sessionId))}`;
        break;
      case "project":
        key = label = projectName(sessionCwd(h, b.sessionId));
        break;
      default:
        key = `${b.hookEvent}|${b.signature}|${b.command ?? ""}`;
        label = `${b.signature.replace(/[\s:,;.-]+$/, "")} [${b.hookEvent}]`;
    }
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { key, label, blocks: [], chars: 0, repeats: 0, persisted: 0 }));
    row.blocks.push(b);
    row.chars += b.chars;
    if (repeats.has(b)) row.repeats++;
    if (b.persisted) row.persisted++;
  }
  return [...rows.values()].sort((a, b) => b.chars - a.chars);
}

// Who produced a block: the matched command's owner, or, when the transcript does not say,
// the hooks configured for that event (narrowed to Hindsight's own commands for its tags).
export function blockOwner(h: Harness, b: InjectedBlock): string {
  if (!h.owners) return b.command ? `${hookSummary(b.command)}, owner unknown (no telemetry)` : "unattributed (no telemetry to list candidates)";
  if (b.command) return `${hookSummary(b.command)}, ${ownerText(h.owners.byCommand(b.hookEvent, b.command))}`;
  let candidates = h.owners.forEvent(b.hookEvent);
  if (b.family === "hindsight") {
    const own = candidates.filter((c) => c.command?.toLowerCase().includes("hindsight"));
    if (own.length) candidates = own;
  }
  if (!candidates.length) return `unattributed; no ${b.hookEvent} hooks found in config`;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of candidates) {
    const text = `${shortCommand(c.summary, 50)} (${c.owner.label})`;
    if (!seen.has(text)) {
      seen.add(text);
      names.push(text);
    }
  }
  const prefix = b.family === "hindsight" ? "Hindsight by tag; command not recorded, likely" : `unattributed; ${b.hookEvent} hooks configured:`;
  return `${prefix} ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` (+${names.length - 4})` : ""}`;
}

function totalChars(blocks: InjectedBlock[]): number {
  return blocks.reduce((a, b) => a + b.chars, 0);
}

function telemetryContextChars(h: Harness): number | null {
  return h.firings ? h.firings.reduce((a, f) => a + f.contextChars, 0) : null;
}

export function injectionReport(h: Harness, groupBy: GroupBy, limit: number): string {
  const out = [scopeLine(h), TOKEN_NOTE];
  const total = totalChars(h.blocks);
  const start = totalChars(h.blocks.filter((b) => b.promptId === null && !b.agentId));
  out.push(`Injected by hooks: ${charsTok(total)} in ${plural(h.blocks.length, "block")}.`);
  if (h.scope.kind === "session" && !h.scope.sinceLabel) out.push(`Before the first prompt (SessionStart): ${charsTok(start)}.`);
  if (h.prompts > 0) out.push(`Per prompt: ${charsTok((total - start) / h.prompts)} on average.`);
  const tel = telemetryContextChars(h);
  if (tel !== null) out.push(`Telemetry's own count for the same hooks: ${fmtCount(tel)} chars (counts persisted output at full size and does not see every hook).`);
  if (!h.blocks.length) {
    out.push("No hook-injected blocks in this scope.");
    return out.join("\n");
  }

  const rows = injectionRows(h, groupBy);
  out.push("");
  for (const [i, r] of rows.slice(0, limit).entries()) {
    const extras = [
      r.blocks.length > 1 ? `${r.blocks.length} blocks` : "1 block",
      r.repeats ? plural(r.repeats, "identical repeat") : null,
      r.persisted ? `${r.persisted} persisted` : null,
      h.scope.kind === "all" && groupBy === "source" ? `${new Set(r.blocks.map((b) => b.sessionId)).size} sessions` : null,
    ].filter(Boolean);
    out.push(`${i + 1}. ${r.label}: ${charsTok(r.chars)}, ${pct(r.chars, total)} (${extras.join(", ")})`);
    if (groupBy === "source") {
      out.push(`   owner: ${blockOwner(h, r.blocks[0]!)}`);
      out.push(`   preview: ${r.blocks[0]!.preview}`);
    }
  }
  if (rows.length > limit) out.push(`(${rows.length - limit} more rows)`);
  return out.join("\n");
}

// ---------- Hindsight memory ----------

export function memoryReport(h: Harness): string {
  const out = [scopeLine(h), TOKEN_NOTE];
  const mem = h.blocks.filter((b) => b.family === "hindsight");
  const all = totalChars(h.blocks);
  const memChars = totalChars(mem);
  out.push(`Hindsight memory: ${charsTok(memChars)} in ${plural(mem.length, "block")}, ${pct(memChars, all)} of all hook-injected text.`);
  if (!mem.length) {
    out.push("No Hindsight-tagged blocks (<hindsight_*>) in this scope.");
    return out.join("\n");
  }

  const repeats = repeatSet(h.blocks);
  const byTag = new Map<string, InjectedBlock[]>();
  for (const b of mem) (byTag.get(b.tag ?? "?") ?? byTag.set(b.tag ?? "?", []).get(b.tag ?? "?")!).push(b);
  out.push("", "By tag:");
  for (const [tag, list] of [...byTag].sort((a, b) => totalChars(b[1]) - totalChars(a[1]))) {
    const events = [...new Set(list.map((b) => b.hookEvent))].join(", ");
    const rep = list.filter((b) => repeats.has(b)).length;
    const persisted = list.filter((b) => b.persisted).length;
    const notes = [events, rep ? plural(rep, "identical repeat") : null, persisted ? `${persisted} persisted` : null].filter(Boolean).join(", ");
    out.push(`- <${tag}>: ${charsTok(totalChars(list))} in ${plural(list.length, "block")} (${notes})`);
  }

  const perPrompt = new Map<string, number>();
  for (const b of mem) if (b.promptId) perPrompt.set(`${b.sessionId}|${b.promptId}`, (perPrompt.get(`${b.sessionId}|${b.promptId}`) ?? 0) + b.chars);
  if (h.prompts > 0) {
    const promptChars = [...perPrompt.values()].reduce((a, b) => a + b, 0);
    const max = Math.max(0, ...perPrompt.values());
    out.push("", `Per prompt: ${charsTok(promptChars / h.prompts)} on average, max ${charsTok(max)}.`);
  }

  const persisted = mem.filter((b) => b.persisted);
  if (persisted.length) {
    const readBack = persisted.filter((b) => b.persisted!.readBack).length;
    const sizes = persisted.map((b) => b.persisted!.reportedSize ?? "?");
    const shown = Math.round(totalChars(persisted) / persisted.length);
    out.push(
      `Too large for context: ${plural(persisted.length, "block")} saved to a file instead (full size ${sizes.slice(0, 5).join(", ")}${sizes.length > 5 ? ", …" : ""}); the model saw a preview of about ${fmtCount(shown)} chars each. The agent read the full file back for ${readBack} of them.`,
    );
  }

  out.push("", "Owners:");
  const ownerSeen = new Set<string>();
  for (const b of mem) {
    const key = `${b.hookEvent}|${b.command ?? ""}`;
    if (ownerSeen.has(key)) continue;
    ownerSeen.add(key);
    out.push(`- ${b.hookEvent}: ${blockOwner(h, b)}`);
  }
  return out.join("\n");
}

// ---------- summary ----------

export function summaryReport(h: Harness): string {
  const out = [scopeLine(h), TOKEN_NOTE, ""];
  if (h.firings === null) out.push(`Hook time: unavailable, ${h.telemetryNote}.`);
  else {
    const rows = timingRows(h.firings);
    const total = rows.reduce((a, r) => a + r.totalMs, 0);
    const share = h.activeMs && h.turnHookMs !== null ? `, ${pct(h.turnHookMs, h.activeMs)} of active turn time` : "";
    out.push(`Hook time: ${fmtMs(total)} wall time in ${h.firings.length} firings${share}.`);
    const top = rows
      .slice(0, 3)
      .map((r) => `${r.label} ${fmtMs(r.totalMs)} (${r.firings}x, p95 ${fmtMs(r.p95)}${r.errors ? `, ${r.errors} errors` : ""})`);
    if (top.length) out.push(`  top: ${top.join("; ")}`);
    if (h.telemetryNote) out.push(`  note: ${h.telemetryNote}`);
  }

  const total = totalChars(h.blocks);
  out.push(`Injected by hooks: ${charsTok(total)} in ${plural(h.blocks.length, "block")}.`);
  const repeats = repeatSet(h.blocks);
  const repeatChars = totalChars([...repeats]);
  if (repeatChars) out.push(`  identical repeats: ${charsTok(repeatChars)} (${pct(repeatChars, total)}) was text the same session had already received.`);
  for (const r of injectionRows(h, "source").slice(0, 3)) out.push(`  ${r.label}: ${charsTok(r.chars)} (${plural(r.blocks.length, "block")})`);

  const mem = h.blocks.filter((b) => b.family === "hindsight");
  const persisted = mem.filter((b) => b.persisted);
  const persistedNote = persisted.length
    ? `; ${plural(persisted.length, "recall")} too large for context, ${persisted.filter((b) => b.persisted!.readBack).length} read back by the agent`
    : "";
  out.push(`Hindsight memory: ${charsTok(totalChars(mem))}, ${pct(totalChars(mem), total)} of injected${persistedNote}.`);
  out.push("", "Details: hook_time, injected_context (group_by source|event|prompt|session|project), memory_cost, harness_query.");
  return out.join("\n");
}
