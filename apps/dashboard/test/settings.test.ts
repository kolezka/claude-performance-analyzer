import { expect, test } from "bun:test";
import type { EnvPlan } from "@cpa/claude-settings";
import { applyLabel, bannerText, keyRows, missingImpact, neededFor } from "../src/pages/settings/keys";

const plan = (over: Partial<EnvPlan> = {}): EnvPlan => ({
  path: "/home/u/.claude/settings.json",
  exists: true,
  missing: [],
  present: [],
  conflicts: [],
  error: null,
  ...over,
});

test("keyRows lists set, then conflicts, then missing", () => {
  const rows = keyRows(plan({ missing: ["OTEL_TRACES_EXPORTER"], present: ["CLAUDE_CODE_ENABLE_TELEMETRY"], conflicts: ["OTEL_LOGS_EXPORTER"] }));
  expect(rows.map((r) => [r.key, r.status])).toEqual([
    ["CLAUDE_CODE_ENABLE_TELEMETRY", "set"],
    ["OTEL_LOGS_EXPORTER", "conflict"],
    ["OTEL_TRACES_EXPORTER", "missing"],
  ]);
  expect(rows[2]!.neededFor).toBe("time to first token, waterfall");
});

test("neededFor is empty for unknown keys", () => {
  expect(neededFor("SOMETHING_ELSE")).toBe("");
});

test("applyLabel pluralizes and shows progress", () => {
  expect(applyLabel(1, false)).toBe("Add 1 missing setting");
  expect(applyLabel(3, false)).toBe("Add 3 missing settings");
  expect(applyLabel(3, true)).toBe("Updating...");
});

test("bannerText covers error, missing, conflicts and the all-good case", () => {
  expect(bannerText(plan({ error: "bad json" }))).toBe("Cannot read Claude Code settings");
  expect(bannerText(plan({ missing: ["A", "B"] }))).toBe("2 settings missing in");
  expect(bannerText(plan({ conflicts: ["A"] }))).toBe("1 setting set to another value in");
  expect(bannerText(plan({ present: ["A"] }))).toBeNull();
});

test("missingImpact dedupes what the missing keys unlock", () => {
  expect(missingImpact(plan({ missing: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_LOGS_EXPORTER"] }))).toBe(
    "Missing until added: delivery, events, live feed.",
  );
  expect(missingImpact(plan({ missing: ["UNKNOWN"] }))).toBe("");
});
