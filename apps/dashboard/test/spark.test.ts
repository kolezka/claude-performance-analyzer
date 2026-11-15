import { expect, test } from "bun:test";
import { sparkPath } from "../src/spark";

test("needs two points to draw", () => {
  expect(sparkPath([], 80, 24)).toBe("");
  expect(sparkPath([5, null], 80, 24)).toBe("");
});

test("gaps start a new segment instead of dropping to zero", () => {
  const d = sparkPath([1, 2, null, 3, 4], 80, 24);
  expect(d.match(/M/g)?.length).toBe(2);
  expect(d).not.toContain("NaN");
});

test("highest value sits at the top padding, lowest at the bottom", () => {
  expect(sparkPath([0, 10], 80, 24)).toBe("M0.0 22.0 L80.0 2.0");
});
