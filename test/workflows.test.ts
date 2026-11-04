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

// Also matches options before the subcommand, as in `git -C "$TAP" push`.
const gitPush = /\bgit(?:\s+-[Cc]\s+\S+)*\s+push\b/;

function earliest(offsets: number[]): number {
  const found = offsets.filter((offset) => offset >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

// Where a run block first pushes, directly or through a repo script it calls. -1 if it never does.
async function firstPushOffset(run: string): Promise<number> {
  const offsets = [run.search(gitPush)];
  for (const match of run.matchAll(/[\w./-]+\.sh\b/g)) {
    const script = Bun.file(join(repoRoot, match[0]));
    if ((await script.exists()) && gitPush.test(await script.text())) offsets.push(match.index);
  }
  return earliest(offsets);
}

// Where a step first gives git its own credentials: gh's helper with a token, or an SSH deploy key.
function firstAuthOffset(step: Step): number {
  const run = step.run ?? "";
  const hasToken = step.env !== undefined && "GH_TOKEN" in step.env;
  return earliest([hasToken ? run.indexOf("gh auth setup-git") : -1, run.search(/\bGIT_SSH_COMMAND=["']?ssh\b[^\n]*\s-i\s/)]);
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
    const authAt = firstAuthOffset(step);
    if (authAt < 0 || authAt > pushAt) unauthenticated.push(label);
  }
  expect(unauthenticated).toEqual([]);
});
