import { expect, test } from "bun:test";
import { promptBreakdowns, summarize, turnTimeline } from "../src";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const row = (name: string, tsMs: number, promptId: string | null, sessionId: string, attrs: Record<string, unknown> = {}) => ({ tsMs, name, sessionId, promptId, attrs });

test("promptBreakdowns drops a promptId with no user_prompt event: session-start noise is not a turn", () => {
  // A real prompt.id with no user_prompt event: just a pair of mcp_server_connection events,
  // the shape session-start noise takes when it happens to carry a stray prompt.id.
  const phantom = [row("mcp_server_connection", NOW, "p-phantom", "s1", { server_name: "outline", status: "connected" }), row("mcp_server_connection", NOW + 5000, "p-phantom", "s1", { status: "disconnected" })];
  const real = [row("user_prompt", NOW, "p-real", "s2"), row("api_request", NOW + 1000, "p-real", "s2", { duration_ms: 500 })];

  const breakdowns = promptBreakdowns([...phantom, ...real]);
  expect(breakdowns.has("p-phantom")).toBe(false);
  expect(breakdowns.has("p-real")).toBe(true);
});

test("summarize's prompt count and recentPrompts exclude the same phantom prompts", () => {
  const events = [
    row("mcp_server_connection", NOW, "p-phantom", "s1"),
    row("user_prompt", NOW, "p-real", "s2"),
    row("api_request", NOW + 1000, "p-real", "s2", { duration_ms: 500 }),
  ];
  const out = summarize(events, [], 3600_000, NOW + 2000);
  expect(out.kpis.prompts).toBe(1);
  expect(out.recentPrompts.map((p) => p.promptId)).toEqual(["p-real"]);
});

test("promptBreakdowns' wallMs matches turnTimeline's: both must include a span's own start, not just event timestamps", () => {
  // user_prompt and api_request logged at the identical timestamp (an export/batching quirk
  // collapses them), with a 180s api_request duration. /api/turn recovers the true 180s from
  // the span; /api/turns must agree instead of reporting wallMs 0.
  const events = [row("user_prompt", NOW, "p-1", "s1"), row("api_request", NOW, "p-1", "s1", { duration_ms: 180_000 })];

  const breakdown = promptBreakdowns(events).get("p-1")!;
  const timeline = turnTimeline(events)!;

  expect(breakdown.startMs).toBe(timeline.startMs);
  expect(breakdown.endMs).toBe(timeline.endMs);
  expect(breakdown.wallMs).toBe(180_000);
});
