import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function record(name: string, tsAgoMs: number, sessionId: string, promptId: string, attrs: Record<string, any>) {
  return {
    timeUnixNano: String((Date.now() - tsAgoMs) * 1e6),
    attributes: [
      { key: "event.name", value: s(name) },
      { key: "session.id", value: s(sessionId) },
      { key: "prompt.id", value: s(promptId) },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value })),
    ],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
let mainRepo: string;
let worktree: string;

beforeAll(async () => {
  collector = await startCollector();
  mainRepo = realpathSync(mkdtempSync(join(tmpdir(), "cc-folder-main-")));
  await $`git init -q`.cwd(mainRepo).quiet();
  await $`git -c user.email=a@b.c -c user.name=a commit --allow-empty -q -m init`.cwd(mainRepo).quiet();
  worktree = join(realpathSync(tmpdir()), `cc-folder-wt-${Date.now()}`);
  await $`git worktree add -q ${worktree} -b feat/folder`.cwd(mainRepo).quiet();
  writeFileSync(join(worktree, "file.ts"), "x");
});
afterAll(() => collector.stop());

test("/api/item recent[]/failed[] carry folder (worktree path, untildeized outside $HOME) and worktree: true", async () => {
  const sessionId = "folder-sess";
  const filePath = join(worktree, "file.ts");
  const body = {
    resourceLogs: [
      { scopeLogs: [ { logRecords: [ record("tool_result", 1000, sessionId, "p-folder-1", { tool_name: s("Read"), duration_ms: i(10), success: s("true"), tool_input: s(JSON.stringify({ file_path: filePath })) }) ] } ] },
    ],
  };
  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const item = await (await fetch(`${collector.url}/api/item?kind=tools&name=Read`)).json();
  const row = item.recent.find((r: any) => r.sessionId === sessionId);
  expect(row).toBeDefined();
  expect(row.folder).toBe(worktree);
  expect(row.worktree).toBe(true);
  expect(row.repo).toBe(basename(mainRepo));
});

test("/api/turns entries carry folder for the session's dominant repo", async () => {
  const sessionId = "folder-turn-sess";
  const promptId = "p-folder-turn-1";
  const filePath = join(worktree, "file.ts");
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("user_prompt", 5000, sessionId, promptId, { command_name: s("test") }),
              record("tool_result", 4000, sessionId, promptId, { tool_name: s("Read"), duration_ms: i(10), success: s("true"), tool_input: s(JSON.stringify({ file_path: filePath })) }),
            ],
          },
        ],
      },
    ],
  };
  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const turns = (await (await fetch(`${collector.url}/api/turns?minutes=1440`)).json()) as any[];
  const turn = turns.find((t) => t.promptId === promptId)!;
  expect(turn).toBeDefined();
  expect(turn.folder).toBe(worktree);
});
