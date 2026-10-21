import { expect, test } from "bun:test";
import { candidates, findingLine, narrowingHint, patternKey, patternLabel, summarizePatterns } from "../src/hook-drilldown";
import type { HookCall, HookDefinition } from "../src/hooks";

function call(p: Partial<HookCall> & { count: number; success: number }): HookCall {
  return { hookEvent: "UserPromptSubmit", matcher: null, errors: 0, blocking: 0, cancelled: 0, stdoutChars: 0, contextChars: 0, ...p };
}

function r(count: number, success: number, errors: number, ms: number) {
  return { call: call({ count, success, errors }), ms };
}

function def(name: string, timeoutSec: number | null): HookDefinition {
  return { source: "plugin", plugin: name, matcher: null, type: "command", command: `run ${name}`, summary: `run ${name}`, sessions: 1, configPath: null, timeoutSec };
}

test("patternKey and patternLabel", () => {
  const c = call({ count: 3, success: 2, errors: 1 });
  expect(patternKey(c)).toBe("2/3:1:0:0");
  expect(patternLabel(c)).toBe("2/3 OK · 1 error");
  expect(patternLabel(call({ count: 1, success: 0, blocking: 1 }))).toBe("0/1 OK · 1 blocked");
  expect(patternLabel(call({ count: 3, success: 0, errors: 2, cancelled: 1 }))).toBe("0/3 OK · 2 errors · 1 cancelled");
});

test("summarizePatterns groups, counts errors, sorts by count", () => {
  const p = summarizePatterns([r(3, 3, 0, 300), r(3, 3, 0, 400), r(3, 2, 1, 250)]);
  expect(p.map((x) => [x.label, x.count, x.errors])).toEqual([
    ["3/3 OK", 2, 0],
    ["2/3 OK · 1 error", 1, 1],
  ]);
  expect(p[0]!.key).toBe("3/3:0:0:0");
  expect(p[0]!.p95).toBe(400);
});

test("findingLine: none when no errors", () => {
  expect(findingLine([{ call: call({ count: 1, success: 1 }), headless: false, launcher: null }])).toBeNull();
});

test("findingLine: all headless with one launcher", () => {
  const rows = [1, 2].map(() => ({ call: call({ count: 3, success: 2, errors: 1 }), headless: true, launcher: "self-improvement-loop" }));
  expect(findingLine(rows)).toBe("2 calls reported errors, all headless, launched by self-improvement-loop. Failing script not reported.");
});

test("findingLine: mixed kinds states both counts", () => {
  const rows = [
    { call: call({ count: 3, success: 2, errors: 1 }), headless: true, launcher: null },
    { call: call({ count: 3, success: 2, errors: 1 }), headless: false, launcher: null },
  ];
  expect(findingLine(rows)).toBe("2 calls reported errors: 1 headless, 1 interactive. Failing script not reported.");
});

test("findingLine: no launcher clause when failing rows disagree on the launcher", () => {
  const rows = [
    { call: call({ count: 1, success: 0, errors: 1 }), headless: true, launcher: "a" },
    { call: call({ count: 1, success: 0, errors: 1 }), headless: true, launcher: null },
  ];
  expect(findingLine(rows)).toBe("2 calls reported errors, all headless. Failing script not reported.");
});

test("candidates: matched, mismatch, none", () => {
  const defs = [def("a", 5), def("b", 30), def("c", null)];
  expect(candidates(call({ count: 3, success: 3 }), defs).status).toBe("matched");
  expect(candidates(call({ count: 1, success: 1 }), defs).status).toBe("mismatch");
  expect(candidates(call({ count: 1, success: 1 }), []).status).toBe("none");
});

test("narrowingHint rules out scripts whose timeout is below the duration", () => {
  const defs = [def("self-improvement-loop", 5), def("hindsight", 30), def("security-guidance", null)];
  expect(narrowingHint(25_523, "matched", defs)).toBe(
    "25.5s is over the 5s timeout of self-improvement-loop, so only hindsight (30s timeout) or security-guidance (no timeout set) could take this long.",
  );
  expect(narrowingHint(2_000, "matched", defs)).toBeNull();
  expect(narrowingHint(25_523, "mismatch", defs)).toBeNull();
  // Every script ruled out leaves nothing to point at, so no hint.
  expect(narrowingHint(60_000, "matched", [def("a", 5), def("b", 30)])).toBeNull();
});
