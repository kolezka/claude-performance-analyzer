import { expect, test } from "bun:test";
import { MAX_LIMIT, NO_REPO, canLoadMore, filterByRepo, limitFor, nextLimit, repoOptions, shares, sortFrom, turnLabel } from "../src/pages/turns/logic";

test("sortFrom defaults to recent and accepts only slowest otherwise", () => {
  expect(sortFrom({})).toBe("recent");
  expect(sortFrom({ sort: "slowest" })).toBe("slowest");
  expect(sortFrom({ sort: "bogus" })).toBe("recent");
});

test("limitFor clamps to the API range and asks for the maximum when filtering by repo", () => {
  expect(limitFor(20, null)).toBe(20);
  expect(limitFor(0, null)).toBe(1);
  expect(limitFor(500, null)).toBe(MAX_LIMIT);
  expect(limitFor(20, "cpa")).toBe(MAX_LIMIT);
});

test("nextLimit steps up and stops at the API cap", () => {
  expect(nextLimit(20)).toBe(40);
  expect(nextLimit(40)).toBe(MAX_LIMIT);
  expect(nextLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
});

test("canLoadMore only while the server filled the page and the cap is not reached", () => {
  expect(canLoadMore(20, 20, null)).toBe(true);
  expect(canLoadMore(20, 12, null)).toBe(false);
  expect(canLoadMore(MAX_LIMIT, MAX_LIMIT, null)).toBe(false);
  expect(canLoadMore(20, 20, "cpa")).toBe(false);
});

test("repo filter and options treat a missing repo as its own bucket, sorted last", () => {
  const turns = [{ repo: "zeta" }, { repo: null }, { repo: "alpha" }, { repo: "zeta" }];
  expect(repoOptions(turns, null)).toEqual(["alpha", "zeta", NO_REPO]);
  expect(repoOptions(turns, "gone")).toEqual(["alpha", "gone", "zeta", NO_REPO]);
  expect(filterByRepo(turns, "zeta")).toHaveLength(2);
  expect(filterByRepo(turns, NO_REPO)).toEqual([{ repo: null }]);
  expect(filterByRepo(turns, null)).toBe(turns);
});

test("shares split api/tools/hooks by their own sum and flag unmeasured turns", () => {
  expect(shares({ apiMs: 50, toolMs: 25, hookMs: 25 })).toEqual({ api: 50, tools: 25, hooks: 25, empty: false });
  expect(shares({ apiMs: 0, toolMs: 0, hookMs: 0 }).empty).toBe(true);
});

test("turnLabel shows the command or a plain prompt", () => {
  expect(turnLabel({ command: "/compact" })).toBe("/compact");
  expect(turnLabel({ command: null })).toBe("prompt");
});
