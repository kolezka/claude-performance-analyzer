import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

async function initRepo(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  await $`git init -q`.cwd(dir).quiet();
  writeFileSync(join(dir, "file.ts"), "x");
  return dir;
}

function record(tsAgoMs: number, sessionId: string, filePath: string) {
  return {
    timeUnixNano: String((Date.now() - tsAgoMs) * 1e6),
    attributes: [
      { key: "event.name", value: s("tool_result") },
      { key: "session.id", value: s(sessionId) },
      { key: "tool_name", value: s("Read") },
      { key: "duration_ms", value: i(10) },
      { key: "success", value: s("true") },
      { key: "tool_input", value: s(JSON.stringify({ file_path: filePath })) },
    ],
  };
}

let collector: Awaited<ReturnType<typeof startCollector>>;
let repoA: string;
let repoB: string;

beforeAll(async () => {
  repoA = await initRepo("cc-item-a-");
  repoB = await initRepo("cc-item-b-");
  collector = await startCollector();
});
afterAll(() => collector.stop());

test("/api/item attributes each row to the repo its own call touched, not the session's dominant repo", async () => {
  const sessionId = "mixed-repo-sess";
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            // repoA touched first (older), repoB touched second (more recent): the session's
            // own dominant repo (tie broken by recency) would be repoB if this were used for both rows.
            logRecords: [record(2000, sessionId, join(repoA, "file.ts")), record(1000, sessionId, join(repoB, "file.ts"))],
          },
        ],
      },
    ],
  };
  const res = await fetch(`${collector.url}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);

  const item = await (await fetch(`${collector.url}/api/item?kind=tools&name=Read`)).json();
  const rows = item.recent.filter((r: any) => r.sessionId === sessionId);
  expect(rows).toHaveLength(2);
  const byDetail = Object.fromEntries(rows.map((r: any) => [r.detail, r.repo]));
  expect(byDetail[join(repoA, "file.ts")]).toBe(basename(repoA));
  expect(byDetail[join(repoB, "file.ts")]).toBe(basename(repoB));

  const names = item.repos.map((r: any) => r.name).sort();
  expect(names).toEqual([basename(repoA), basename(repoB)].sort());
});
