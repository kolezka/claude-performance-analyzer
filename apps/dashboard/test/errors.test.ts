import { expect, test } from "bun:test";
import type { LatencyStats, Summary } from "@cpa/analytics";
import { counters, failedTargets, groups, isDenial, mergeFailed, type FailedCall } from "../src/pages/errors/model";

const ms = (n: number) => `${n}ms`;
const stat = (name: string, count: number, failures: number): LatencyStats => ({ name, count, totalMs: 0, p50: 0, p95: 0, maxMs: 0, failures });

function summary(over: Partial<Summary> = {}, kpis: Partial<Summary["kpis"]> = {}): Summary {
  return {
    errors: [],
    tools: [],
    hooks: [],
    mcpConnections: [],
    permissions: [],
    ...over,
    kpis: { compactions: 0, compactionMs: 0, ...kpis },
  } as unknown as Summary;
}

test("isDenial treats anything but accept or allow as a denial", () => {
  expect(isDenial("config / accept")).toBe(false);
  expect(isDenial("user / allow")).toBe(false);
  expect(isDenial("user / reject")).toBe(true);
  expect(isDenial("unknown / ?")).toBe(true);
});

test("counters sum API errors, tool failures, denials and compactions", () => {
  const s = summary(
    {
      errors: [["API 529", 4]],
      tools: [stat("Bash", 10, 3), stat("Edit", 5, 2), stat("Read", 9, 0)],
      permissions: [["config / accept", 29], ["user / reject", 2]],
    },
    { compactions: 1, compactionMs: 14000 },
  );
  expect(counters(s, ms)).toEqual([
    { label: "API errors", value: 4, sub: "all 529" },
    { label: "Tool failures", value: 5, sub: "Bash 3 · Edit 2" },
    { label: "Permission denials", value: 2, sub: "of 31 decisions" },
    { label: "Compactions", value: 1, sub: "14000ms spent" },
  ]);
});

test("counters read none on an empty window", () => {
  const subs = counters(summary(), ms).map((c) => [c.value, c.sub]);
  expect(subs).toEqual([[0, "none"], [0, "none"], [0, "no decisions"], [0, "none"]]);
});

test("groups list each source once and link only tools and hooks", () => {
  const s = summary(
    {
      errors: [["API 529", 2], ["API 500", 1]],
      tools: [stat("Edit", 5, 1), stat("Bash", 10, 3), stat("Read", 9, 0)],
      hooks: [stat("PreToolUse:Bash", 4, 1)],
      mcpConnections: [stat("outline", 2, 2)],
      permissions: [["user / reject", 1], ["config / accept", 3]],
    },
    { compactions: 2, compactionMs: 500 },
  );
  const g = groups(s, ms);
  expect(g.map((r) => [r.kind, r.title, r.count])).toEqual([
    ["api", "API error 529", 2],
    ["api", "API error 500", 1],
    ["tool", "Bash", 3],
    ["tool", "Edit", 1],
    ["hook", "PreToolUse:Bash", 1],
    ["mcp", "outline", 2],
    ["denied", "Permission user / reject", 1],
    ["compact", "Compaction", 2],
  ]);
  expect(g.filter((r) => r.link).map((r) => r.link)).toEqual([
    { page: "tools", name: "Bash" },
    { page: "tools", name: "Edit" },
    { page: "hooks", name: "PreToolUse:Bash" },
  ]);
});

test("failedTargets picks the worst failing tools and hooks only", () => {
  const s = summary({ tools: [stat("A", 1, 1), stat("B", 1, 5), stat("C", 1, 0)], hooks: [stat("H", 1, 2)] });
  expect(failedTargets(s, 1)).toEqual([{ kind: "tools", name: "B" }, { kind: "hooks", name: "H" }]);
});

test("mergeFailed sorts newest first, drops duplicate ids and caps the list", () => {
  const call = (id: number, tsMs: number): FailedCall => ({ id, tsMs, ms: 1, kind: "tool", name: "x", detail: null, repo: null, promptId: null });
  const merged = mergeFailed([[call(1, 10), call(2, 30)], [call(2, 30), call(3, 20)]], 2);
  expect(merged.map((c) => c.id)).toEqual([2, 3]);
});
