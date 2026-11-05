import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsByNameForSessionsSql, openStore } from "../src/db";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "cc-db-"));
  return openStore(join(dir, "t.sqlite"));
}

test("eventsByName filters in SQL so callers never parse other event types", () => {
  const s = store();
  const now = Date.now();
  s.addEvents([
    { tsMs: now, name: "tool_result", sessionId: "s1", promptId: null, attrs: { tool_name: "Bash" } },
    { tsMs: now, name: "hook_execution_complete", sessionId: "s1", promptId: null, attrs: { hook_name: "Stop" } },
    { tsMs: now, name: "tool_result", sessionId: "s2", promptId: null, attrs: { tool_name: "Read" } },
  ]);

  const rows = s.eventsByName(now - 1000, "tool_result");
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.name === "tool_result")).toBe(true);
  expect(rows.every((r) => typeof r.id === "number")).toBe(true);
});

test("hookEventsByLabel matches hookLabel()'s own fallback (hook_name, else hook_event, else 'unknown') entirely in SQL", () => {
  const s = store();
  const now = Date.now();
  s.addEvents([
    { tsMs: now, name: "hook_execution_complete", sessionId: "s1", promptId: null, attrs: { hook_name: "PreToolUse:Bash", hook_event: "PreToolUse" } },
    { tsMs: now, name: "hook_execution_complete", sessionId: "s2", promptId: null, attrs: { hook_event: "Stop" } }, // no hook_name: falls back to hook_event
    { tsMs: now, name: "hook_execution_complete", sessionId: "s3", promptId: null, attrs: {} }, // neither: falls back to "unknown"
    { tsMs: now, name: "hook_execution_complete", sessionId: "s4", promptId: null, attrs: { hook_name: "Stop" } }, // same label as s2, different field
    { tsMs: now, name: "tool_result", sessionId: "s5", promptId: null, attrs: { tool_name: "Stop" } }, // different event name: never matches
  ]);

  expect(s.hookEventsByLabel(now - 1000, "PreToolUse:Bash").map((r) => r.sessionId)).toEqual(["s1"]);
  expect(s.hookEventsByLabel(now - 1000, "Stop").map((r) => r.sessionId).sort()).toEqual(["s2", "s4"]);
  expect(s.hookEventsByLabel(now - 1000, "unknown").map((r) => r.sessionId)).toEqual(["s3"]);
  expect(s.hookEventsByLabel(now - 1000, "nope")).toHaveLength(0);
});

test("spansForSession restricts to one session and a start_ms range", () => {
  const s = store();
  const now = Date.now();
  s.addSpans([
    { traceId: "t", spanId: "a", parentId: null, name: "claude_code.tool", startMs: now, endMs: now + 10, sessionId: "s1", attrs: { tool_use_id: "u1" } },
    { traceId: "t", spanId: "b", parentId: null, name: "claude_code.tool", startMs: now, endMs: now + 10, sessionId: "s2", attrs: { tool_use_id: "u2" } },
    { traceId: "t", spanId: "c", parentId: null, name: "claude_code.tool", startMs: now - 100_000, endMs: now - 99_990, sessionId: "s1", attrs: { tool_use_id: "u3" } },
  ]);

  const rows = s.spansForSession("s1", now - 1000, now + 1000);
  expect(rows.map((r) => r.spanId)).toEqual(["a"]);
});

test("sessionEventsByNames restricts the session query to the given event names", () => {
  const s = store();
  const now = Date.now();
  s.addEvents([
    { tsMs: now, name: "tool_result", sessionId: "s1", promptId: null, attrs: {} },
    { tsMs: now, name: "hook_execution_complete", sessionId: "s1", promptId: null, attrs: {} },
    { tsMs: now, name: "user_prompt", sessionId: "s1", promptId: null, attrs: {} },
    { tsMs: now, name: "tool_result", sessionId: "s2", promptId: null, attrs: {} },
  ]);

  const rows = s.sessionEventsByNames("s1", ["tool_result", "user_prompt"]);
  expect(rows.map((r) => r.name).sort()).toEqual(["tool_result", "user_prompt"]);
});

test("eventsByNameForSessions uses the session index and returns rows in time order", () => {
  const s = store();
  const now = Date.now();
  s.addEvents([
    { tsMs: now + 2, name: "hook_registered", sessionId: "s1", promptId: null, attrs: { hook_event: "Stop" } },
    { tsMs: now + 1, name: "hook_registered", sessionId: "s2", promptId: null, attrs: { hook_event: "Stop" } },
    { tsMs: now + 3, name: "hook_registered", sessionId: "s1", promptId: null, attrs: { hook_event: "PreToolUse" } },
    { tsMs: now, name: "tool_result", sessionId: "s1", promptId: null, attrs: {} },
    { tsMs: now + 4, name: "hook_registered", sessionId: "s3", promptId: null, attrs: {} },
  ]);
  const rows = s.eventsByNameForSessions("hook_registered", ["s1", "s2"]);
  expect(rows.map((r) => [r.sessionId, r.tsMs - now])).toEqual([["s2", 1], ["s1", 2], ["s1", 3]]);

  // Ordering by time in SQL made the planner walk the host's whole time index: 2.7 s on a
  // 2 million row database. The session index answers in milliseconds; sort the few rows in code.
  const plan = s.db.query(`EXPLAIN QUERY PLAN ${eventsByNameForSessionsSql(2)}`).all("local", "hook_registered", "s1", "s2") as { detail: string }[];
  const details = plan.map((p) => p.detail).join("\n");
  expect(details).toContain("events_host_session");
  expect(details).not.toContain("events_host_ts");
});
