import { expect, test } from "bun:test";
import { branchAsOf, repoAsOf, type SessionInfo } from "../src/sessions";

const repoA = { name: "a", root: "/repos/a", worktree: null };
const repoB = { name: "b", root: "/repos/b", worktree: null };

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "s",
    repo: repoA,
    pathsSeen: 0,
    otherRepos: [],
    branch: "main",
    terminal: null,
    claudeVersion: null,
    launcher: null,
    models: [],
    firstMs: 0,
    lastMs: 0,
    prompts: 0,
    costUsd: 0,
    kind: "interactive",
    kindLabel: "Interactive",
    repoTimeline: [],
    branchTimeline: [],
    pathTimeline: [],
    ...overrides,
  };
}

test("repoAsOf returns the latest sample at or before the given time, not the all-time dominant repo", () => {
  const info = sessionInfo({
    repo: repoA, // all-time dominant: repoA has more touches overall
    repoTimeline: [
      { tsMs: 1000, promptId: "p1", repo: repoA },
      { tsMs: 1100, promptId: "p1", repo: repoA },
      { tsMs: 1200, promptId: "p1", repo: repoA },
      { tsMs: 5000, promptId: "p2", repo: repoB }, // the session moved on
    ],
  });
  expect(repoAsOf(info, 6000, "p2")).toBe(repoB); // a later call resolves to where the session is now
  expect(repoAsOf(info, 1150, "p1")).toBe(repoA); // a call mid-way through the earlier repo's work
});

test("repoAsOf falls back to the first sample after it in the same prompt, then to the session-wide dominant repo", () => {
  const info = sessionInfo({
    repo: repoA,
    repoTimeline: [
      { tsMs: 5000, promptId: "p1", repo: repoB },
      { tsMs: 9000, promptId: "p2", repo: repoA },
    ],
  });
  expect(repoAsOf(info, 0, "p1")).toBe(repoB); // nothing precedes it, but p1 later touches repoB
  expect(repoAsOf(info, 0, "p-none")).toBe(repoA); // nothing precedes or follows in this prompt
});

test("branchAsOf follows the same at-or-before rule", () => {
  const info = sessionInfo({
    branch: "main",
    branchTimeline: [
      { tsMs: 1000, promptId: "p1", branch: "feat/old" },
      { tsMs: 5000, promptId: "p2", branch: "feat/new" },
    ],
  });
  expect(branchAsOf(info, 6000, "p2")).toBe("feat/new");
  expect(branchAsOf(info, 1500, "p1")).toBe("feat/old");
});
