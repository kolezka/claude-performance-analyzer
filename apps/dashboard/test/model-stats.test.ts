import { expect, test } from "bun:test";
import type { LatencyStats } from "@cpa/analytics";
import { apiErrors, cacheHitLow, modelCards } from "../src/pages/models/model-stats";

const stat = (name: string, count: number): LatencyStats => ({ name, count, totalMs: count * 1000, p50: 1000, p95: 2000, maxMs: 3000, failures: 0 });

test("modelCards sorts by request count, then name, and computes share", () => {
  const cards = modelCards([stat("b", 1), stat("a", 3), stat("c", 1)]);
  expect(cards.map((c) => c.name)).toEqual(["a", "b", "c"]);
  expect(cards[0]!.share).toBe(0.6);
  expect(cards[1]!.share).toBe(0.2);
});

test("modelCards handles no requests without dividing by zero", () => {
  expect(modelCards([])).toEqual([]);
  expect(modelCards([stat("a", 0)])[0]!.share).toBe(0);
});

test("modelCards does not mutate its input", () => {
  const input = [stat("b", 1), stat("a", 3)];
  modelCards(input);
  expect(input.map((m) => m.name)).toEqual(["b", "a"]);
});

test("modelCards reads per-model cost, tokens and cache hit from extra", () => {
  const m = { ...stat("a", 2), extra: { costUsd: 0.5, input: 100, output: 40, cacheRead: 300, cacheCreation: 100 } };
  const [card] = modelCards([m]);
  expect(card).toMatchObject({ costUsd: 0.5, input: 100, output: 40, cacheRead: 300, cacheCreation: 100 });
  expect(card!.cacheHit).toBeCloseTo(0.6);
  expect(modelCards([stat("b", 1)])[0]!.cacheHit).toBeNull();
});

test("cacheHitLow flags a low ratio only when there was input", () => {
  expect(cacheHitLow(0.5, 100)).toBe(true);
  expect(cacheHitLow(0.9, 100)).toBe(false);
  expect(cacheHitLow(0, 0)).toBe(false);
});

test("apiErrors keeps only API error kinds", () => {
  expect(
    apiErrors([
      ["API 529", 4],
      ["Tool failure", 2],
      ["API error", 1],
    ]),
  ).toEqual([
    ["API 529", 4],
    ["API error", 1],
  ]);
});
