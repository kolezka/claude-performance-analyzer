import { expect, test } from "bun:test";
import { barWidth, extraNum, mcpHealth, selectionFrom, splitPermission, splitToolLabel, toolShare, totals } from "../src/pages/tools/logic";

const stat = (o: Partial<{ name: string; count: number; totalMs: number; p50: number; p95: number; failures: number; extra: Record<string, number | string> }>) => ({
  name: "x",
  count: 1,
  totalMs: 0,
  p50: 0,
  p95: 0,
  maxMs: 0,
  failures: 0,
  ...o,
});

test("selectionFrom reads name and kind", () => {
  expect(selectionFrom({})).toBeNull();
  expect(selectionFrom({ name: "Bash" })).toEqual({ kind: "tools", name: "Bash" });
  expect(selectionFrom({ name: "Explore", kind: "agents" })).toEqual({ kind: "agents", name: "Explore" });
  expect(selectionFrom({ name: "Bash", kind: "hooks" })).toEqual({ kind: "tools", name: "Bash" });
});

test("toolShare handles empty breakdown", () => {
  expect(toolShare({ api: 0, tools: 0, hooks: 0 })).toBe(0);
  expect(toolShare({ api: 50, tools: 25, hooks: 25 })).toBe(0.25);
});

test("totals sums counts, time and failures", () => {
  expect(totals([stat({ count: 2, totalMs: 10, failures: 1 }), stat({ count: 3, totalMs: 5 })])).toEqual({ count: 5, totalMs: 15, failures: 1 });
});

test("barWidth keeps nonzero bars visible", () => {
  expect(barWidth(0, 100)).toBe("0%");
  expect(barWidth(1, 0)).toBe("0%");
  expect(barWidth(1, 1000)).toBe("1%");
  expect(barWidth(50, 100)).toBe("50%");
});

test("splitToolLabel separates mcp server and Agent prefix", () => {
  expect(splitToolLabel("Bash")).toEqual({ main: "Bash", hint: null });
  expect(splitToolLabel("mcp: outline/list_documents")).toEqual({ main: "list_documents", hint: "mcp outline" });
  expect(splitToolLabel("Agent: Explore")).toEqual({ main: "Explore", hint: "Agent" });
});

test("mcpHealth flags failures and slow connects", () => {
  expect(mcpHealth(stat({ count: 3, p50: 300 }))).toBe("ok");
  expect(mcpHealth(stat({ count: 3, p50: 6400 }))).toBe("warn");
  expect(mcpHealth(stat({ count: 3, failures: 1 }))).toBe("warn");
  expect(mcpHealth(stat({ count: 2, failures: 2 }))).toBe("crit");
});

test("splitPermission splits on the last separator", () => {
  expect(splitPermission("config / accept")).toEqual({ source: "config", decision: "accept" });
  expect(splitPermission("odd")).toEqual({ source: "odd", decision: "?" });
});

test("extraNum tolerates missing and string values", () => {
  expect(extraNum(stat({}), "activations")).toBe(0);
  expect(extraNum(stat({ extra: { activations: 3 } }), "activations")).toBe(3);
  expect(extraNum(stat({ extra: { costUsd: "0.5" } }), "costUsd")).toBe(0.5);
});
