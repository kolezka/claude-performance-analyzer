import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";

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
