import { expect, test } from "bun:test";
import { idleGaps, promptBreakdowns } from "../src";

const BASE = Date.parse("2026-10-15T12:00:00Z");
const row = (name: string, tsMs: number, attrs: Record<string, unknown>, promptId = "p", sessionId = "s") => ({ tsMs, name, sessionId, promptId, attrs });

test("idleGaps: a 10-minute gap between a point event and a short tool call counts as idle, not active", () => {
  const events = [row("user_prompt", BASE, {}), row("tool_result", BASE + 600_000, { duration_ms: 1000 })];
  const { gaps, idleMs, activeMs } = idleGaps(events, BASE, BASE + 600_000);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toEqual({ startMs: BASE, endMs: BASE + 599_000 });
  expect(idleMs).toBeGreaterThan(590_000);
  expect(idleMs).toBeLessThan(610_000);
  expect(activeMs).toBe(1000);
});

test("idleGaps: a single tool call spanning the whole window produces no gap", () => {
  const events = [row("user_prompt", BASE, {}), row("tool_result", BASE + 600_000, { duration_ms: 600_000 })];
  const { gaps, idleMs, activeMs } = idleGaps(events, BASE, BASE + 600_000);
  expect(gaps).toHaveLength(0);
  expect(idleMs).toBe(0);
  expect(activeMs).toBe(600_000);
});

test("idleGaps: a gap under the 2-minute threshold is not reported", () => {
  const events = [row("user_prompt", BASE, {}), row("tool_result", BASE + 60_000, { duration_ms: 1000 })];
  const { gaps, idleMs } = idleGaps(events, BASE, BASE + 60_000);
  expect(gaps).toHaveLength(0);
  expect(idleMs).toBe(0);
});

test("idleGaps: a negative duration never produces a gap wider than the turn itself", () => {
  // A garbled/negative duration_ms must not invert the span into [tsMs+200000, tsMs] and leak
  // past endMs: reported repro was an 800000ms gap out of a 600000ms turn.
  const events = [row("api_request", BASE + 600_000, { duration_ms: -200_000 })];
  const { gaps, idleMs } = idleGaps(events, BASE, BASE + 600_000);
  for (const g of gaps) {
    expect(g.startMs).toBeGreaterThanOrEqual(BASE);
    expect(g.endMs).toBeLessThanOrEqual(BASE + 600_000);
  }
  expect(idleMs).toBeLessThanOrEqual(600_000);
});

test("promptBreakdowns: a long-idle prompt does not outrank a busy, shorter one by activeMs even though its wallMs is far bigger", () => {
  const idle = [row("user_prompt", BASE, {}, "p-idle"), row("api_request", BASE + 600_000, { duration_ms: 500 }, "p-idle")];
  const busy = [row("user_prompt", BASE + 1_000_000, {}, "p-busy"), row("tool_result", BASE + 1_030_000, { duration_ms: 29_000 }, "p-busy")];
  const breakdowns = promptBreakdowns([...idle, ...busy]);
  const idleP = breakdowns.get("p-idle")!;
  const busyP = breakdowns.get("p-busy")!;

  expect(idleP.wallMs).toBeGreaterThan(busyP.wallMs);
  expect(busyP.activeMs).toBeGreaterThan(idleP.activeMs);
  expect(idleP.idleMs).toBeGreaterThan(590_000);
});
