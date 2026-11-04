import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

// The release jobs hold contents: write and signing secrets, so every step that runs
// after checkout (bun install, builds, tests) must not be able to reach a git token.

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };
type LabeledStep = { label: string; step: Step };

const repoRoot = join(import.meta.dir, "..");
const workflowFiles = [...new Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: repoRoot, dot: true })].sort();

const steps: LabeledStep[] = [];
for (const file of workflowFiles) {
  const workflow = Bun.YAML.parse(await Bun.file(join(repoRoot, file)).text()) as Workflow;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    (job.steps ?? []).forEach((step, index) => {
      steps.push({ label: `${file} ${jobName} step ${index + 1} (${step.name ?? step.uses ?? "run"})`, step });
    });
  }
}

// Where a run block first pushes, directly or through a repo script it calls. -1 if it never does.
async function firstPushOffset(run: string): Promise<number> {
  const offsets = [run.indexOf("git push")];
  for (const match of run.matchAll(/[\w./-]+\.sh\b/g)) {
    const script = Bun.file(join(repoRoot, match[0]));
    if ((await script.exists()) && (await script.text()).includes("git push")) offsets.push(match.index);
  }
  const found = offsets.filter((offset) => offset >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

test("finds the workflows and their steps", () => {
  expect(workflowFiles.length).toBeGreaterThan(0);
  expect(steps.some(({ step }) => step.uses?.startsWith("actions/checkout@"))).toBe(true);
});

test("every external action is pinned to a full commit SHA", () => {
  const unpinned = steps
    .filter(({ step }) => step.uses && !step.uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(step.uses))
    .map(({ label, step }) => `${label}: ${step.uses}`);
  expect(unpinned).toEqual([]);
});

test("checkout never leaves the token in the git config", () => {
  const persisting = steps
    .filter(({ step }) => step.uses?.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false)
    .map(({ label }) => label);
  expect(persisting).toEqual([]);
});

test("a step that pushes authenticates git itself, before the push", async () => {
  const unauthenticated: string[] = [];
  for (const { label, step } of steps) {
    if (!step.run) continue;
    const pushAt = await firstPushOffset(step.run);
    if (pushAt < 0) continue;
    const authAt = step.run.indexOf("gh auth setup-git");
    const hasToken = step.env !== undefined && "GH_TOKEN" in step.env;
    if (authAt < 0 || authAt > pushAt || !hasToken) unauthenticated.push(label);
  }
  expect(unauthenticated).toEqual([]);
});
