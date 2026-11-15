// Maps DeepSeek Harness session-log events (format v4) onto the collector's event vocabulary.
// Names the analyzer already understands (api_request, tool_result, ...) keep their Claude Code
// attribute keys so every existing view works; everything else becomes a `dsh.<type>` event.
// Prompt, tool output and model text never leave the process: only sizes, names and arguments.

const ARG_CAP = 2000;
const BODY_CAP = 1000;

// Too noisy or too large to be worth a row each. Their signal is folded into other events.
const SKIPPED = new Set([
  "agent/inbox/spliced",
  "step/start",
  "step/end",
  "tool/call",
  "tool/result",
  "tool/ptc-dispatch-start",
  "tool/ptc-dispatch",
  "assistant/message",
  "user/message",
  "system/message",
  "developer/message",
  "request/header",
  "turn/start",
  "job/registered",
  "compaction/start",
  "compaction/summary",
  "approval/asked",
  "session/title-llm-request",
  "web/deepseek-search-llm-request",
  "plugin:translator/request",
  "plugin:translator/result",
  "skill-catalog",
]);

// user/message sources that start a turn on the model's behalf. Everything else (runtime
// context, time context, plugin injections) is scaffolding attached to the same turn.
const TRIGGER_SOURCES = new Set(["user", "agent-message", "subagent-settled", "goal", "tool-jobs", "command"]);

/** @param {unknown} v @param {number} cap */
function cap(v, cap) {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > cap ? `${s.slice(0, cap)}…[${s.length - cap} chars]` : s;
}

/** @param {unknown} content */
function textLength(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) if (block && block.type === "text" && typeof block.text === "string") n += block.text.length;
  return n;
}

/** @param {unknown} args */
function parseArgs(args) {
  if (args && typeof args === "object") return /** @type {Record<string, unknown>} */ (args);
  if (typeof args !== "string") return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Adds the keys analytics.toolLabel reads, so skills, subagents and MCP calls get useful labels.
/** @param {string} name @param {Record<string, unknown>} args */
function toolParameters(name, args) {
  const out = { ...args };
  if (name === "skill" && typeof args.name === "string") out.skill_name = args.name;
  if ((name === "subagent" || name === "subagent_fork" || name === "subagent_claude_code") && typeof args.description === "string") out.subagent_type = args.description;
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    out.mcp_server_name = mcp[1];
    out.mcp_tool_name = mcp[2];
  }
  return cap(out, ARG_CAP);
}

/**
 * @typedef {{ type: string, seq?: number, time: number, data?: any }} DshEvent
 * @typedef {{ id: string, cwd?: string, parentSession?: string, origin?: string, delegationDepth?: number, agentPreset?: string, createdAt?: number }} DshHeader
 * @typedef {{ tsMs: number, name: string, attrs: Record<string, string | number | boolean> }} MappedRecord
 */

export class SessionMapper {
  /** @param {DshHeader} header */
  constructor(header) {
    this.header = header;
    this.turn = 0;
    this.turnStartMs = 0;
    this.promptSent = false;
    this.stepStartMs = 0;
    /** @type {Map<string, { name: string, time: number, args: Record<string, unknown> }>} */
    this.calls = new Map();
    /** @type {Map<string, number>} */
    this.ptcStarts = new Map();
    /** @type {Map<string, number>} */
    this.compactions = new Map();
    /** @type {Map<string, number>} */
    this.approvals = new Map();
    /** @type {Map<string, { createdAt: number, label: string, mode: string }>} */
    this.children = new Map();
    this.isSubagent = header.origin === "subagent";
  }

  // A continuable child can settle again after a follow-up; only the first settle closes its run.
  /** @param {number} tsMs @param {string} childId @returns {MappedRecord[]} */
  subagentSettled(tsMs, childId) {
    const child = this.children.get(childId);
    if (!child) return [];
    this.children.delete(childId);
    return [
      this.record(tsMs, "subagent_completed", {
        agent_type: child.mode || "subagent",
        duration_ms: tsMs - child.createdAt,
        label: cap(child.label, 300),
        "dsh.child_session": childId,
      }),
    ];
  }

  /** Attributes shared by every record of this session (the OTLP resource). */
  resource() {
    const h = this.header;
    /** @type {Record<string, string | number | boolean>} */
    const r = { "service.name": "deepseek-harness", launcher: "dsh", "session.id": h.id };
    if (h.cwd) r["dsh.cwd"] = h.cwd;
    if (h.parentSession) r["dsh.parent_session"] = h.parentSession;
    if (h.origin) r["dsh.origin"] = h.origin;
    if (h.delegationDepth !== undefined) r["dsh.delegation_depth"] = h.delegationDepth;
    if (h.agentPreset) r["dsh.agent_preset"] = h.agentPreset;
    return r;
  }

  promptId() {
    return `${this.header.id}:${this.turn}`;
  }

  /** @param {number} tsMs @param {string} name @param {Record<string, unknown>} attrs @returns {MappedRecord} */
  record(tsMs, name, attrs) {
    /** @type {Record<string, string | number | boolean>} */
    const clean = { "prompt.id": this.promptId(), "event.sequence": 0 };
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      clean[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : cap(v, BODY_CAP);
    }
    return { tsMs, name, attrs: clean };
  }

  /** @param {number} tsMs @param {string} source @param {number} length */
  prompt(tsMs, source, length) {
    this.promptSent = true;
    return this.record(tsMs, "user_prompt", { prompt_length: length, "dsh.prompt_source": source, "dsh.turn": this.turn });
  }

  /** @param {DshEvent} e @returns {MappedRecord[]} */
  map(e) {
    const d = e.data ?? {};
    const out = [];
    const seq = e.seq ?? -1;
    switch (e.type) {
      case "turn/start":
        this.turn = Number(d.turn) || this.turn + 1;
        this.turnStartMs = e.time;
        this.promptSent = false;
        break;
      case "step/start":
        this.stepStartMs = e.time;
        break;
      case "user/message": {
        const source = d.source?.kind ?? "user";
        if (source === "subagent-settled") out.push(...this.subagentSettled(e.time, String(d.source?.senderSessionId ?? "")));
        if (!this.promptSent && TRIGGER_SOURCES.has(source)) out.push(this.prompt(e.time, source, textLength(d.content)));
        break;
      }
      case "request/header":
        // A turn with no recognised trigger (e.g. a fresh subagent brief) still needs a prompt row,
        // because the analyzer only counts a prompt.id as a turn when it has one.
        if (!this.promptSent && this.turn > 0) out.push(this.prompt(e.time, "other", 0));
        break;
      case "assistant/message": {
        if (!this.promptSent && this.turn > 0) out.push(this.prompt(this.turnStartMs || e.time, "other", 0));
        const u = d.usage ?? {};
        const src = d.message?.source ?? {};
        const stream = Array.isArray(d.stream) ? d.stream : [];
        const first = stream.find((c) => c?.type === "chunk");
        const finish = stream.findLast?.((c) => c?.chunk?.type === "finish");
        const start = this.stepStartMs && this.stepStartMs <= e.time ? this.stepStartMs : e.time;
        const toolCalls = Array.isArray(d.message?.content) ? d.message.content.filter((b) => b?.type === "tool-call").length : 0;
        out.push(
          this.record(e.time, "api_request", {
            model: src.model,
            provider: src.provider,
            input_tokens: u.inputTokens ?? 0,
            output_tokens: u.outputTokens ?? 0,
            cache_read_tokens: u.cacheReadTokens ?? 0,
            cache_creation_tokens: u.cacheWriteTokens ?? 0,
            "dsh.total_tokens": u.totalTokens,
            duration_ms: e.time - start,
            ttft_ms: first ? first.time - start : undefined,
            stop_reason: finish?.chunk?.reason?.kind,
            "dsh.tool_calls": toolCalls,
            "dsh.interrupted": d.interrupted === true ? true : undefined,
            query_source: this.isSubagent ? "subagent" : "repl_main_thread",
            "dsh.step": d.step,
            "dsh.turn": d.turn,
          }),
        );
        break;
      }
      case "tool/call":
        this.calls.set(String(d.callId), { name: String(d.name), time: e.time, args: parseArgs(d.arguments) });
        break;
      case "tool/result": {
        const id = String(d.message?.toolCallId ?? d.message?.source?.callId ?? "");
        const call = this.calls.get(id);
        this.calls.delete(id);
        const name = call?.name ?? "unknown";
        const attrs = {
          tool_name: name,
          success: d.message?.isError !== true,
          duration_ms: call ? e.time - call.time : 0,
          tool_parameters: toolParameters(name, call?.args ?? {}),
          tool_result_size_bytes: textLength(d.message?.content),
          "dsh.call_id": id,
        };
        // run_code is a wrapper; its nested calls are reported as their own tool_result rows.
        out.push(this.record(e.time, name === "run_code" ? "dsh.run_code" : "tool_result", attrs));
        break;
      }
      case "tool/ptc-dispatch-start":
        this.ptcStarts.set(String(d.subCallId), e.time);
        break;
      case "tool/ptc-dispatch": {
        const start = this.ptcStarts.get(String(d.subCallId));
        this.ptcStarts.delete(String(d.subCallId));
        const name = String(d.name);
        out.push(
          this.record(e.time, "tool_result", {
            tool_name: name,
            success: d.isError !== true,
            duration_ms: start !== undefined ? e.time - start : 0,
            tool_parameters: toolParameters(name, parseArgs(d.arguments)),
            tool_result_size_bytes: textLength(d.content),
            "dsh.call_id": d.subCallId,
            "dsh.root_call_id": d.rootCallId,
            "dsh.nested": true,
          }),
        );
        break;
      }
      case "llm/retry":
        out.push(
          this.record(e.time, "api_error", {
            status_code: d.failure?.code,
            error: cap(d.failure?.message ?? "", 300),
            attempt: d.retry,
            "dsh.max_retries": d.maxRetries,
            "dsh.delay_ms": Math.round(Number(d.delayMs) || 0),
            provider: d.provider,
          }),
        );
        break;
      case "compaction/start":
        this.compactions.set(String(d.compactionId), e.time);
        break;
      case "compaction/end": {
        const start = this.compactions.get(String(d.compactionId));
        this.compactions.delete(String(d.compactionId));
        out.push(this.record(e.time, "compaction", { duration_ms: start !== undefined ? e.time - start : 0, success: true, trigger: "auto" }));
        break;
      }
      case "approval/asked":
        this.approvals.set(String(d.id), e.time);
        break;
      case "approval/decided": {
        const start = this.approvals.get(String(d.id));
        this.approvals.delete(String(d.id));
        out.push(this.record(e.time, "tool_decision", { decision: d.outcome, source: "dsh-approval", duration_ms: start !== undefined ? e.time - start : 0 }));
        break;
      }
      case "turn/end":
        out.push(
          this.record(e.time, "dsh.turn_end", {
            "dsh.turn": d.turn,
            reason: d.reason?.kind,
            duration_ms: this.turnStartMs ? e.time - this.turnStartMs : 0,
            success: d.reason?.kind === "completed",
          }),
        );
        break;
      case "job/settled":
        out.push(
          this.record(e.time, "dsh.job", {
            kind: d.kind,
            label: cap(d.label ?? "", 300),
            status: d.status,
            detail: cap(d.detail ?? "", 200),
            duration_ms: d.finishedAt && d.startedAt ? d.finishedAt - d.startedAt : 0,
            "dsh.call_id": d.toolCall?.callId,
          }),
        );
        break;
      case "subagent/catalog":
        this.children.set(String(d.childId), { createdAt: Number(d.childCreatedAt) || e.time, label: String(d.label ?? ""), mode: String(d.mode ?? "") });
        out.push(this.record(e.time, "dsh.subagent_spawned", { "dsh.child_session": d.childId, label: cap(d.label ?? "", 300), mode: d.mode }));
        break;
      case "subagent/descriptor":
        out.push(this.record(e.time, "dsh.subagent", { label: cap(d.label ?? "", 300), mode: d.mode, model: d.agentModel, provider: d.agentProvider }));
        break;
      case "request/context":
        out.push(this.record(e.time, "dsh.request_context", { model: d.model, provider: d.provider, context_window: d.contextWindow }));
        break;
      case "session/title":
        out.push(this.record(e.time, "dsh.session_title", { title: cap(d.title ?? "", 200), source: d.source?.kind }));
        break;
      case "working-directory/change":
        out.push(this.record(e.time, "dsh.cwd_change", { "dsh.body": cap(d, BODY_CAP) }));
        break;
      default:
        if (SKIPPED.has(e.type)) break;
        out.push(this.record(e.time, `dsh.${e.type}`, { "dsh.body": cap(d, BODY_CAP) }));
    }
    for (const r of out) r.attrs["event.sequence"] = seq;
    return out;
  }
}
