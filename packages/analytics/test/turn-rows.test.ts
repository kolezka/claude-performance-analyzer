import { expect, test } from "bun:test";
import { buildTurnRows, prettyModelName } from "../src";

let nextSpanId = 1;
const row = (name: string, tsMs: number, attrs: Record<string, unknown> = {}, opts: { id?: number; sessionId?: string } = {}) => ({
  tsMs,
  name,
  sessionId: opts.sessionId ?? "s1",
  promptId: "p1",
  id: opts.id,
  attrs,
});
const span = (name: string, startMs: number, endMs: number, attrs: Record<string, unknown> = {}, sessionId = "s1") => ({
  traceId: "t",
  spanId: `sp-${nextSpanId++}`,
  parentId: null,
  name,
  startMs,
  endMs,
  sessionId,
  attrs,
});

test("prettyModelName strips a trailing [...] suffix before and after recognizing the family", () => {
  expect(prettyModelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
  expect(prettyModelName("claude-sonnet-5[1m]")).toBe("Sonnet 5");
  expect(prettyModelName("gpt-6-luna[1m]")).toBe("gpt-6-luna");
});

test("prettyModelName turns a claude-<family>-<version> id into a readable label, else passes through", () => {
  expect(prettyModelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(prettyModelName("claude-sonnet-5")).toBe("Sonnet 5");
  expect(prettyModelName("claude-haiku-5-5")).toBe("Haiku 5.5");
  expect(prettyModelName("claude-fable-5-1")).toBe("Fable 5.1");
  expect(prettyModelName("gpt-6-luna")).toBe("gpt-6-luna");
  expect(prettyModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
});

test("without spans, api and tool rows land in the main lane", () => {
  const events = [
    row("api_request", 1000, { model: "claude-sonnet-5", duration_ms: 200, query_source: "repl_main_thread" }, { id: 1 }),
    row("tool_result", 1300, { tool_name: "Bash", duration_ms: 50, success: "true" }, { id: 2 }),
  ];
  const { lanes, rows, breakdown } = buildTurnRows(events, []);
  expect(lanes.map((l) => l.id)).toEqual(["main"]);
  expect(rows.map((r) => [r.lane, r.kind, r.label])).toEqual([
    ["main", "api", "Sonnet 5"],
    ["main", "tool", "Bash"],
  ]);
  expect(breakdown).toEqual({ apiMs: 200, toolMs: 50, hookMs: 0 });
});

test("a tool_result matched to a claude_code.tool span lands in that agent_id's lane", () => {
  const events = [row("tool_result", 2000, { tool_name: "Read", duration_ms: 100, success: "true", tool_use_id: "tu1" }, { id: 5 })];
  const spans = [span("claude_code.tool", 1850, 2000, { tool_use_id: "tu1", agent_id: "agent123" })];
  const { lanes, rows } = buildTurnRows(events, spans);
  expect(rows[0]!.lane).toBe("agent123");
  expect(lanes).toEqual([{ id: "agent123", kind: "subagent", title: "Subagent agent123", model: null }]);
});

test("an api_request matched to an llm_request span joins that agent_id's lane, titled from agent.name", () => {
  const events = [row("api_request", 3000, { model: "claude-sonnet-5", duration_ms: 500, query_source: "agent:custom", "agent.name": "route-sonnet" }, { id: 7 })];
  const spans = [span("claude_code.llm_request", 2500, 3000, { model: "claude-sonnet-5", agent_id: "deadbeef01" })];
  const { lanes, rows } = buildTurnRows(events, spans);
  expect(rows[0]!.lane).toBe("deadbeef01");
  expect(lanes[0]).toMatchObject({ id: "deadbeef01", kind: "subagent", title: "Subagent · route-sonnet", model: "Sonnet 5" });
});

test("an api_request still matches its llm_request span when one side carries a [...] suffix the other lacks", () => {
  const events = [row("api_request", 3000, { model: "claude-sonnet-5[1m]", duration_ms: 500, query_source: "agent:custom", "agent.name": "route-sonnet" }, { id: 7 })];
  const spans = [span("claude_code.llm_request", 2500, 3000, { model: "claude-sonnet-5", agent_id: "deadbeef01" })];
  const { lanes, rows } = buildTurnRows(events, spans);
  expect(rows[0]!.lane).toBe("deadbeef01");
  // lane.model is pretty and suffix-free, even though the api_request's own model carried [1m]:
  // the app appends it straight onto the lane title ("Subagent · route-sonnet (Sonnet 5)").
  expect(lanes[0]).toMatchObject({ id: "deadbeef01", kind: "subagent", title: "Subagent · route-sonnet", model: "Sonnet 5" });
});

test("an api fallback lane and an unnamed span-derived lane for the same agent, overlapping in time, merge into one", () => {
  // The tool side matched a claude_code.tool span and got a bare agent_id lane with no name
  // (its api_request never matched, as if some other mismatch than the bracket suffix slipped
  // through). The api side fell back to query_source and got "agent:route-sonnet" instead.
  const events = [
    // api_request span [1650, 1950] overlaps the tool's own span [1900, 2000]: the subagent
    // called the model, got told to run a tool, and the tool started just before the call was
    // logged as finished (both are logged on completion, so their own spans naturally overlap).
    row("api_request", 1950, { model: "claude-sonnet-5", duration_ms: 300, query_source: "agent:route-sonnet", "agent.name": "route-sonnet" }, { id: 7 }),
    row("tool_result", 2000, { tool_name: "Read", duration_ms: 100, success: "true", tool_use_id: "tu1" }, { id: 5 }),
  ];
  const spans = [span("claude_code.tool", 1850, 2000, { tool_use_id: "tu1", agent_id: "agent123" })];
  const { lanes, rows } = buildTurnRows(events, spans);

  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({ id: "agent123", kind: "subagent", title: "Subagent · route-sonnet", model: "Sonnet 5" });
  expect(rows.every((r) => r.lane === "agent123")).toBe(true);
});

test("an api_request with no matching span falls back to query_source: a lane keyed by its own agent name", () => {
  const events = [row("api_request", 4000, { model: "claude-haiku-5-5", duration_ms: 300, query_source: "agent:custom", "agent.name": "custom-agent" }, { id: 9 })];
  const { lanes, rows } = buildTurnRows(events, []);
  expect(rows[0]!.lane).toBe("agent:custom-agent");
  expect(lanes[0]).toMatchObject({ id: "agent:custom-agent", title: "Subagent · custom-agent", model: "Haiku 5.5" });
});

test("a background api_request gets the humanized query_source appended to its pretty-model label", () => {
  const events = [row("api_request", 5000, { model: "claude-opus-5-5", duration_ms: 400, query_source: "away_summary" }, { id: 11 })];
  const { lanes, rows } = buildTurnRows(events, []);
  expect(rows[0]!.lane).toBe("background");
  expect(rows[0]!.label).toBe("Opus 5.5 · away summary");
  expect(lanes[0]).toMatchObject({ id: "background", kind: "background", title: "Background" });
});

test("PreToolUse and PostToolUse hooks attach to the tool row they bracket", () => {
  const events = [
    row("hook_execution_complete", 990, { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", hook_matcher: "Bash", total_duration_ms: 20 }, { id: 20 }),
    row("tool_result", 1100, { tool_name: "Bash", duration_ms: 100, success: "true" }, { id: 21 }), // its own span is [1000, 1100]
    row("hook_execution_complete", 1150, { hook_event: "PostToolUse", hook_name: "PostToolUse:Bash", hook_matcher: "Bash", total_duration_ms: 30 }, { id: 22 }),
  ];
  const { rows, breakdown } = buildTurnRows(events, []);
  const tool = rows.find((r) => r.kind === "tool")!;
  expect(tool.pre).toEqual({ startMs: 970, endMs: 990, id: 20 });
  expect(tool.post).toEqual({ startMs: 1120, endMs: 1150, id: 22 });
  expect(tool.hookMs).toBe(50);
  expect(rows.filter((r) => r.kind === "hooks")).toHaveLength(0);
  expect(breakdown.hookMs).toBe(50);
});

test("a hook for a different tool is never attached", () => {
  const events = [
    row("hook_execution_complete", 990, { hook_event: "PreToolUse", hook_name: "PreToolUse:Write", hook_matcher: "Write", total_duration_ms: 20 }, { id: 23 }),
    row("tool_result", 1100, { tool_name: "Bash", duration_ms: 100, success: "true" }, { id: 24 }),
  ];
  const { rows } = buildTurnRows(events, []);
  const tool = rows.find((r) => r.kind === "tool")!;
  expect(tool.pre).toBeNull();
  const hooksRow = rows.find((r) => r.kind === "hooks")!;
  expect(hooksRow).toBeDefined();
  expect(hooksRow.lane).toBe("main");
});

test("a PreToolUse hook attaches across a multi-second gap (permission check, auto-mode classifier) up to 30s", () => {
  const events = [
    row("hook_execution_complete", 1000, { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", total_duration_ms: 50 }, { id: 40 }), // ends at 1000
    row("tool_result", 3500, { tool_name: "Bash", duration_ms: 100, success: "true" }, { id: 41 }), // starts at 3400, 2400ms after the hook ends
  ];
  const { rows } = buildTurnRows(events, []);
  const tool = rows.find((r) => r.kind === "tool")!;
  expect(tool.pre).toMatchObject({ id: 40 });
});

test("a PreToolUse hook past the 30s window, or a PostToolUse hook past the 5s window, is not attached", () => {
  const farPre = [
    row("hook_execution_complete", 1000, { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", total_duration_ms: 50 }, { id: 42 }), // ends at 1000
    row("tool_result", 32_000, { tool_name: "Bash", duration_ms: 100, success: "true" }, { id: 43 }), // starts at 31900: 30900ms after the hook ends, over 30s
  ];
  expect(buildTurnRows(farPre, []).rows.find((r) => r.kind === "tool")!.pre).toBeNull();

  const farPost = [
    row("tool_result", 1000, { tool_name: "Bash", duration_ms: 100, success: "true" }, { id: 44 }), // ends at 1000
    row("hook_execution_complete", 6400, { hook_event: "PostToolUse", hook_name: "PostToolUse:Bash", total_duration_ms: 50 }, { id: 45 }), // starts at 6350: 5350ms after the tool ends, over 5s
  ];
  expect(buildTurnRows(farPost, []).rows.find((r) => r.kind === "tool")!.post).toBeNull();
});

test("a hook never skips over a nearer, already-claimed call of the same tool name to reach a farther one", () => {
  const events = [
    row("hook_execution_complete", 1000, { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", total_duration_ms: 0 }, { id: 50 }), // ends at 1000, processed first
    row("hook_execution_complete", 1050, { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", total_duration_ms: 0 }, { id: 52 }), // ends at 1050, processed second
    row("tool_result", 1080, { tool_name: "Bash", duration_ms: 20, success: "true" }, { id: 51 }), // starts at 1060: nearest to both hooks, claimed by the first
    row("tool_result", 2000, { tool_name: "Bash", duration_ms: 20, success: "true" }, { id: 53 }), // starts at 1980: a farther, unclaimed Bash call
  ];
  const { rows } = buildTurnRows(events, []);
  const tools = rows.filter((r) => r.kind === "tool");
  expect(tools[0]!.pre).toMatchObject({ id: 50 }); // the earlier hook claims the nearest tool call
  expect(tools[1]!.pre).toBeNull(); // the later hook does not skip ahead to the farther one
  const leftover = rows.find((r) => r.kind === "hooks")!;
  expect(leftover).toMatchObject({ id: 52, label: "PreToolUse:Bash" });
});

test("an MCP hook's qualified name (mcp__server__tool) matches the tool_result via its mcp_server_name/mcp_tool_name parameters, not its generic tool_name", () => {
  const events = [
    row("hook_execution_complete", 1000, { hook_event: "PreToolUse", hook_name: "PreToolUse:mcp__outline__list_collections", total_duration_ms: 20 }, { id: 60 }),
    row("tool_result", 1050, { tool_name: "mcp_tool", duration_ms: 50, success: "true", tool_parameters: JSON.stringify({ mcp_server_name: "outline", mcp_tool_name: "list_collections" }) }, { id: 61 }),
  ];
  const { rows } = buildTurnRows(events, []);
  const tool = rows.find((r) => r.kind === "tool")!;
  expect(tool.pre).toMatchObject({ id: 60 });
});

test("unattached lifecycle hooks get readable row labels in the main lane", () => {
  const events = [
    row("hook_execution_complete", 500, { hook_event: "UserPromptSubmit", hook_name: "UserPromptSubmit", total_duration_ms: 10, num_hooks: 2 }, { id: 30 }),
    row("hook_execution_complete", 600, { hook_event: "Stop", hook_name: "Stop", total_duration_ms: 15, num_hooks: 1 }, { id: 31 }),
    row("hook_execution_complete", 700, { hook_event: "SubagentStop", hook_name: "SubagentStop", total_duration_ms: 5, num_hooks: 1 }, { id: 32 }),
  ];
  const { rows } = buildTurnRows(events, []);
  expect(rows.map((r) => r.label)).toEqual(["Prompt hooks", "Stop hooks", "Subagent stop hooks"]);
  expect(rows.every((r) => r.lane === "main" && r.kind === "hooks")).toBe(true);
});

test("lanes are ordered main, subagents by first start, background last", () => {
  const events = [
    row("api_request", 9000, { model: "claude-sonnet-5", duration_ms: 100, query_source: "away_summary" }, { id: 40 }),
    row("api_request", 5000, { model: "claude-sonnet-5", duration_ms: 100, query_source: "agent:second", "agent.name": "second" }, { id: 41 }),
    row("api_request", 3000, { model: "claude-sonnet-5", duration_ms: 100, query_source: "agent:first", "agent.name": "first" }, { id: 42 }),
    row("api_request", 1000, { model: "claude-sonnet-5", duration_ms: 100, query_source: "repl_main_thread" }, { id: 43 }),
  ];
  const { lanes } = buildTurnRows(events, []);
  expect(lanes.map((l) => l.id)).toEqual(["main", "agent:first", "agent:second", "background"]);
});
