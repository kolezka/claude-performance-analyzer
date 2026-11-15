#!/usr/bin/env bun
// @bun

// apps/mcp/src/protocol.ts
var PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function fail(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function createServer(info, tools) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  async function handle(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg))
      return fail(null, -32600, "Invalid request");
    const { id, method, params } = msg;
    if (id === undefined)
      return null;
    if (typeof method !== "string")
      return fail(id, -32600, "Invalid request");
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...info.instructions ? { instructions: info.instructions } : {}
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool)
          return fail(id, -32602, `Unknown tool: ${params?.name}`);
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        try {
          const text = await tool.run(args);
          return reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          return reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }
  return { handle };
}
async function serveStdio(server, input = Bun.stdin.stream()) {
  const decoder = new TextDecoder;
  let buffer = "";
  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}
`);
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf(`
`)) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line)
        continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write(fail(null, -32700, "Parse error"));
        continue;
      }
      const res = await server.handle(msg);
      if (res)
        write(res);
    }
  }
}

// packages/analytics/src/index.ts
function percentile(sorted, p) {
  if (sorted.length === 0)
    return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[idx];
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
var IDLE_GAP_MS = 120000;
var DURATION_EVENT_FIELD = {
  api_request: "duration_ms",
  tool_result: "duration_ms",
  hook_execution_complete: "total_duration_ms",
  subagent_completed: "duration_ms",
  compaction: "duration_ms"
};
function spanStartMs(e) {
  const field = DURATION_EVENT_FIELD[e.name];
  const duration = field ? Math.max(0, num(e.attrs[field])) : 0;
  return e.tsMs - duration;
}
function idleGaps(events, startMs, endMs) {
  const clamp = (ms) => Math.max(startMs, Math.min(endMs, ms));
  const intervals = events.map((e) => [clamp(spanStartMs(e)), clamp(e.tsMs)]).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = startMs;
  for (const [start, end] of intervals) {
    if (start - cursor >= IDLE_GAP_MS)
      gaps.push({ startMs: cursor, endMs: start });
    if (end > cursor)
      cursor = end;
  }
  if (endMs - cursor >= IDLE_GAP_MS)
    gaps.push({ startMs: cursor, endMs });
  const idleMs = gaps.reduce((s, g) => s + (g.endMs - g.startMs), 0);
  return { gaps, idleMs, activeMs: Math.max(0, endMs - startMs - idleMs) };
}
function promptBreakdowns(events) {
  const prompts = new Map;
  const eventsByPrompt = new Map;
  const sawUserPrompt = new Set;
  const upsert = (e) => {
    if (!e.promptId)
      return null;
    let p = prompts.get(e.promptId);
    if (!p) {
      const s0 = spanStartMs(e);
      p = {
        promptId: e.promptId,
        sessionId: e.sessionId,
        startMs: s0,
        endMs: e.tsMs,
        wallMs: e.tsMs - s0,
        activeMs: 0,
        idleMs: 0,
        apiMs: 0,
        toolMs: 0,
        hookMs: 0,
        apiCalls: 0,
        toolCalls: 0,
        costUsd: 0,
        command: null
      };
      prompts.set(e.promptId, p);
      eventsByPrompt.set(e.promptId, []);
    }
    eventsByPrompt.get(e.promptId).push(e);
    if (!p.sessionId && e.sessionId)
      p.sessionId = e.sessionId;
    p.startMs = Math.min(p.startMs, spanStartMs(e));
    p.endMs = Math.max(p.endMs, e.tsMs);
    p.wallMs = p.endMs - p.startMs;
    return p;
  };
  for (const e of events) {
    const p = upsert(e);
    if (!p)
      continue;
    const a = e.attrs;
    switch (e.name) {
      case "user_prompt":
        if (e.promptId)
          sawUserPrompt.add(e.promptId);
        if (a.command_name)
          p.command = String(a.command_name);
        break;
      case "api_request":
        p.apiMs += num(a.duration_ms);
        p.apiCalls++;
        p.costUsd += num(a.cost_usd);
        break;
      case "tool_result":
        p.toolMs += num(a.duration_ms);
        p.toolCalls++;
        break;
      case "hook_execution_complete":
        p.hookMs += num(a.total_duration_ms);
        break;
    }
  }
  for (const id of [...prompts.keys()]) {
    if (!sawUserPrompt.has(id))
      prompts.delete(id);
  }
  for (const p of prompts.values()) {
    const { idleMs, activeMs } = idleGaps(eventsByPrompt.get(p.promptId) ?? [], p.startMs, p.endMs);
    p.idleMs = idleMs;
    p.activeMs = activeMs;
  }
  return prompts;
}
function fmtMs(ms) {
  if (ms < 1000)
    return `${Math.round(ms)}ms`;
  if (ms < 60000)
    return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)
    return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}
var POST_HOOK_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);

// apps/mcp/src/errors.ts
class UserError extends Error {
}

// apps/mcp/src/locate.ts
import { readdirSync, statSync } from "fs";
import { basename, join as join2 } from "path";

// packages/claude-settings/src/index.ts
import { homedir } from "os";

// node_modules/.bun/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/scanner.js
var CharacterCodes;
(function(CharacterCodes) {
  CharacterCodes[CharacterCodes["lineFeed"] = 10] = "lineFeed";
  CharacterCodes[CharacterCodes["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes[CharacterCodes["space"] = 32] = "space";
  CharacterCodes[CharacterCodes["_0"] = 48] = "_0";
  CharacterCodes[CharacterCodes["_1"] = 49] = "_1";
  CharacterCodes[CharacterCodes["_2"] = 50] = "_2";
  CharacterCodes[CharacterCodes["_3"] = 51] = "_3";
  CharacterCodes[CharacterCodes["_4"] = 52] = "_4";
  CharacterCodes[CharacterCodes["_5"] = 53] = "_5";
  CharacterCodes[CharacterCodes["_6"] = 54] = "_6";
  CharacterCodes[CharacterCodes["_7"] = 55] = "_7";
  CharacterCodes[CharacterCodes["_8"] = 56] = "_8";
  CharacterCodes[CharacterCodes["_9"] = 57] = "_9";
  CharacterCodes[CharacterCodes["a"] = 97] = "a";
  CharacterCodes[CharacterCodes["b"] = 98] = "b";
  CharacterCodes[CharacterCodes["c"] = 99] = "c";
  CharacterCodes[CharacterCodes["d"] = 100] = "d";
  CharacterCodes[CharacterCodes["e"] = 101] = "e";
  CharacterCodes[CharacterCodes["f"] = 102] = "f";
  CharacterCodes[CharacterCodes["g"] = 103] = "g";
  CharacterCodes[CharacterCodes["h"] = 104] = "h";
  CharacterCodes[CharacterCodes["i"] = 105] = "i";
  CharacterCodes[CharacterCodes["j"] = 106] = "j";
  CharacterCodes[CharacterCodes["k"] = 107] = "k";
  CharacterCodes[CharacterCodes["l"] = 108] = "l";
  CharacterCodes[CharacterCodes["m"] = 109] = "m";
  CharacterCodes[CharacterCodes["n"] = 110] = "n";
  CharacterCodes[CharacterCodes["o"] = 111] = "o";
  CharacterCodes[CharacterCodes["p"] = 112] = "p";
  CharacterCodes[CharacterCodes["q"] = 113] = "q";
  CharacterCodes[CharacterCodes["r"] = 114] = "r";
  CharacterCodes[CharacterCodes["s"] = 115] = "s";
  CharacterCodes[CharacterCodes["t"] = 116] = "t";
  CharacterCodes[CharacterCodes["u"] = 117] = "u";
  CharacterCodes[CharacterCodes["v"] = 118] = "v";
  CharacterCodes[CharacterCodes["w"] = 119] = "w";
  CharacterCodes[CharacterCodes["x"] = 120] = "x";
  CharacterCodes[CharacterCodes["y"] = 121] = "y";
  CharacterCodes[CharacterCodes["z"] = 122] = "z";
  CharacterCodes[CharacterCodes["A"] = 65] = "A";
  CharacterCodes[CharacterCodes["B"] = 66] = "B";
  CharacterCodes[CharacterCodes["C"] = 67] = "C";
  CharacterCodes[CharacterCodes["D"] = 68] = "D";
  CharacterCodes[CharacterCodes["E"] = 69] = "E";
  CharacterCodes[CharacterCodes["F"] = 70] = "F";
  CharacterCodes[CharacterCodes["G"] = 71] = "G";
  CharacterCodes[CharacterCodes["H"] = 72] = "H";
  CharacterCodes[CharacterCodes["I"] = 73] = "I";
  CharacterCodes[CharacterCodes["J"] = 74] = "J";
  CharacterCodes[CharacterCodes["K"] = 75] = "K";
  CharacterCodes[CharacterCodes["L"] = 76] = "L";
  CharacterCodes[CharacterCodes["M"] = 77] = "M";
  CharacterCodes[CharacterCodes["N"] = 78] = "N";
  CharacterCodes[CharacterCodes["O"] = 79] = "O";
  CharacterCodes[CharacterCodes["P"] = 80] = "P";
  CharacterCodes[CharacterCodes["Q"] = 81] = "Q";
  CharacterCodes[CharacterCodes["R"] = 82] = "R";
  CharacterCodes[CharacterCodes["S"] = 83] = "S";
  CharacterCodes[CharacterCodes["T"] = 84] = "T";
  CharacterCodes[CharacterCodes["U"] = 85] = "U";
  CharacterCodes[CharacterCodes["V"] = 86] = "V";
  CharacterCodes[CharacterCodes["W"] = 87] = "W";
  CharacterCodes[CharacterCodes["X"] = 88] = "X";
  CharacterCodes[CharacterCodes["Y"] = 89] = "Y";
  CharacterCodes[CharacterCodes["Z"] = 90] = "Z";
  CharacterCodes[CharacterCodes["asterisk"] = 42] = "asterisk";
  CharacterCodes[CharacterCodes["backslash"] = 92] = "backslash";
  CharacterCodes[CharacterCodes["closeBrace"] = 125] = "closeBrace";
  CharacterCodes[CharacterCodes["closeBracket"] = 93] = "closeBracket";
  CharacterCodes[CharacterCodes["colon"] = 58] = "colon";
  CharacterCodes[CharacterCodes["comma"] = 44] = "comma";
  CharacterCodes[CharacterCodes["dot"] = 46] = "dot";
  CharacterCodes[CharacterCodes["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes[CharacterCodes["minus"] = 45] = "minus";
  CharacterCodes[CharacterCodes["openBrace"] = 123] = "openBrace";
  CharacterCodes[CharacterCodes["openBracket"] = 91] = "openBracket";
  CharacterCodes[CharacterCodes["plus"] = 43] = "plus";
  CharacterCodes[CharacterCodes["slash"] = 47] = "slash";
  CharacterCodes[CharacterCodes["formFeed"] = 12] = "formFeed";
  CharacterCodes[CharacterCodes["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/.bun/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + " ".repeat(index);
    })
  },
  "\t": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + "\t".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "\t".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + "\t".repeat(index);
    })
  }
};

// node_modules/.bun/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions) {
  ParseOptions.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));

// node_modules/.bun/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError) {
  ScanError[ScanError["None"] = 0] = "None";
  ScanError[ScanError["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError[ScanError["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError[ScanError["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError[ScanError["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError[ScanError["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError[ScanError["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind) {
  SyntaxKind[SyntaxKind["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind[SyntaxKind["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind[SyntaxKind["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind[SyntaxKind["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind[SyntaxKind["CommaToken"] = 5] = "CommaToken";
  SyntaxKind[SyntaxKind["ColonToken"] = 6] = "ColonToken";
  SyntaxKind[SyntaxKind["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind[SyntaxKind["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind[SyntaxKind["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind[SyntaxKind["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind[SyntaxKind["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind[SyntaxKind["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind[SyntaxKind["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind[SyntaxKind["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind[SyntaxKind["Trivia"] = 15] = "Trivia";
  SyntaxKind[SyntaxKind["Unknown"] = 16] = "Unknown";
  SyntaxKind[SyntaxKind["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var ParseErrorCode;
(function(ParseErrorCode) {
  ParseErrorCode[ParseErrorCode["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode[ParseErrorCode["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode[ParseErrorCode["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode[ParseErrorCode["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode[ParseErrorCode["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode[ParseErrorCode["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode[ParseErrorCode["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode[ParseErrorCode["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode[ParseErrorCode["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode[ParseErrorCode["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode[ParseErrorCode["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode[ParseErrorCode["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode[ParseErrorCode["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode[ParseErrorCode["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));

// packages/claude-settings/src/index.ts
import { dirname, join } from "path";
function claudeDir() {
  return process.env.CC_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// apps/mcp/src/transcript.ts
import { createHash } from "crypto";
var PERSISTED_HEAD = "<persisted-output>";
var PERSISTED_SIZE = /Output too large \(([^)]+)\)\. Full output saved to: (\S+)/;
var PREVIEW_MARK = /\nPreview \(first [^)]*\):\n/;
function leadingTag(text) {
  const m = text.match(/^\s*<([A-Za-z][\w-]*)[\s>]/);
  return m ? m[1] : null;
}
function signatureOf(text, tag) {
  if (tag)
    return `<${tag}>`;
  const first = text.trimStart().split(`
`, 1)[0] ?? "";
  return first.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
}
function oneLine(text, max = 90) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
function own(s) {
  return s === null ? null : Buffer.from(s, "utf8").toString("utf8");
}
function hashOf(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}
function unwrapPersisted(text) {
  if (!text.startsWith(PERSISTED_HEAD))
    return null;
  const size = text.match(PERSISTED_SIZE);
  const mark = text.match(PREVIEW_MARK);
  let body = mark && mark.index !== undefined ? text.slice(mark.index + mark[0].length) : "";
  body = body.replace(/\n?(\.\.\.\n)?<\/persisted-output>\s*$/, "");
  return { persisted: { reportedSize: size?.[1] ?? null, path: size?.[2] ?? null, readBack: false }, body };
}
function contextFromStdout(hookEvent, stdout) {
  const trimmed = stdout.trim();
  if (!trimmed)
    return null;
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
function tsOf(v) {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
var PROMPT_ID = /"promptId":"([^"]+)"/;
var TIMESTAMP = /"timestamp":"([^"]+)"/;
var ATTACHMENT_HEAD = /^\{[^{]*"attachment":\{"type":"hook_/;
var PENDING_MAX = 200;
var isToolCallId = (id) => id !== null && id.startsWith("toolu_");
function sameFiring(pending, hookEvent, promptId, toolUseId) {
  if (isToolCallId(toolUseId))
    return pending.filter((p) => p.hookEvent === hookEvent && p.toolUseId === toolUseId);
  return pending.filter((p) => p.hookEvent === hookEvent && p.promptId === promptId && !isToolCallId(p.toolUseId));
}
function renderedLength(row) {
  if (!Array.isArray(row?.rendered))
    return null;
  let n = 0;
  for (const r of row.rendered) {
    const c = r?.content;
    if (typeof c === "string")
      n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c)
        if (typeof part?.text === "string")
          n += part.text.length;
    }
  }
  return n;
}
function addWrapper(blocks, rendered) {
  if (rendered === null || blocks.length === 0)
    return;
  const extra = rendered - blocks.reduce((sum, b) => sum + b.chars, 0);
  if (extra <= 0)
    return;
  const separators = Math.min(blocks.length - 1, extra);
  for (let i = 1;i <= separators; i++)
    blocks[i].chars += 1;
  blocks[0].chars += extra - separators;
}
function takeCommand(pending, candidates, body, persisted) {
  const hits = candidates.filter((p) => p.text === body || persisted && body.length > 0 && p.text.startsWith(body));
  if (hits.length === 0 || new Set(hits.map((h) => h.command)).size !== 1)
    return null;
  for (const list of [pending, candidates]) {
    const i = list.indexOf(hits[0]);
    if (i !== -1)
      list.splice(i, 1);
  }
  return hits[0].command;
}
function readWholeFile(row) {
  const file = row?.toolUseResult?.file;
  if (!file || typeof file !== "object")
    return true;
  const { startLine, numLines, totalLines } = file;
  if (typeof startLine !== "number" || typeof numLines !== "number" || typeof totalLines !== "number")
    return true;
  return startLine <= 1 && numLines >= totalLines;
}
function parseTranscript(text, agentId = null, sessionId = null) {
  const data = {
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
    badLines: 0
  };
  const seenPrompts = new Set;
  let promptId = null;
  let pending = [];
  const pendingReads = new Map;
  const lines = text.split(`
`);
  const edgeTs = (from, step) => {
    for (let i = from, seen = 0;i >= 0 && i < lines.length && seen < 200; i += step, seen++) {
      const ms = tsOf(lines[i].match(TIMESTAMP)?.[1]);
      if (ms)
        return ms;
    }
    return null;
  };
  data.firstMs = edgeTs(0, 1);
  data.lastMs = edgeTs(lines.length - 1, -1);
  for (const line of lines) {
    if (!line)
      continue;
    const prefixEnd = line.indexOf("{", 1);
    const prefix = prefixEnd === -1 ? line : line.slice(0, prefixEnd);
    if (prefix.includes('"type":"user"')) {
      userLine(line, prefix);
      continue;
    }
    if (line.includes('"type":"hook_') && (line.includes('"type":"attachment"') || ATTACHMENT_HEAD.test(line.slice(0, 400)))) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        data.badLines++;
        continue;
      }
      if (row?.type !== "attachment" || typeof row.attachment !== "object" || !row.attachment)
        continue;
      lineContext(row);
      handleAttachment(row, row.attachment);
      continue;
    }
    if (line.includes("tool-results/hook-") && line.includes('"role":"assistant"')) {
      try {
        const row = JSON.parse(line);
        if (row?.type !== "assistant")
          continue;
        for (const part of row?.message?.content ?? []) {
          if (part?.type !== "tool_use" || part.name !== "Read" || typeof part.id !== "string")
            continue;
          const input = part.input ?? {};
          if (typeof input.file_path !== "string" || input.offset != null || input.limit != null)
            continue;
          pendingReads.set(own(part.id), own(input.file_path));
        }
      } catch {
        data.badLines++;
      }
    }
  }
  return data;
  function lineContext(row) {
    if (data.sessionId === null && typeof row.sessionId === "string")
      data.sessionId = own(row.sessionId);
    if (data.cwd === null && typeof row.cwd === "string")
      data.cwd = own(row.cwd);
    if (typeof row.gitBranch === "string" && row.gitBranch && row.gitBranch !== data.gitBranch)
      data.gitBranch = own(row.gitBranch);
  }
  function userLine(line, prefix) {
    const matched = prefix.match(PROMPT_ID)?.[1];
    if (matched && matched !== promptId) {
      const id = own(matched);
      promptId = id;
      if (!seenPrompts.has(id)) {
        seenPrompts.add(id);
        data.prompts.push({ id, tsMs: tsOf(line.match(TIMESTAMP)?.[1]) });
        if (data.cwd === null || data.sessionId === null) {
          try {
            lineContext(JSON.parse(line));
          } catch {}
        }
      }
    }
    if (pendingReads.size === 0 || !line.includes('"tool_result"'))
      return;
    if (![...pendingReads.keys()].some((id) => line.includes(id)))
      return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    for (const part of Array.isArray(row?.message?.content) ? row.message.content : []) {
      const path = part?.type === "tool_result" ? pendingReads.get(part.tool_use_id) : undefined;
      if (path === undefined)
        continue;
      pendingReads.delete(part.tool_use_id);
      if (part.is_error !== true && readWholeFile(row))
        data.readPaths.push(path);
    }
  }
  function handleAttachment(row, a) {
    const type = String(a.type ?? "");
    const hookEvent = own(String(a.hookEvent ?? ""));
    const hookName = own(String(a.hookName ?? hookEvent));
    const tsMs = tsOf(row.timestamp);
    const toolUseId = typeof a.toolUseID === "string" ? a.toolUseID : null;
    const base = { sessionId: data.sessionId ?? "", agentId, tsMs, promptId, hookEvent, hookName };
    if (typeof a.command === "string" && (type === "hook_success" || ("durationMs" in a) || ("exitCode" in a))) {
      const command = own(a.command);
      data.runs.push({ ...base, command, durationMs: numOrNull(a.durationMs), exitCode: numOrNull(a.exitCode) });
      const ctx = typeof a.stdout === "string" ? contextFromStdout(hookEvent, a.stdout) : null;
      if (ctx) {
        pending.push({ command, text: ctx, hookEvent, promptId, toolUseId: toolUseId === null ? null : own(toolUseId) });
        if (pending.length > PENDING_MAX)
          pending = pending.slice(-PENDING_MAX);
      }
    }
    if (type === "hook_additional_context") {
      const parts = Array.isArray(a.content) ? a.content : [a.content];
      const candidates = sameFiring(pending, hookEvent, promptId, toolUseId);
      const made = [];
      for (const part of parts) {
        if (typeof part !== "string" || !part)
          continue;
        made.push(blockFrom(base, "context", part, pending, candidates));
      }
      addWrapper(made, renderedLength(row));
      data.blocks.push(...made);
    } else if (type === "hook_blocking_error") {
      const be = a.blockingError;
      const text = typeof be === "string" ? be : typeof be?.blockingError === "string" ? be.blockingError : null;
      if (!text)
        return;
      const block = blockFrom(base, "blocking_error", text, [], []);
      block.command = typeof be?.command === "string" ? own(be.command) : null;
      addWrapper([block], renderedLength(row));
      data.blocks.push(block);
    }
  }
}
function blockFrom(base, kind, text, pending, candidates) {
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
    persisted: p ? { reportedSize: own(p.reportedSize), path: own(p.path), readBack: false } : null
  };
}

// apps/mcp/src/locate.ts
function projectsDir() {
  return join2(claudeDir(), "projects");
}
function projectFolders() {
  const root = projectsDir();
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join2(root, d.name));
  } catch (err) {
    throw new UserError(`Cannot read transcripts at ${root}: ${err.message}`);
  }
}
function list(path, unreadable) {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return {
      files: entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join2(path, e.name)),
      dirs: entries.filter((e) => e.isDirectory()).map((e) => join2(path, e.name))
    };
  } catch (err) {
    if (unreadable && err.code !== "ENOENT")
      unreadable.push(path);
    return { files: [], dirs: [] };
  }
}
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function subagentFiles(projectDir, sessionId, unreadable) {
  return list(join2(projectDir, sessionId, "subagents"), unreadable).files;
}
function findSession(idOrPrefix) {
  const found = new Map;
  const unreadable = [];
  for (const dir of projectFolders()) {
    for (const file of list(dir, unreadable).files) {
      const id = basename(file, ".jsonl");
      if (id !== idOrPrefix && !(idOrPrefix.length >= 8 && id.startsWith(idOrPrefix)))
        continue;
      const entry = found.get(id) ?? { sessionId: id, main: null, subagents: [] };
      entry.main ??= file;
      entry.subagents.push(...subagentFiles(dir, id, unreadable));
      found.set(id, entry);
    }
  }
  return { sessions: [...found.values()], unreadable };
}
function recentSessions(sinceMs) {
  const found = new Map;
  const unreadable = [];
  for (const dir of projectFolders()) {
    const listing = list(dir, unreadable);
    const mains = new Map(listing.files.map((f) => [basename(f, ".jsonl"), f]));
    const ids = new Set([...mains.keys(), ...listing.dirs.map((d) => basename(d))]);
    for (const id of ids) {
      const main = mains.get(id) ?? null;
      const subs = subagentFiles(dir, id, unreadable);
      const touched = main !== null && mtimeMs(main) >= sinceMs || subs.some((s) => mtimeMs(s) >= sinceMs);
      if (!touched)
        continue;
      const entry = found.get(id) ?? { sessionId: id, main: null, subagents: [] };
      entry.main ??= main;
      entry.subagents.push(...subs);
      found.set(id, entry);
    }
  }
  return { sessions: [...found.values()], unreadable };
}
var cache = new Map;
var CACHE_MAX = 2000;
var GC_EVERY_BYTES = 64 * 1024 * 1024;
var bytesSinceGc = 0;
async function readTranscript(path, agentId, sessionId) {
  const st = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs)
    return hit.data;
  const data = parseTranscript(await Bun.file(path).text(), agentId, sessionId);
  bytesSinceGc += st.size;
  if (bytesSinceGc >= GC_EVERY_BYTES) {
    bytesSinceGc = 0;
    Bun.gc(true);
  }
  if (cache.size >= CACHE_MAX)
    cache.delete(cache.keys().next().value);
  cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, data });
  return data;
}
async function loadSession(files) {
  const main = files.main ? await readTranscript(files.main, null, files.sessionId) : null;
  const subagents = [];
  for (const path of files.subagents) {
    subagents.push(await readTranscript(path, basename(path, ".jsonl").replace(/^agent-/, ""), files.sessionId));
  }
  const all = [main, ...subagents].filter((d) => d !== null);
  const firsts = all.map((d) => d.firstMs).filter((v) => v !== null);
  const lasts = all.map((d) => d.lastMs).filter((v) => v !== null);
  return {
    sessionId: files.sessionId,
    cwd: main?.cwd ?? all.find((d) => d.cwd)?.cwd ?? null,
    gitBranch: main?.gitBranch ?? null,
    firstMs: firsts.length ? Math.min(...firsts) : null,
    lastMs: lasts.length ? Math.max(...lasts) : null,
    prompts: main?.prompts ?? [],
    main,
    subagents,
    badLines: all.reduce((sum, d) => sum + d.badLines, 0)
  };
}

// apps/collector/src/hooks.ts
import { existsSync, readFileSync } from "fs";
import { basename as basename2, join as join3 } from "path";

// apps/collector/src/bounded-cache.ts
class BoundedCache {
  maxSize;
  ttlMs;
  map = new Map;
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }
  get(key, now = Date.now()) {
    const hit = this.map.get(key);
    if (!hit)
      return;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return;
    }
    return hit.value;
  }
  set(key, value, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined)
        this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

// apps/collector/src/hooks.ts
function splitHookItemName(name) {
  const i = name.indexOf(":");
  return i === -1 ? { event: name, matcherTarget: null } : { event: name.slice(0, i), matcherTarget: name.slice(i + 1) };
}
var LITERAL_ALTERNATION = /^[\w.:-]+(\|[\w.:-]+)*$/;
var NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)[+*{?]/;
var MAX_MATCHER_LEN = 200;
var matcherAppliesCache = new Map;
function matcherApplies(matcher, target) {
  if (target === null)
    return true;
  if (!matcher || matcher === "*")
    return true;
  const cacheKey = `${matcher}\x00${target}`;
  const cached = matcherAppliesCache.get(cacheKey);
  if (cached !== undefined)
    return cached;
  let result;
  if (LITERAL_ALTERNATION.test(matcher)) {
    result = matcher.split("|").includes(target);
  } else if (matcher.length > MAX_MATCHER_LEN || target.length > MAX_MATCHER_LEN || NESTED_QUANTIFIER.test(matcher)) {
    result = matcher === target;
  } else {
    try {
      result = new RegExp(`^(?:${matcher})$`).test(target);
    } catch {
      result = matcher === target;
    }
  }
  matcherAppliesCache.set(cacheKey, result);
  return result;
}
var INTERPRETERS = ["node", "python3", "python", "python2", "bun", "bunx", "bash", "sh", "zsh", "ts-node", "deno", "ruby", "perl"];
function hookSummary(command) {
  const m = command.match(/[^\s"'`]+\.(sh|py|js|mjs|cjs|ts|rb|pl)\b/);
  if (m) {
    const name = basename2(m[0]);
    const firstWord = command.trim().split(/\s+/)[0] ?? "";
    const interp = INTERPRETERS.find((w) => firstWord === w || firstWord.endsWith(`/${w}`));
    return interp ? `${interp} ${name}` : name;
  }
  const collapsed = command.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? collapsed.slice(0, 80) : collapsed;
}
var CONFIG_CACHE_MS = 1e4;
var CONFIG_CACHE_MAX = 200;
var configCache = new BoundedCache(CONFIG_CACHE_MAX, CONFIG_CACHE_MS);
function readJsonCached(path) {
  const hit = configCache.get(path);
  if (hit !== undefined)
    return hit;
  let data = null;
  try {
    if (existsSync(path))
      data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = null;
  }
  configCache.set(path, data);
  return data;
}
function registrationFromEvent(e) {
  const a = e.attrs;
  const hookEvent = a.hook_event;
  const hookSource = a.hook_source;
  if (typeof hookEvent !== "string" || typeof hookSource !== "string")
    return null;
  if (hookSource !== "pluginHook" && hookSource !== "userSettings" && hookSource !== "projectSettings")
    return null;
  return {
    sessionId: e.sessionId,
    hookEvent,
    hookSource,
    pluginName: typeof a["plugin.name"] === "string" ? a["plugin.name"] : null,
    hookMatcher: typeof a.hook_matcher === "string" && a.hook_matcher !== "" ? a.hook_matcher : null
  };
}
function resolvePluginHookConfig(pluginName) {
  const installed = readJsonCached(join3(claudeDir(), "plugins", "installed_plugins.json"));
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object")
    return null;
  const candidates = [];
  for (const [key, list] of Object.entries(plugins)) {
    if (key.split("@")[0] !== pluginName)
      continue;
    if (Array.isArray(list))
      candidates.push(...list);
  }
  if (!candidates.length)
    return null;
  const chosen = candidates.sort((a, b) => (Date.parse(b?.lastUpdated ?? "") || 0) - (Date.parse(a?.lastUpdated ?? "") || 0))[0];
  const installPath = chosen?.installPath;
  if (typeof installPath !== "string")
    return null;
  const hooksJsonPath = join3(installPath, "hooks", "hooks.json");
  const hooksJson = readJsonCached(hooksJsonPath);
  if (hooksJson?.hooks && typeof hooksJson.hooks === "object")
    return { entries: hooksJson.hooks, configPath: hooksJsonPath };
  const pluginJsonPath = join3(installPath, ".claude-plugin", "plugin.json");
  const pluginJson = readJsonCached(pluginJsonPath);
  if (pluginJson?.hooks === undefined)
    return null;
  if (typeof pluginJson.hooks === "string") {
    const refPath = join3(installPath, pluginJson.hooks);
    const ref = readJsonCached(refPath);
    const entries = ref?.hooks && typeof ref.hooks === "object" ? ref.hooks : ref;
    return entries && typeof entries === "object" ? { entries, configPath: refPath } : null;
  }
  if (typeof pluginJson.hooks === "object")
    return { entries: pluginJson.hooks, configPath: pluginJsonPath };
  return null;
}
function entriesFor(config, event) {
  const entries = config?.[event];
  return Array.isArray(entries) ? entries : [];
}
function definitionsFromEntries(entries, source, plugin, matcherTarget, sessions, configPath) {
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const matcher = typeof entry.matcher === "string" ? entry.matcher : null;
    if (!matcherApplies(matcher, matcherTarget))
      continue;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (!hook || typeof hook !== "object" || Array.isArray(hook) || typeof hook.type !== "string")
        continue;
      const command = typeof hook.command === "string" ? hook.command : null;
      const timeoutSec = typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : null;
      out.push({ source, plugin, matcher, type: hook.type, command, summary: hookSummary(command ?? ""), sessions, configPath, timeoutSec });
    }
  }
  return out;
}
function buildHookDefinitions(itemName, registeredRows, repoRootForSession, context) {
  const { event, matcherTarget } = splitHookItemName(itemName);
  const groups = new Map;
  for (const e of registeredRows) {
    const reg = registrationFromEvent(e);
    if (!reg || reg.hookEvent !== event)
      continue;
    if (!matcherApplies(reg.hookMatcher, matcherTarget))
      continue;
    const key = `${reg.hookSource}|${reg.pluginName ?? ""}|${reg.hookMatcher ?? ""}`;
    let g = groups.get(key);
    if (!g)
      groups.set(key, g = { hookSource: reg.hookSource, pluginName: reg.pluginName, hookMatcher: reg.hookMatcher, sessionIds: new Set });
    if (reg.sessionId)
      g.sessionIds.add(reg.sessionId);
  }
  const sourceOrder = { plugin: 0, user: 1, project: 2, local: 3 };
  if (!context.mayReadDisk) {
    const remoteSource = { pluginHook: "plugin", userSettings: "user", projectSettings: "project" };
    return [...groups.values()].map((g) => ({
      source: remoteSource[g.hookSource],
      plugin: g.pluginName,
      matcher: g.hookMatcher,
      type: "telemetry",
      command: null,
      summary: "Registered on remote host",
      sessions: g.sessionIds.size,
      configPath: null,
      timeoutSec: null,
      hookEvent: event,
      hookSource: g.hookSource
    })).sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || (a.plugin ?? "").localeCompare(b.plugin ?? "") || (a.matcher ?? "").localeCompare(b.matcher ?? ""));
  }
  const defs = [];
  for (const g of groups.values()) {
    if (g.hookSource === "pluginHook" && g.pluginName) {
      const cfg = resolvePluginHookConfig(g.pluginName);
      if (cfg)
        defs.push(...definitionsFromEntries(entriesFor(cfg.entries, event), "plugin", g.pluginName, matcherTarget, g.sessionIds.size, cfg.configPath));
    } else if (g.hookSource === "userSettings") {
      const path = join3(claudeDir(), "settings.json");
      const config = readJsonCached(path)?.hooks;
      defs.push(...definitionsFromEntries(entriesFor(config, event), "user", null, matcherTarget, g.sessionIds.size, path));
    } else if (g.hookSource === "projectSettings") {
      const rootSessions = new Map;
      for (const sid of g.sessionIds) {
        const root = repoRootForSession(sid);
        if (!root)
          continue;
        (rootSessions.get(root) ?? rootSessions.set(root, new Set).get(root)).add(sid);
      }
      for (const [root, sids] of rootSessions) {
        for (const [file, source] of [
          ["settings.json", "project"],
          ["settings.local.json", "local"]
        ]) {
          const path = join3(root, ".claude", file);
          const config = readJsonCached(path)?.hooks;
          defs.push(...definitionsFromEntries(entriesFor(config, event), source, null, matcherTarget, sids.size, path));
        }
      }
    }
  }
  const seen = new Set;
  const deduped = defs.filter((d) => {
    const key = `${d.source}|${d.plugin ?? ""}|${d.matcher ?? ""}|${d.command ?? ""}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || (a.plugin ?? "").localeCompare(b.plugin ?? ""));
  return deduped;
}

// apps/collector/src/hosts.ts
import { homedir as homedir2 } from "os";
var LOCAL_HOST_ID = "local";
function hostContext(id) {
  return id === LOCAL_HOST_ID ? { id, home: homedir2(), mayReadDisk: true } : { id, home: null, mayReadDisk: false };
}

// apps/collector/src/repos.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, realpathSync, statSync as statSync2 } from "fs";
import { basename as basename3, dirname as dirname2, resolve } from "path";
var CACHE_TTL_MS = 60000;
var cache2 = new Map;
function cacheGet(dir) {
  const hit = cache2.get(dir);
  if (!hit)
    return;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache2.delete(dir);
    return;
  }
  return hit.result;
}
function cacheSet(dir, result) {
  cache2.set(dir, { result, at: Date.now() });
}
function nearestExistingDir(path) {
  let dir;
  if (existsSync2(path)) {
    dir = statSync2(path).isDirectory() ? path : dirname2(path);
  } else {
    dir = dirname2(path);
    while (!existsSync2(dir)) {
      const parent = dirname2(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
  }
  return realpathSync(dir);
}
function mainRootFromWorktreeGitDir(gitDirAbs) {
  const m = gitDirAbs.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
  return m ? m[1] : null;
}
function resolveFrom(dir) {
  const visited = [];
  let cur = dir;
  for (;; ) {
    const cached = cacheGet(cur);
    if (cached !== undefined) {
      for (const v of visited)
        cacheSet(v, cached);
      return cached;
    }
    visited.push(cur);
    const gitPath = `${cur}/.git`;
    if (existsSync2(gitPath)) {
      const st = statSync2(gitPath);
      let result = null;
      if (st.isDirectory()) {
        result = { name: basename3(cur), root: cur, worktree: null };
      } else {
        const content = readFileSync2(gitPath, "utf8");
        const m = content.match(/^gitdir:\s*(.+)$/m);
        const gitDirAbs = m ? resolve(cur, m[1].trim()) : null;
        const mainRoot = gitDirAbs ? mainRootFromWorktreeGitDir(gitDirAbs) : null;
        if (mainRoot) {
          result = { name: basename3(mainRoot), root: mainRoot, worktree: cur };
        } else if (gitDirAbs) {
          result = { name: basename3(cur), root: cur, worktree: null };
        }
      }
      if (result) {
        for (const v of visited)
          cacheSet(v, result);
        return result;
      }
    }
    const parent = dirname2(cur);
    if (parent === cur) {
      for (const v of visited)
        cacheSet(v, null);
      return null;
    }
    cur = parent;
  }
}
function gitRoot(path) {
  return resolveFrom(nearestExistingDir(path));
}

// apps/mcp/src/owners.ts
function ownerOf(d) {
  const label = d.source === "plugin" ? `plugin ${d.plugin ?? "?"}` : `${d.source} settings`;
  return { label, configPath: d.configPath };
}
function buildOwnerIndex(registrations, cwdBySession, hookEvents) {
  const ctx = hostContext(LOCAL_HOST_ID);
  const rootFor = (sid) => {
    const cwd = cwdBySession.get(sid);
    return cwd ? gitRoot(cwd)?.root ?? cwd : null;
  };
  const defsByEvent = new Map;
  for (const ev of new Set(hookEvents)) {
    if (!ev)
      continue;
    try {
      defsByEvent.set(ev, buildHookDefinitions(ev, registrations, rootFor, ctx));
    } catch {
      defsByEvent.set(ev, []);
    }
  }
  return {
    byCommand(hookEvent, command) {
      const seen = new Set;
      const out = [];
      for (const d of defsByEvent.get(hookEvent) ?? []) {
        if (d.command !== command)
          continue;
        const o = ownerOf(d);
        const key = `${o.label}|${o.configPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(o);
        }
      }
      return out;
    },
    forEvent(hookEvent) {
      return (defsByEvent.get(hookEvent) ?? []).map((d) => ({
        command: d.command,
        summary: d.command ? hookSummary(d.command) : d.summary,
        owner: ownerOf(d)
      }));
    }
  };
}
function ownerText(owners) {
  if (!owners.length)
    return "owner unknown";
  return owners.map((o) => o.configPath ? `${o.label} (${o.configPath})` : o.label).join(" or ");
}

// apps/mcp/src/telemetry.ts
import { Database } from "bun:sqlite";
import { existsSync as existsSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4 } from "path";
function telemetryPath() {
  return join4(process.env.CC_TELEMETRY_DIR ?? join4(homedir3(), ".claude-telemetry"), "telemetry.sqlite");
}
function openTelemetry(path = telemetryPath()) {
  if (!existsSync3(path))
    return { ok: false, path, reason: `no telemetry database at ${path} (is the collector installed and Claude Code telemetry on?)` };
  try {
    const db = new Database(path, { readonly: true });
    db.query("SELECT 1 FROM events LIMIT 1").get();
    return { ok: true, db, path };
  } catch (err) {
    return { ok: false, path, reason: `telemetry database at ${path} could not be read: ${err.message}` };
  }
}
function sessionClause(f) {
  if (f.sessionIds === null)
    return { sql: "", params: [] };
  if (f.sessionIds.length === 0)
    return { sql: " AND 0", params: [] };
  return { sql: ` AND session_id IN (${f.sessionIds.map(() => "?").join(",")})`, params: f.sessionIds };
}
function hookFirings(db, f) {
  const s = sessionClause(f);
  const rows = db.query(`SELECT ts_ms, session_id, prompt_id,
         COALESCE(json_extract(attrs, '$.hook_name'), json_extract(attrs, '$.hook_event'), 'unknown') AS label,
         COALESCE(json_extract(attrs, '$.hook_event'), '') AS hook_event,
         json_extract(attrs, '$.total_duration_ms') AS ms,
         json_extract(attrs, '$.num_hooks') AS num_hooks,
         json_extract(attrs, '$.num_non_blocking_error') AS errors,
         json_extract(attrs, '$.num_blocking') AS blocking,
         json_extract(attrs, '$.num_cancelled') AS cancelled,
         json_extract(attrs, '$.additional_context_chars') AS ctx
       FROM events WHERE name = 'hook_execution_complete' AND ts_ms >= ?${s.sql} ORDER BY ts_ms`).all(f.sinceMs, ...s.params);
  const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  return rows.map((r) => ({
    tsMs: r.ts_ms,
    sessionId: r.session_id,
    promptId: r.prompt_id,
    label: String(r.label),
    hookEvent: String(r.hook_event),
    durationMs: n(r.ms),
    numHooks: n(r.num_hooks),
    errors: n(r.errors),
    blocking: n(r.blocking),
    cancelled: n(r.cancelled),
    contextChars: n(r.ctx)
  }));
}
function hookRegistrations(db, f) {
  const s = sessionClause(f);
  return db.query(`SELECT rowid AS id, ts_ms, name, session_id, prompt_id, attrs FROM events WHERE name = 'hook_registered' AND ts_ms >= ?${s.sql}`).all(f.sinceMs, ...s.params).map((r) => ({ id: r.id, tsMs: r.ts_ms, name: r.name, sessionId: r.session_id, promptId: r.prompt_id, attrs: JSON.parse(r.attrs) }));
}
function sessionEvents(db, sessionIds) {
  if (!sessionIds.length)
    return [];
  return db.query(`SELECT rowid AS id, ts_ms, name, session_id, prompt_id, attrs FROM events WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY ts_ms`).all(...sessionIds).map((r) => ({ id: r.id, tsMs: r.ts_ms, name: r.name, sessionId: r.session_id, promptId: r.prompt_id, attrs: JSON.parse(r.attrs) }));
}

// apps/mcp/src/gather.ts
var SINCE = /^(\d+)\s*(m|min|h|d)$/i;
function parseSince(since) {
  const m = since.trim().match(SINCE);
  if (!m)
    throw new UserError(`since must look like 15m, 1h, 24h or 7d, got "${since}"`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000);
}
async function resolveScope(args, env = process.env, nowMs = Date.now()) {
  const session = (args.session ?? "current").trim() || "current";
  const sinceLabel = args.since?.trim() || null;
  const project = args.project?.trim() || null;
  if (session === "all") {
    const label = sinceLabel ?? "24h";
    const sinceMs = nowMs - parseSince(label);
    const found = recentSessions(sinceMs);
    const sessions = [];
    for (const f of found.sessions) {
      const s = await loadSession(f);
      if (project && !(s.cwd ?? "").toLowerCase().includes(project.toLowerCase()))
        continue;
      sessions.push(s);
    }
    return { kind: "all", sessions, sinceMs, sinceLabel: label, project, unreadableFolders: found.unreadable };
  }
  let id = session;
  if (session === "current") {
    const envId = env.CLAUDE_CODE_SESSION_ID;
    if (!envId)
      throw new UserError("No current session: CLAUDE_CODE_SESSION_ID is not set, so this server was not started by a Claude Code session. Pass session='all' or a session id.");
    id = envId;
  }
  const found = findSession(id);
  const unreadable = found.unreadable.length ? ` ${found.unreadable.length} project folders could not be read.` : "";
  if (found.sessions.length === 0)
    throw new UserError(`No transcript found for session ${id} under ~/.claude/projects.${unreadable}`);
  if (found.sessions.length > 1)
    throw new UserError(`Session prefix ${id} matches ${found.sessions.length} sessions: ${found.sessions.map((f) => f.sessionId).join(", ")}`);
  const sinceMs = sinceLabel ? nowMs - parseSince(sinceLabel) : 0;
  return { kind: "session", sessions: [await loadSession(found.sessions[0])], sinceMs, sinceLabel, project: null, unreadableFolders: found.unreadable };
}
async function gather(args, env = process.env, nowMs = Date.now()) {
  const scope = await resolveScope(args, env, nowMs);
  const blocks = [];
  const runs = [];
  let prompts = 0;
  for (const s of scope.sessions) {
    const parts = [s.main, ...s.subagents].filter((d) => d !== null);
    const readPaths = new Set(parts.flatMap((d) => d.readPaths));
    for (const d of parts) {
      for (const b of d.blocks) {
        if (b.tsMs < scope.sinceMs)
          continue;
        if (b.persisted?.path)
          b.persisted.readBack = readPaths.has(b.persisted.path);
        blocks.push(b);
      }
      for (const r of d.runs)
        if (r.tsMs >= scope.sinceMs)
          runs.push(r);
    }
    prompts += s.prompts.filter((p) => p.tsMs >= scope.sinceMs).length;
  }
  const sessionIds = scope.sessions.map((s) => s.sessionId);
  const tel = openTelemetry();
  let firings = null;
  let telemetryNote = null;
  let owners = null;
  let activeMs = null;
  let turnHookMs = null;
  if (tel.ok) {
    try {
      firings = hookFirings(tel.db, { sessionIds, sinceMs: scope.sinceMs });
      if (firings.length === 0 && sessionIds.length > 0)
        telemetryNote = "telemetry has no hook firings for these sessions (telemetry may have been off, or the collector not running)";
      const regs = hookRegistrations(tel.db, { sessionIds, sinceMs: 0 });
      const cwdBySession = new Map(scope.sessions.map((s) => [s.sessionId, s.cwd]));
      const events = [...blocks.map((b) => b.hookEvent), ...runs.map((r) => r.hookEvent)];
      owners = buildOwnerIndex(regs, cwdBySession, events);
      if (scope.kind === "session" && scope.sinceMs === 0) {
        const turns = [...promptBreakdowns(sessionEvents(tel.db, sessionIds)).values()].filter((p) => p.endMs >= scope.sinceMs);
        activeMs = turns.reduce((sum, p) => sum + p.activeMs, 0);
        turnHookMs = turns.reduce((sum, p) => sum + p.hookMs, 0);
      }
    } finally {
      tel.db.close();
    }
  } else {
    telemetryNote = tel.reason;
  }
  return { scope, blocks, runs, firings, telemetryNote, owners, prompts, activeMs, turnHookMs };
}

// apps/mcp/src/query.ts
import { existsSync as existsSync4 } from "fs";
import { join as join5 } from "path";

// apps/mcp/src/query-db.ts
var QUERY_SCHEMA = `Tables (transcript data for the chosen scope):
  blocks(session_id, agent_id, project, ts_ms, prompt_id, hook_event, hook_name, kind, chars, est_tokens, family, tag, signature, command, repeat, persisted_size, read_back, preview)
    one row per block of text a hook put into the model's context; family='hindsight' for Hindsight; repeat=1 when the session already got identical text
  hook_runs(session_id, agent_id, project, ts_ms, prompt_id, hook_event, hook_name, command, duration_ms, exit_code)
    single hook command runs the transcript records (only some events, e.g. SessionStart, PreToolUse)
  sessions(session_id, project, cwd, branch, first_ms, last_ms, prompts, subagent_files)
Telemetry, all sessions and times (read-only, attached as tel):
  tel.events(ts_ms, name, session_id, prompt_id, attrs JSON, host_id)  e.g. name='hook_execution_complete' with json_extract(attrs,'$.hook_name'), '$.total_duration_ms', '$.additional_context_chars'
  tel.spans(trace_id, span_id, parent_id, name, start_ms, end_ms, session_id, attrs JSON, host_id)
  tel.metrics(ts_ms, name, session_id, value, attrs JSON, host_id)`;
var MAX_TEXT = 64 * 1024;
function checkSql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed))
    throw new UserError("Only SELECT (or WITH ... SELECT) queries are allowed.");
  if (trimmed.includes(";"))
    throw new UserError("One statement only.");
  return trimmed;
}

// apps/mcp/src/report.ts
import { basename as basename4 } from "path";
var TOKEN_NOTE = "Tokens are estimates (chars / 4). Injected text is counted as the model received it: previews for output too large for context, plus Claude Code's reminder wrapper where the transcript records it.";
var tokensOf = (chars) => Math.round(chars / 4);
function fmtCount(n) {
  if (n < 1000)
    return String(Math.round(n));
  if (n < 1e6)
    return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function charsTok(chars) {
  return `${fmtCount(chars)} chars \u2248 ${fmtCount(tokensOf(chars))} tok`;
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function pct(part, whole) {
  return whole > 0 ? `${Math.round(part / whole * 100)}%` : "n/a";
}
function when(ms) {
  return ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "?";
}
var projectCache = new Map;
function projectName(cwd) {
  if (!cwd)
    return "unknown project";
  let name = projectCache.get(cwd);
  if (!name) {
    const repo = gitRoot(cwd);
    name = repo ? repo.worktree ? `${repo.name} (worktree ${basename4(cwd)})` : repo.name : basename4(cwd);
    projectCache.set(cwd, name);
  }
  return name;
}
function scopeLine(h) {
  const s = h.scope;
  const bad = s.sessions.reduce((sum, x) => sum + x.badLines, 0);
  let badNote = bad ? ` Skipped ${plural(bad, "unreadable hook line")} in the transcripts; not counted.` : "";
  if (s.unreadableFolders.length)
    badNote += ` ${plural(s.unreadableFolders.length, "transcript folder")} could not be read, so their sessions are missing (first: ${s.unreadableFolders[0]}).`;
  if (s.kind === "session") {
    const sess = s.sessions[0];
    const where = [projectName(sess.cwd), sess.gitBranch ? `branch ${sess.gitBranch}` : null].filter(Boolean).join(", ");
    const window = s.sinceLabel ? `, last ${s.sinceLabel}` : `, ${when(sess.firstMs)} to ${when(sess.lastMs)}`;
    const subs = sess.subagents.length ? `, ${plural(sess.subagents.length, "subagent transcript")}` : "";
    return `Session ${sess.sessionId} (${where}): ${plural(h.prompts, "prompt")}${window}${subs}.${badNote}`;
  }
  const proj = s.project ? ` in projects matching "${s.project}"` : "";
  return `${plural(s.sessions.length, "session")} active in the last ${s.sinceLabel}${proj}: ${plural(h.prompts, "prompt")}.${badNote}`;
}
function timingRows(firings) {
  const groups = new Map;
  for (const f of firings)
    (groups.get(f.label) ?? groups.set(f.label, []).get(f.label)).push(f);
  return [...groups].map(([label, list]) => {
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
      cancelled: list.reduce((a, f) => a + f.cancelled, 0)
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
}
function commandRows(runs) {
  const groups = new Map;
  for (const r of runs) {
    const key = `${r.hookEvent}\x00${r.command}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
  }
  return [...groups.values()].map((list) => {
    const sorted = list.map((r) => r.durationMs ?? 0).sort((a, b) => a - b);
    return {
      hookEvent: list[0].hookEvent,
      command: list[0].command,
      runs: list.length,
      totalMs: sorted.reduce((a, b) => a + b, 0),
      p95: percentile(sorted, 95),
      maxMs: sorted.at(-1) ?? 0,
      failed: list.filter((r) => r.exitCode !== null && r.exitCode !== 0).length
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
}
function shortCommand(command, max = 70) {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
function hookTimeReport(h, limit) {
  const out = [scopeLine(h)];
  if (h.firings === null) {
    out.push(`Hook time from telemetry: unavailable, ${h.telemetryNote}.`);
  } else {
    const rows = timingRows(h.firings);
    const total = rows.reduce((a, r) => a + r.totalMs, 0);
    out.push(`Hook time from telemetry: ${fmtMs(total)} wall time in ${h.firings.length} firings. All hooks of one event run in parallel, so times are per firing, not per script.`);
    if (h.telemetryNote)
      out.push(`Note: ${h.telemetryNote}.`);
    if (h.activeMs && h.turnHookMs !== null)
      out.push(`Inside turns: ${fmtMs(h.turnHookMs)} of ${fmtMs(h.activeMs)} active turn time (${pct(h.turnHookMs, h.activeMs)}).`);
    if (h.prompts > 0)
      out.push(`Per prompt: ${fmtMs(total / h.prompts)} on average.`);
    if (rows.length) {
      out.push("", "hook | firings | total | p50 | p95 | max | errors | blocked");
      for (const r of rows.slice(0, limit))
        out.push(`${r.label} | ${r.firings} | ${fmtMs(r.totalMs)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.maxMs)} | ${r.errors} | ${r.blocking}${r.cancelled ? ` (${r.cancelled} cancelled)` : ""}`);
      if (rows.length > limit)
        out.push(`(${rows.length - limit} more hooks)`);
    }
  }
  const cmds = commandRows(h.runs);
  const events = [...new Set(cmds.map((c) => c.hookEvent))].join(", ");
  out.push("", `Per command, from transcripts. Claude Code logs single runs only for some hooks${events ? `; here: ${events}` : ""}.`);
  if (!cmds.length)
    out.push("None recorded in this scope.");
  for (const c of cmds.slice(0, limit)) {
    const owners = h.owners ? ownerText(h.owners.byCommand(c.hookEvent, c.command)) : "owner unknown (no telemetry)";
    const failed = c.failed ? `, ${c.failed} failed` : "";
    out.push(`- ${c.hookEvent}: ${shortCommand(c.command)} | ${plural(c.runs, "run")}, total ${fmtMs(c.totalMs)}, p95 ${fmtMs(c.p95)}, max ${fmtMs(c.maxMs)}${failed} | ${owners}`);
  }
  if (cmds.length > limit)
    out.push(`(${cmds.length - limit} more commands)`);
  return out.join(`
`);
}
function repeatSet(blocks) {
  const seen = new Set;
  const repeats = new Set;
  for (const b of [...blocks].sort((x, y) => x.tsMs - y.tsMs)) {
    const key = `${b.sessionId}|${b.agentId ?? ""}|${b.hash}`;
    if (seen.has(key))
      repeats.add(b);
    else
      seen.add(key);
  }
  return repeats;
}
function sessionCwd(h, sessionId) {
  return h.scope.sessions.find((s) => s.sessionId === sessionId)?.cwd ?? null;
}
function injectionRows(h, groupBy) {
  const repeats = repeatSet(h.blocks);
  const rows = new Map;
  for (const b of h.blocks) {
    let key;
    let label;
    switch (groupBy) {
      case "event":
        key = label = b.hookEvent;
        break;
      case "prompt":
        key = `${b.sessionId}|${b.promptId ?? ""}`;
        label = b.promptId ? `prompt ${b.promptId.slice(0, 8)}` : "session start";
        if (h.scope.kind === "all")
          label = `${b.sessionId.slice(0, 8)} ${label}`;
        if (b.agentId)
          label += " (subagents)";
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
    if (!row)
      rows.set(key, row = { key, label, blocks: [], chars: 0, repeats: 0, persisted: 0 });
    row.blocks.push(b);
    row.chars += b.chars;
    if (repeats.has(b))
      row.repeats++;
    if (b.persisted)
      row.persisted++;
  }
  return [...rows.values()].sort((a, b) => b.chars - a.chars);
}
function blockOwner(h, b) {
  if (!h.owners)
    return b.command ? `${hookSummary(b.command)}, owner unknown (no telemetry)` : "unattributed (no telemetry to list candidates)";
  if (b.command)
    return `${hookSummary(b.command)}, ${ownerText(h.owners.byCommand(b.hookEvent, b.command))}`;
  let candidates = h.owners.forEvent(b.hookEvent);
  if (b.family === "hindsight") {
    const own = candidates.filter((c) => c.command?.toLowerCase().includes("hindsight"));
    if (own.length)
      candidates = own;
  }
  if (!candidates.length)
    return `unattributed; no ${b.hookEvent} hooks found in config`;
  const seen = new Set;
  const names = [];
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
function totalChars(blocks) {
  return blocks.reduce((a, b) => a + b.chars, 0);
}
function telemetryContextChars(h) {
  return h.firings ? h.firings.reduce((a, f) => a + f.contextChars, 0) : null;
}
function injectionReport(h, groupBy, limit) {
  const out = [scopeLine(h), TOKEN_NOTE];
  const total = totalChars(h.blocks);
  const start = totalChars(h.blocks.filter((b) => b.promptId === null && !b.agentId));
  out.push(`Injected by hooks: ${charsTok(total)} in ${plural(h.blocks.length, "block")}.`);
  if (h.scope.kind === "session" && !h.scope.sinceLabel)
    out.push(`Before the first prompt (SessionStart): ${charsTok(start)}.`);
  if (h.prompts > 0)
    out.push(`Per prompt: ${charsTok((total - start) / h.prompts)} on average.`);
  const tel = telemetryContextChars(h);
  if (tel !== null)
    out.push(`Telemetry's own count for the same hooks: ${fmtCount(tel)} chars (counts persisted output at full size and does not see every hook).`);
  if (!h.blocks.length) {
    out.push("No hook-injected blocks in this scope.");
    return out.join(`
`);
  }
  const rows = injectionRows(h, groupBy);
  out.push("");
  for (const [i, r] of rows.slice(0, limit).entries()) {
    const extras = [
      r.blocks.length > 1 ? `${r.blocks.length} blocks` : "1 block",
      r.repeats ? plural(r.repeats, "identical repeat") : null,
      r.persisted ? `${r.persisted} persisted` : null,
      h.scope.kind === "all" && groupBy === "source" ? `${new Set(r.blocks.map((b) => b.sessionId)).size} sessions` : null
    ].filter(Boolean);
    out.push(`${i + 1}. ${r.label}: ${charsTok(r.chars)}, ${pct(r.chars, total)} (${extras.join(", ")})`);
    if (groupBy === "source") {
      out.push(`   owner: ${blockOwner(h, r.blocks[0])}`);
      out.push(`   preview: ${r.blocks[0].preview}`);
    }
  }
  if (rows.length > limit)
    out.push(`(${rows.length - limit} more rows)`);
  return out.join(`
`);
}
function memoryReport(h) {
  const out = [scopeLine(h), TOKEN_NOTE];
  const mem = h.blocks.filter((b) => b.family === "hindsight");
  const all = totalChars(h.blocks);
  const memChars = totalChars(mem);
  out.push(`Hindsight memory: ${charsTok(memChars)} in ${plural(mem.length, "block")}, ${pct(memChars, all)} of all hook-injected text.`);
  if (!mem.length) {
    out.push("No Hindsight-tagged blocks (<hindsight_*>) in this scope.");
    return out.join(`
`);
  }
  const repeats = repeatSet(h.blocks);
  const byTag = new Map;
  for (const b of mem)
    (byTag.get(b.tag ?? "?") ?? byTag.set(b.tag ?? "?", []).get(b.tag ?? "?")).push(b);
  out.push("", "By tag:");
  for (const [tag, list] of [...byTag].sort((a, b) => totalChars(b[1]) - totalChars(a[1]))) {
    const events = [...new Set(list.map((b) => b.hookEvent))].join(", ");
    const rep = list.filter((b) => repeats.has(b)).length;
    const persisted = list.filter((b) => b.persisted).length;
    const notes = [events, rep ? plural(rep, "identical repeat") : null, persisted ? `${persisted} persisted` : null].filter(Boolean).join(", ");
    out.push(`- <${tag}>: ${charsTok(totalChars(list))} in ${plural(list.length, "block")} (${notes})`);
  }
  const perPrompt = new Map;
  for (const b of mem)
    if (b.promptId)
      perPrompt.set(`${b.sessionId}|${b.promptId}`, (perPrompt.get(`${b.sessionId}|${b.promptId}`) ?? 0) + b.chars);
  if (h.prompts > 0) {
    const promptChars = [...perPrompt.values()].reduce((a, b) => a + b, 0);
    const max = Math.max(0, ...perPrompt.values());
    out.push("", `Per prompt: ${charsTok(promptChars / h.prompts)} on average, max ${charsTok(max)}.`);
  }
  const persisted = mem.filter((b) => b.persisted);
  if (persisted.length) {
    const readBack = persisted.filter((b) => b.persisted.readBack).length;
    const sizes = persisted.map((b) => b.persisted.reportedSize ?? "?");
    const shown = Math.round(totalChars(persisted) / persisted.length);
    out.push(`Too large for context: ${plural(persisted.length, "block")} saved to a file instead (full size ${sizes.slice(0, 5).join(", ")}${sizes.length > 5 ? ", \u2026" : ""}); the model saw a preview of about ${fmtCount(shown)} chars each. The agent read the full file back for ${readBack} of them.`);
  }
  out.push("", "Owners:");
  const ownerSeen = new Set;
  for (const b of mem) {
    const key = `${b.hookEvent}|${b.command ?? ""}`;
    if (ownerSeen.has(key))
      continue;
    ownerSeen.add(key);
    out.push(`- ${b.hookEvent}: ${blockOwner(h, b)}`);
  }
  return out.join(`
`);
}
function summaryReport(h) {
  const out = [scopeLine(h), TOKEN_NOTE, ""];
  if (h.firings === null)
    out.push(`Hook time: unavailable, ${h.telemetryNote}.`);
  else {
    const rows = timingRows(h.firings);
    const total = rows.reduce((a, r) => a + r.totalMs, 0);
    const share = h.activeMs && h.turnHookMs !== null ? `, ${pct(h.turnHookMs, h.activeMs)} of active turn time` : "";
    out.push(`Hook time: ${fmtMs(total)} wall time in ${h.firings.length} firings${share}.`);
    const top = rows.slice(0, 3).map((r) => `${r.label} ${fmtMs(r.totalMs)} (${r.firings}x, p95 ${fmtMs(r.p95)}${r.errors ? `, ${r.errors} errors` : ""})`);
    if (top.length)
      out.push(`  top: ${top.join("; ")}`);
    if (h.telemetryNote)
      out.push(`  note: ${h.telemetryNote}`);
  }
  const total = totalChars(h.blocks);
  out.push(`Injected by hooks: ${charsTok(total)} in ${plural(h.blocks.length, "block")}.`);
  const repeats = repeatSet(h.blocks);
  const repeatChars = totalChars([...repeats]);
  if (repeatChars)
    out.push(`  identical repeats: ${charsTok(repeatChars)} (${pct(repeatChars, total)}) was text the same session had already received.`);
  for (const r of injectionRows(h, "source").slice(0, 3))
    out.push(`  ${r.label}: ${charsTok(r.chars)} (${plural(r.blocks.length, "block")})`);
  const mem = h.blocks.filter((b) => b.family === "hindsight");
  const persisted = mem.filter((b) => b.persisted);
  const persistedNote = persisted.length ? `; ${plural(persisted.length, "recall")} too large for context, ${persisted.filter((b) => b.persisted.readBack).length} read back by the agent` : "";
  out.push(`Hindsight memory: ${charsTok(totalChars(mem))}, ${pct(totalChars(mem), total)} of injected${persistedNote}.`);
  out.push("", "Details: hook_time, injected_context (group_by source|event|prompt|session|project), memory_cost, harness_query.");
  return out.join(`
`);
}

// apps/mcp/src/query.ts
var CHILD_CANDIDATES = [join5(import.meta.dir, "query-child.ts"), join5(import.meta.dir, "query-child.js")];
var DEFAULT_TIMEOUT_MS = 1e4;
var MAX_OUTPUT_BYTES = 1024 * 1024;
function timeoutMs() {
  const n = Number(process.env.CPA_MCP_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}
function queryRows(h) {
  const project = new Map(h.scope.sessions.map((s) => [s.sessionId, projectName(s.cwd)]));
  const repeats = repeatSet(h.blocks);
  return {
    blocks: h.blocks.map((b) => [
      b.sessionId,
      b.agentId,
      project.get(b.sessionId) ?? null,
      b.tsMs,
      b.promptId,
      b.hookEvent,
      b.hookName,
      b.kind,
      b.chars,
      tokensOf(b.chars),
      b.family,
      b.tag,
      b.signature,
      b.command,
      repeats.has(b) ? 1 : 0,
      b.persisted?.reportedSize ?? null,
      b.persisted ? b.persisted.readBack ? 1 : 0 : null,
      b.preview
    ]),
    runs: h.runs.map((r) => [r.sessionId, r.agentId, project.get(r.sessionId) ?? null, r.tsMs, r.promptId, r.hookEvent, r.hookName, r.command, r.durationMs, r.exitCode]),
    sessions: h.scope.sessions.map((s) => [s.sessionId, project.get(s.sessionId) ?? null, s.cwd, s.gitBranch, s.firstMs, s.lastMs, s.prompts.length, s.subagents.length])
  };
}
async function runIsolatedQuery(h, sql) {
  const clean = checkSql(sql);
  const childScript = CHILD_CANDIDATES.find((p) => existsSync4(p));
  if (!childScript)
    throw new Error(`Query runner missing: none of ${CHILD_CANDIDATES.join(", ")} exists.`);
  const limit = timeoutMs();
  const started = performance.now();
  const child = Bun.spawn([process.execPath, childScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: limit,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES
  });
  const feed = (async () => {
    try {
      child.stdin.write(JSON.stringify({ rows: queryRows(h), sql: clean, telemetry: telemetryPath() }));
      await child.stdin.end();
    } catch {}
  })();
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), feed]);
  await child.exited;
  if (child.signalCode) {
    if (performance.now() - started >= limit)
      throw new UserError(`Query timed out after ${limit / 1000}s and was stopped. Narrow it or add LIMIT.`);
    throw new UserError(`Query process was killed (${child.signalCode}): it used too much memory or produced too much output.`);
  }
  let reply;
  try {
    reply = JSON.parse(out);
  } catch {
    throw new Error(`Query process failed (exit ${child.exitCode}): ${err.trim().slice(-500) || "no output"}`);
  }
  if (!reply.ok)
    throw new UserError(reply.error ?? "Query failed.");
  return reply.text ?? "";
}

// apps/mcp/src/tools.ts
var SCOPE_PROPS = {
  session: {
    type: "string",
    description: "'current' (default, the session calling this tool), 'all' for every recent session, or a session id or 8+ character prefix."
  },
  since: {
    type: "string",
    description: "Only data newer than this: 15m, 1h, 24h, 7d. Default: the whole session, or 24h with session='all'."
  },
  project: { type: "string", description: "With session='all': only sessions whose working directory contains this text." }
};
var LIMIT_PROP = { type: "integer", minimum: 1, maximum: 50, description: "Max rows per list (default 10)." };
function scopeArgs(args) {
  const str = (v) => typeof v === "string" ? v : undefined;
  return { session: str(args.session), since: str(args.since), project: str(args.project) };
}
function limitOf(args) {
  const n = Number(args.limit ?? 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 50) : 10;
}
var GROUPS = ["source", "event", "prompt", "session", "project"];
function harnessTools(env = process.env) {
  return [
    {
      name: "harness_summary",
      description: "Start here. What the Claude Code harness costs: hook wall time, text hooks inject into the model's context (estimated tokens), and Hindsight memory's share. Defaults to the calling session.",
      inputSchema: { type: "object", properties: SCOPE_PROPS, additionalProperties: false },
      run: async (args) => summaryReport(await gather(scopeArgs(args), env))
    },
    {
      name: "hook_time",
      description: "Hook timing: per hook event (firings, total, p50, p95, max, errors, blocks) from telemetry, active turn time share, and per-command run times with the plugin or settings file that owns each command.",
      inputSchema: { type: "object", properties: { ...SCOPE_PROPS, limit: LIMIT_PROP }, additionalProperties: false },
      run: async (args) => hookTimeReport(await gather(scopeArgs(args), env), limitOf(args))
    },
    {
      name: "injected_context",
      description: "Text hooks put into the model's context, counted as the model received it (persisted output counts as its preview). Group by source (default: each distinct block with owner and preview), event, prompt, session or project. Flags identical repeats.",
      inputSchema: {
        type: "object",
        properties: { ...SCOPE_PROPS, group_by: { type: "string", enum: GROUPS }, limit: LIMIT_PROP },
        additionalProperties: false
      },
      run: async (args) => {
        const groupBy = typeof args.group_by === "string" ? args.group_by : "source";
        if (!GROUPS.includes(groupBy))
          throw new UserError(`group_by must be one of ${GROUPS.join(", ")}`);
        return injectionReport(await gather(scopeArgs(args), env), groupBy, limitOf(args));
      }
    },
    {
      name: "memory_cost",
      description: "Hindsight memory injection: split by tag (recall <hindsight_memory> vs <hindsight_knowledge*> banners), per prompt, repeats, recalls too large for context and whether the agent read them back, and the owning hook.",
      inputSchema: { type: "object", properties: SCOPE_PROPS, additionalProperties: false },
      run: async (args) => memoryReport(await gather(scopeArgs(args), env))
    },
    {
      name: "harness_query",
      description: `Read-only SQL (SQLite, one SELECT) for questions the other tools do not answer. Max 100 rows; stopped after 10s.
${QUERY_SCHEMA}`,
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "One SELECT or WITH query." }, ...SCOPE_PROPS },
        required: ["sql"],
        additionalProperties: false
      },
      run: async (args) => {
        if (typeof args.sql !== "string" || !args.sql.trim())
          throw new UserError("sql is required");
        return runIsolatedQuery(await gather(scopeArgs(args), env), args.sql);
      }
    }
  ];
}

// apps/mcp/src/index.ts
var server = createServer({
  name: "cpa-harness",
  version: "0.1.0",
  instructions: "Read-only answers about what the Claude Code harness costs this session or recent sessions: hook time, text hooks inject into context, Hindsight memory share. Call harness_summary first."
}, harnessTools());
await serveStdio(server);
