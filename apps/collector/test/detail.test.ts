import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startCollector } from "./server";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });

let collector: Awaited<ReturnType<typeof startCollector>>;
let repoDir: string;

beforeAll(async () => {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), "cc-detail-repo-")));
  await $`git init -q`.cwd(repoDir).quiet();
  writeFileSync(join(repoDir, "file.ts"), "export const x = 1;\n");
  collector = await startCollector();
});
afterAll(() => collector.stop());

test("/api/event and /api/item surface the repo a session's tool calls touched", async () => {
  const filePath = join(repoDir, "file.ts");
  const sessionId = "detail-sess-1";
  const body = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1e6),
                attributes: [
                  { key: "event.name", value: s("tool_result") },
                  { key: "session.id", value: s(sessionId) },
                  { key: "prompt.id", value: s("p-1") },
                  { key: "tool_name", value: s("Read") },
                  { key: "duration_ms", value: i(42) },
                  { key: "success", value: s("true") },
                  { key: "tool_input", value: s(JSON.stringify({ file_path: filePath })) },
                ],
              },
            ],
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

  const live = await (await fetch(`${collector.url}/api/live`)).json();
  const row = live.find((e: any) => e.sessionId === sessionId);
  expect(row).toBeDefined();
  expect(typeof row.id).toBe("number");

  const event = await (await fetch(`${collector.url}/api/event?id=${row.id}`)).json();
  expect(event.kind).toBe("tool");
  expect(event.label).toBe("Read");
  expect(event.sessionId).toBe(sessionId);
  expect(event.details.some((d: any) => d.key === "Command or File" && d.value === filePath)).toBe(true);
  expect(event.session).not.toBeNull();
  expect(event.session.repo.name).toBe(basename(repoDir));
  expect(event.session.repo.root).toBe(repoDir);
  expect(event.session.pathsSeen).toBe(1);

  const missing = await fetch(`${collector.url}/api/event?id=999999`);
  expect(missing.status).toBe(404);

  const item = await (await fetch(`${collector.url}/api/item?kind=tools&name=Read`)).json();
  expect(item.kind).toBe("tools");
  expect(item.name).toBe("Read");
  expect(item.count).toBeGreaterThanOrEqual(1);
  expect(item.repos.some((r: any) => r.name === basename(repoDir) && r.root === repoDir)).toBe(true);
  expect(item.recent.length).toBeGreaterThanOrEqual(1);
  const recentRow = item.recent.find((r: any) => r.sessionId === sessionId);
  expect(recentRow).toMatchObject({ ok: true, repo: basename(repoDir), detail: filePath });
  expect(typeof recentRow.id).toBe("number");

  const badKind = await fetch(`${collector.url}/api/item?kind=bogus&name=x`);
  expect(badKind.status).toBe(400);
});
