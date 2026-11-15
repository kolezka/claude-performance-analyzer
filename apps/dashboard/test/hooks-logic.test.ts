import { expect, test } from "bun:test";
import type { LatencyStats } from "@cpa/analytics";
import { callBars, candidateNote, parseSort, pickHook, sortHooks } from "../src/pages/hooks/logic";

const stat = (name: string, totalMs: number, p95: number): LatencyStats => ({ name, count: 1, totalMs, p50: 0, p95, maxMs: p95, failures: 0 });
const hooks = [stat("A", 100, 3000), stat("B", 500, 200), stat("C", 300, 900)];

test("sortHooks orders by total or p95, descending, without mutating input", () => {
  expect(sortHooks(hooks, "total").map((h) => h.name)).toEqual(["B", "C", "A"]);
  expect(sortHooks(hooks, "p95").map((h) => h.name)).toEqual(["A", "C", "B"]);
  expect(hooks.map((h) => h.name)).toEqual(["A", "B", "C"]);
});

test("sortHooks breaks ties by name so the order is stable", () => {
  expect(sortHooks([stat("z", 1, 1), stat("a", 1, 1)], "total").map((h) => h.name)).toEqual(["a", "z"]);
});

test("parseSort defaults to total", () => {
  expect(parseSort(undefined)).toBe("total");
  expect(parseSort("junk")).toBe("total");
  expect(parseSort("p95")).toBe("p95");
});

test("pickHook keeps a known name, else falls back to the slowest by total", () => {
  expect(pickHook(hooks, "C")).toBe("C");
  expect(pickHook(hooks, "gone")).toBe("B");
  expect(pickHook(hooks, undefined)).toBe("B");
  expect(pickHook([], "A")).toBeNull();
});

test("callBars orders oldest first, scales to the slowest and flags calls over 1s", () => {
  const bars = callBars([
    { tsMs: 3, ms: 2000 },
    { tsMs: 1, ms: 0 },
    { tsMs: 2, ms: 1000 },
  ]);
  expect(bars.map((b) => b.call.tsMs)).toEqual([1, 2, 3]);
  expect(bars.map((b) => b.height)).toEqual([4, 50, 100]);
  expect(bars.map((b) => b.slow)).toEqual([false, false, true]);
  expect(callBars([])).toEqual([]);
});

test("candidateNote covers every status", () => {
  for (const s of ["matched", "mismatch", "unresolved", "remote", "none"] as const) expect(candidateNote(s, 2).length).toBeGreaterThan(0);
  expect(candidateNote("matched", 1)).toContain("one script");
});
