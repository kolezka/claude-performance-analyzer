// Reads what hooks put into the model's context from one Claude Code transcript (JSONL).
// Telemetry only has per-event character totals; the transcript keeps every injected block,
// the command that printed it (when its stdout is recorded) and what the model actually saw.
import { createHash } from "node:crypto";

export interface Persisted {
  // Size as Claude Code reported it ("12.8KB") and where it saved the full output.
  reportedSize: string | null;
  path: string | null;
  // Set later by the caller: whether the agent opened the saved file with Read.
  readBack: boolean;
}

export interface InjectedBlock {
  sessionId: string;
  agentId: string | null;
  tsMs: number;
  promptId: string | null;
  hookEvent: string;
  hookName: string;
  kind: "context" | "blocking_error";
  // Characters the model saw. For persisted output that is the preview, not the full file.
  chars: number;
  tag: string | null;
  family: "hindsight" | null;
  signature: string;
  preview: string;
  hash: string;
  command: string | null;
  persisted: Persisted | null;
}

export interface HookRun {
  sessionId: string;
  agentId: string | null;
  tsMs: number;
  promptId: string | null;
  hookEvent: string;
  hookName: string;
  command: string;
  durationMs: number | null;
  exitCode: number | null;
}

export interface TranscriptData {
  sessionId: string | null;
  agentId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstMs: number | null;
  lastMs: number | null;
  prompts: { id: string; tsMs: number }[];
  blocks: InjectedBlock[];
  runs: HookRun[];
  // Paths the agent opened with Read; used to mark persisted hook output as read back.
  readPaths: string[];
  badLines: number;
}

const PERSISTED_HEAD = "<persisted-output>";
const PERSISTED_SIZE = /Output too large \(([^)]+)\)\. Full output saved to: (\S+)/;
const PREVIEW_MARK = /\nPreview \(first [^)]*\):\n/;

export function leadingTag(text: string): string | null {
  const m = text.match(/^\s*<([A-Za-z][\w-]*)[\s>]/);
  return m ? m[1]! : null;
}

// Grouping key for blocks that come from the same place: the leading XML tag when there is
// one, otherwise the first line with numbers masked (counters change, the source does not).
export function signatureOf(text: string, tag: string | null): string {
  if (tag) return `<${tag}>`;
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  return first.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
}

function oneLine(text: string, max = 90): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// JavaScriptCore keeps a substring's parent alive. Parsed data is cached, so anything kept from
// a line is copied, or one prompt id would pin the whole transcript text in memory.
export function own(s: string): string;
export function own(s: string | null): string | null;
export function own(s: string | null): string | null {
  return s === null ? null : Buffer.from(s, "utf8").toString("utf8");
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

// Splits a persisted-output block into its header facts and the preview body the model saw.
export function unwrapPersisted(text: string): { persisted: Persisted; body: string } | null {
  if (!text.startsWith(PERSISTED_HEAD)) return null;
  const size = text.match(PERSISTED_SIZE);
  const mark = text.match(PREVIEW_MARK);
  let body = mark && mark.index !== undefined ? text.slice(mark.index + mark[0].length) : "";
  body = body.replace(/\n?(\.\.\.\n)?<\/persisted-output>\s*$/, "");
  return { persisted: { reportedSize: size?.[1] ?? null, path: size?.[2] ?? null, readBack: false }, body };
}

// The text a hook's stdout adds to context: hookSpecificOutput.additionalContext from JSON
// output, or plain stdout (SessionStart and UserPromptSubmit add plain stdout as context).
export function contextFromStdout(hookEvent: string, stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const out = JSON.parse(trimmed);
      const ctx = out?.hookSpecificOutput?.additionalContext;
      return typeof ctx === "string" && ctx ? ctx : null;
    } catch {
      return null;
    }
  }
  return hookEvent === "SessionStart" || hookEvent === "UserPromptSubmit" ? trimmed : null;
}

function tsOf(v: unknown): number {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Top-level keys of a transcript line come before its first nested object, so reading them
// from that prefix avoids parsing large user lines (tool results) just to learn the prompt id.
const PROMPT_ID = /"promptId":"([^"]+)"/;
// Quotes inside string values are escaped, so an unescaped "timestamp" key is the line's own.
const TIMESTAMP = /"timestamp":"([^"]+)"/;

interface Pending {
  command: string;
  text: string;
}

export function parseTranscript(text: string, agentId: string | null = null): TranscriptData {
  const data: TranscriptData = {
    sessionId: null,
    agentId,
    cwd: null,
    gitBranch: null,
    firstMs: null,
    lastMs: null,
    prompts: [],
    blocks: [],
    runs: [],
    readPaths: [],
    badLines: 0,
  };
  const seenPrompts = new Set<string>();
  let promptId: string | null = null;
  // Context each hook command printed, waiting to be matched to the block it became.
  const pending = new Map<string, Pending[]>();

  const lines = text.split("\n");
  // Bookkeeping lines (mode, last-prompt) carry no timestamp, so look a little further in.
  const edgeTs = (from: number, step: number) => {
    for (let i = from, seen = 0; i >= 0 && i < lines.length && seen < 200; i += step, seen++) {
      const ms = tsOf(lines[i]!.match(TIMESTAMP)?.[1]);
      if (ms) return ms;
    }
    return null;
  };
  data.firstMs = edgeTs(0, 1);
  data.lastMs = edgeTs(lines.length - 1, -1);

  for (const line of lines) {
    if (!line) continue;
    const prefixEnd = line.indexOf("{", 1);
    const prefix = prefixEnd === -1 ? line : line.slice(0, prefixEnd);

    if (prefix.includes('"type":"user"')) {
      const matched = prefix.match(PROMPT_ID)?.[1];
      if (matched) {
        const id: string = matched === promptId ? promptId : own(matched);
        promptId = id;
        if (!seenPrompts.has(id)) {
          seenPrompts.add(id);
          data.prompts.push({ id, tsMs: tsOf(line.match(TIMESTAMP)?.[1]) });
        }
      }
      continue;
    }

    if (line.includes('"type":"attachment"') && line.includes('"type":"hook_')) {
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        data.badLines++;
        continue;
      }
      if (row?.type !== "attachment" || typeof row.attachment !== "object" || !row.attachment) continue;
      data.sessionId ??= typeof row.sessionId === "string" ? own(row.sessionId) : null;
      data.cwd ??= typeof row.cwd === "string" ? own(row.cwd) : null;
      if (typeof row.gitBranch === "string" && row.gitBranch && row.gitBranch !== data.gitBranch) data.gitBranch = own(row.gitBranch);
      handleAttachment(row, row.attachment);
      continue;
    }

    // Assistant lines put "message" before "type", so the prefix check above cannot see them.
    if (line.includes("tool-results/hook-") && line.includes('"role":"assistant"')) {
      try {
        const row = JSON.parse(line);
        if (row?.type !== "assistant") continue;
        for (const part of row?.message?.content ?? []) {
          const path = part?.type === "tool_use" && part.name === "Read" ? part.input?.file_path : null;
          if (typeof path === "string") data.readPaths.push(own(path));
        }
      } catch {
        data.badLines++;
      }
    }
  }

  return data;

  function handleAttachment(row: any, a: any) {
    const type = String(a.type ?? "");
    const hookEvent = own(String(a.hookEvent ?? ""));
    const hookName = own(String(a.hookName ?? hookEvent));
    const tsMs = tsOf(row.timestamp);
    const sessionId = data.sessionId ?? "";
    const base = { sessionId, agentId, tsMs, promptId, hookEvent, hookName };

    if (typeof a.command === "string" && (type === "hook_success" || "durationMs" in a || "exitCode" in a)) {
      const command = own(a.command);
      data.runs.push({ ...base, command, durationMs: numOrNull(a.durationMs), exitCode: numOrNull(a.exitCode) });
      const ctx = typeof a.stdout === "string" ? contextFromStdout(hookEvent, a.stdout) : null;
      if (ctx) {
        const list = pending.get(hookEvent) ?? [];
        list.push({ command, text: ctx });
        pending.set(hookEvent, list.slice(-50));
      }
    }

    if (type === "hook_additional_context") {
      const parts: unknown[] = Array.isArray(a.content) ? a.content : [a.content];
      const waiting = pending.get(hookEvent) ?? [];
      for (const part of parts) {
        if (typeof part !== "string" || !part) continue;
        data.blocks.push(blockFrom(base, "context", part, waiting));
      }
      pending.delete(hookEvent);
    } else if (type === "hook_blocking_error") {
      const be = a.blockingError;
      const text = typeof be === "string" ? be : typeof be?.blockingError === "string" ? be.blockingError : null;
      if (!text) return;
      const block = blockFrom(base, "blocking_error", text, []);
      block.command = typeof be?.command === "string" ? own(be.command) : null;
      data.blocks.push(block);
    }
  }
}

function blockFrom(
  base: Omit<InjectedBlock, "kind" | "chars" | "tag" | "family" | "signature" | "preview" | "hash" | "command" | "persisted">,
  kind: InjectedBlock["kind"],
  text: string,
  waiting: Pending[],
): InjectedBlock {
  const unwrapped = unwrapPersisted(text);
  const body = unwrapped ? unwrapped.body : text;
  const tag = leadingTag(body);
  const head = body.slice(0, 300);
  const match = waiting.findIndex((p) => p.text === body || (unwrapped !== null && head.length > 0 && p.text.startsWith(head)));
  const command = match === -1 ? null : waiting.splice(match, 1)[0]!.command;
  const p = unwrapped?.persisted ?? null;
  return {
    ...base,
    kind,
    chars: text.length,
    tag: own(tag),
    family: tag?.startsWith("hindsight") ? "hindsight" : null,
    signature: own(signatureOf(body, tag)),
    preview: own((p ? `[persisted ${p.reportedSize ?? "?"}] ` : "") + oneLine(body)),
    hash: hashOf(text),
    command,
    persisted: p ? { reportedSize: own(p.reportedSize), path: own(p.path), readBack: false } : null,
  };
}
