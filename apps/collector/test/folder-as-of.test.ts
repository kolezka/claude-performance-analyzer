import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

function record(name: string, tsAgoMs: number, sessionId: string, promptId: string, attrs: Record<string, any> = {}) {
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
let repoA: string;
let repoB: string;

beforeAll(async () => {
  collector = await startCollector();
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "cc-asof-a-")));
  await $`git init -q`.cwd(repoA).quiet();
  writeFileSync(join(repoA, "file.ts"), "x");
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "cc-asof-b-")));
  await $`git init -q`.cwd(repoB).quiet();
  writeFileSync(join(repoB, "file.ts"), "x");
});
afterAll(() => collector.stop());

test("a hook call's folder reflects the repo as of its own time, not the session's all-time dominant repo", async () => {
  const sessionId = "asof-sess";
  // repoA gets 3 touches (the all-time dominant repo by count), then the session moves to
  // repoB with a single, more recent touch, then a hook fires with no path of its own.
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("tool_result", 9000, sessionId, "p-old-1", { tool_name: s("Read"), duration_ms: i(5), success: s("true"), tool_input: s(JSON.stringify({ file_path: join(repoA, "file.ts") })) }),
              record("tool_result", 8000, sessionId, "p-old-1", { tool_name: s("Read"), duration_ms: i(5), success: s("true"), tool_input: s(JSON.stringify({ file_path: join(repoA, "file.ts") })) }),
              record("tool_result", 7000, sessionId, "p-old-1", { tool_name: s("Read"), duration_ms: i(5), success: s("true"), tool_input: s(JSON.stringify({ file_path: join(repoA, "file.ts") })) }),
              record("tool_result", 3000, sessionId, "p-new-1", { tool_name: s("Read"), duration_ms: i(5), success: s("true"), tool_input: s(JSON.stringify({ file_path: join(repoB, "file.ts") })) }),
              record("hook_execution_complete", 1000, sessionId, "p-new-1", { hook_name: s("Stop"), hook_event: s("Stop"), total_duration_ms: i(5), num_hooks: i(1) }),
            ],
          },
        ],
      },
    ],
  };
  const res = await fetch(`${collector.url}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);

  const item = await (await fetch(`${collector.url}/api/item?kind=hooks&name=Stop&minutes=1440`)).json();
  const hookRow = item.recent.find((r: any) => r.sessionId === sessionId);
  expect(hookRow).toBeDefined();

  // The session's all-time dominant repo is still repoA (3 touches beats 1): confirms this test
  // actually exercises the fix, not a case where both numbers would coincidentally agree.
  const eventDetail = await (await fetch(`${collector.url}/api/event?id=${hookRow.id}`)).json();
  expect(eventDetail.session.repo.name).toBe(basename(repoA));

  // But the hook's own folder is "as of" its call, which lands after the move to repoB.
  expect(hookRow.folder).toBe(repoB);
  expect(hookRow.worktree).toBe(false);
});
