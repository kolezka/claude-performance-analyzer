// Reads what hooks put into the model's context from one Claude Code transcript (JSONL).
// Telemetry only has per-event character totals; the transcript keeps every injected block,
// the command that printed it (when its stdout is recorded) and what the model actually saw.
import { createHash } from "node:crypto";

export interface Persisted {
  // Size as Claude Code reported it ("12.8KB") and where it saved the full output.
  reportedSize: string | null;
  path: string | null;
  // Set later by the caller: whether the agent read the whole saved file back successfully.
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
  // Characters the model saw: the hook text plus its share of the reminder wrapper Claude Code
  // puts around it, when the transcript records that. Persisted output counts as its preview.
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
  // Saved hook output the agent read back in full: a Read with no offset or limit whose result
  // was not an error.
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
// A hook attachment line opens with its attachment object; the outer "type":"attachment" only
// comes after the content, so a line cut short inside the content is recognised by this head.
const ATTACHMENT_HEAD = /^\{[^{]*"attachment":\{"type":"hook_/;
const PENDING_MAX = 200;

// Output a hook printed, waiting to be matched to the context block it became. A tool event's
// run and its block share the tool call id; other events (SessionStart, ...) share no id, so
// they only match within the same prompt. Either way, one firing never feeds another.
interface Pending {
  command: string;
  text: string;
  hookEvent: string;
  promptId: string | null;
  toolUseId: string | null;
}

const isToolCallId = (id: string | null): id is string => id !== null && id.startsWith("toolu_");

function sameFiring(pending: Pending[], hookEvent: string, promptId: string | null, toolUseId: string | null): Pending[] {
  if (isToolCallId(toolUseId)) return pending.filter((p) => p.hookEvent === hookEvent && p.toolUseId === toolUseId);
  return pending.filter((p) => p.hookEvent === hookEvent && p.promptId === promptId && !isToolCallId(p.toolUseId));
}

// Total length of the text Claude Code recorded as sent for this line, or null if not recorded.
function renderedLength(row: any): number | null {
  if (!Array.isArray(row?.rendered)) return null;
  let n = 0;
  for (const r of row.rendered) {
    const c = r?.content;
    if (typeof c === "string") n += c.length;
    else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === "string") n += part.text.length;
  }
  return n;
}

// Spreads the wrapper text (reminder tags, the "<hook> hook additional context:" label, the
// newlines between blocks) over the blocks of one attachment: one separator to each later
// block, the rest to the first.
function addWrapper(blocks: InjectedBlock[], rendered: number | null) {
  if (rendered === null || blocks.length === 0) return;
  const extra = rendered - blocks.reduce((sum, b) => sum + b.chars, 0);
  if (extra <= 0) return;
  const separators = Math.min(blocks.length - 1, extra);
  for (let i = 1; i <= separators; i++) blocks[i]!.chars += 1;
  blocks[0]!.chars += extra - separators;
}

// The command whose printed output this block is: exact text, or for persisted output, the
// command whose full output starts with the whole preview. Two different commands matching
// means the transcript cannot tell them apart, so nobody gets it. A match is used up.
function takeCommand(pending: Pending[], candidates: Pending[], body: string, persisted: boolean): string | null {
  const hits = candidates.filter((p) => p.text === body || (persisted && body.length > 0 && p.text.startsWith(body)));
  if (hits.length === 0 || new Set(hits.map((h) => h.command)).size !== 1) return null;
  for (const list of [pending, candidates]) {
    const i = list.indexOf(hits[0]!);
    if (i !== -1) list.splice(i, 1);
  }
  return hits[0]!.command;
}

// Whether a Read's result covered the whole file. Claude Code records the returned line range
// in toolUseResult.file; without it, only a request with no offset or limit counts.
function readWholeFile(row: any): boolean {
  const file = row?.toolUseResult?.file;
  if (!file || typeof file !== "object") return true;
  const { startLine, numLines, totalLines } = file;
  if (typeof startLine !== "number" || typeof numLines !== "number" || typeof totalLines !== "number") return true;
  return startLine <= 1 && numLines >= totalLines;
}

export function parseTranscript(text: string, agentId: string | null = null, sessionId: string | null = null): TranscriptData {
  const data: TranscriptData = {
    sessionId,
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
  let pending: Pending[] = [];
  // Whole-file Reads of saved hook output, waiting for their tool result.
  const pendingReads = new Map<string, string>();

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
      userLine(line, prefix);
      continue;
    }

    if (line.includes('"type":"hook_') && (line.includes('"type":"attachment"') || ATTACHMENT_HEAD.test(line.slice(0, 400)))) {
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        data.badLines++;
        continue;
      }
      if (row?.type !== "attachment" || typeof row.attachment !== "object" || !row.attachment) continue;
      lineContext(row);
      handleAttachment(row, row.attachment);
      continue;
    }

    // Assistant lines put "message" before "type", so the prefix check above cannot see them.
    if (line.includes("tool-results/hook-") && line.includes('"role":"assistant"')) {
      try {
        const row = JSON.parse(line);
        if (row?.type !== "assistant") continue;
        for (const part of row?.message?.content ?? []) {
          if (part?.type !== "tool_use" || part.name !== "Read" || typeof part.id !== "string") continue;
          const input = part.input ?? {};
          if (typeof input.file_path !== "string" || input.offset != null || input.limit != null) continue;
          pendingReads.set(own(part.id), own(input.file_path));
        }
      } catch {
        data.badLines++;
      }
    }
  }

  return data;

  // Session, folder and branch, from whichever line first carries them.
  function lineContext(row: any) {
    if (data.sessionId === null && typeof row.sessionId === "string") data.sessionId = own(row.sessionId);
    if (data.cwd === null && typeof row.cwd === "string") data.cwd = own(row.cwd);
    if (typeof row.gitBranch === "string" && row.gitBranch && row.gitBranch !== data.gitBranch) data.gitBranch = own(row.gitBranch);
  }

  function userLine(line: string, prefix: string) {
    const matched = prefix.match(PROMPT_ID)?.[1];
    if (matched && matched !== promptId) {
      const id = own(matched);
      promptId = id;
      if (!seenPrompts.has(id)) {
        seenPrompts.add(id);
        data.prompts.push({ id, tsMs: tsOf(line.match(TIMESTAMP)?.[1]) });
        // A session can have no hook lines at all; its first prompt still says where it ran.
        if (data.cwd === null || data.sessionId === null) {
          try {
            lineContext(JSON.parse(line));
          } catch {
            // Not a hook line; a prompt cut short only costs the folder name.
          }
        }
      }
    }
    if (pendingReads.size === 0 || !line.includes('"tool_result"')) return;
    if (![...pendingReads.keys()].some((id) => line.includes(id))) return;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    for (const part of Array.isArray(row?.message?.content) ? row.message.content : []) {
      const path = part?.type === "tool_result" ? pendingReads.get(part.tool_use_id) : undefined;
      if (path === undefined) continue;
      pendingReads.delete(part.tool_use_id);
      if (part.is_error !== true && readWholeFile(row)) data.readPaths.push(path);
    }
  }

  function handleAttachment(row: any, a: any) {
    const type = String(a.type ?? "");
    const hookEvent = own(String(a.hookEvent ?? ""));
    const hookName = own(String(a.hookName ?? hookEvent));
    const tsMs = tsOf(row.timestamp);
    const toolUseId = typeof a.toolUseID === "string" ? a.toolUseID : null;
    const base = { sessionId: data.sessionId ?? "", agentId, tsMs, promptId, hookEvent, hookName };

    if (typeof a.command === "string" && (type === "hook_success" || "durationMs" in a || "exitCode" in a)) {
      const command = own(a.command);
      data.runs.push({ ...base, command, durationMs: numOrNull(a.durationMs), exitCode: numOrNull(a.exitCode) });
      const ctx = typeof a.stdout === "string" ? contextFromStdout(hookEvent, a.stdout) : null;
      if (ctx) {
        pending.push({ command, text: ctx, hookEvent, promptId, toolUseId: toolUseId === null ? null : own(toolUseId) });
        if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX);
      }
    }

    if (type === "hook_additional_context") {
      const parts: unknown[] = Array.isArray(a.content) ? a.content : [a.content];
      const candidates = sameFiring(pending, hookEvent, promptId, toolUseId);
      const made: InjectedBlock[] = [];
      for (const part of parts) {
        if (typeof part !== "string" || !part) continue;
        made.push(blockFrom(base, "context", part, pending, candidates));
      }
      addWrapper(made, renderedLength(row));
      data.blocks.push(...made);
    } else if (type === "hook_blocking_error") {
      const be = a.blockingError;
      const text = typeof be === "string" ? be : typeof be?.blockingError === "string" ? be.blockingError : null;
      if (!text) return;
      const block = blockFrom(base, "blocking_error", text, [], []);
      block.command = typeof be?.command === "string" ? own(be.command) : null;
      addWrapper([block], renderedLength(row));
      data.blocks.push(block);
    }
  }
}

function blockFrom(
  base: Omit<InjectedBlock, "kind" | "chars" | "tag" | "family" | "signature" | "preview" | "hash" | "command" | "persisted">,
  kind: InjectedBlock["kind"],
  text: string,
  pending: Pending[],
  candidates: Pending[],
): InjectedBlock {
  const unwrapped = unwrapPersisted(text);
  const body = unwrapped ? unwrapped.body : text;
  const tag = leadingTag(body);
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
    command: takeCommand(pending, candidates, body, unwrapped !== null),
    persisted: p ? { reportedSize: own(p.reportedSize), path: own(p.path), readBack: false } : null,
  };
}
