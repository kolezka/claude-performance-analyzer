import { expect, test } from "bun:test";
import type { TurnTimeline } from "@cpa/analytics";
import type { Palette } from "../src/charts";
import { kindColor, leftMarginFor, waterfallOption, waterfallTitle } from "../src/charts";

const pal: Palette = {
  api: "#2a78d6",
  apiSoft: "#86b6ef",
  tools: "#eb6834",
  hooks: "#1baf7a",
  critical: "#d03b3b",
  muted: "#7d7b76",
  ink: "#0b0b0b",
  ink2: "#52514e",
  grid: "#eee",
  axis: "#ccc",
  surface: "#fff",
  border: "#ddd",
};

const turn: TurnTimeline = {
  promptId: "p1",
  command: "/test",
  startMs: 1000,
  endMs: 5000,
  spans: [
    { kind: "api", label: "claude-sonnet-5", startMs: 1000, endMs: 3000, ok: true },
    { kind: "tool", label: "Bash", startMs: 3000, endMs: 4000, ok: false },
    { kind: "hook", label: "PreToolUse", startMs: 4000, endMs: 4500, ok: true },
  ],
};

test("leftMarginFor grows with the longest name, clamped to [60, 190]", () => {
  expect(leftMarginFor([])).toBe(60);
  expect(leftMarginFor(["a"])).toBe(60);
  expect(leftMarginFor(["abcdefghij"])).toBe(76);
  expect(leftMarginFor(["x".repeat(50)])).toBe(190);
});

test("kindColor maps known kinds to their palette color, others to muted", () => {
  expect(kindColor(pal, "api")).toBe(pal.api);
  expect(kindColor(pal, "tool")).toBe(pal.tools);
  expect(kindColor(pal, "hook")).toBe(pal.hooks);
  expect(kindColor(pal, "agent")).toBe(pal.muted);
  expect(kindColor(pal, "compaction")).toBe(pal.muted);
});

test("waterfallOption emits one span per row with kind colors and a critical border on failure", () => {
  const opt = waterfallOption(pal, turn);
  const data = opt.series[0].data;
  expect(data).toHaveLength(3);
  expect(opt.yAxis.data).toHaveLength(3);
  expect(data[0].itemStyle.color).toBe(pal.api);
  expect(data[0].itemStyle.borderColor).toBe("transparent");
  expect(data[1].itemStyle.color).toBe(pal.tools);
  expect(data[1].itemStyle.borderColor).toBe(pal.critical);
  expect(data[2].itemStyle.color).toBe(pal.hooks);
});

test("waterfallOption hides the slider dataZoom under the visible-row threshold", () => {
  expect(waterfallOption(pal, turn).dataZoom).toEqual([]);
});

test("waterfallTitle joins start time, command and total duration", () => {
  const title = waterfallTitle(turn);
  expect(title).toContain("/test");
  expect(title).toContain("4.0s total");
});
