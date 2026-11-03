// The plugin's harness-cost skill names tools, parameters and SQL that belong to this server.
// These tests fail when the server changes under the skill, so agents never get stale advice.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { gather } from "../src/gather";
import { queryRows } from "../src/query";
import { buildQueryDb, runQuery } from "../src/query-db";
import { telemetryPath } from "../src/telemetry";
import { harnessTools } from "../src/tools";
import { hookFiring, SID, sessionTranscript, T0, tempEnv, writeTelemetry, writeTranscript, type TempEnv } from "./fixtures";

const SKILL_DIR = join(import.meta.dir, "..", "..", "..", "skills", "harness-cost");
const skill = await Bun.file(join(SKILL_DIR, "SKILL.md")).text();
const recipes = await Bun.file(join(SKILL_DIR, "queries.md")).text();
const tools = harnessTools({});

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

test("skill frontmatter names it and says when to use it", () => {
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  expect(front).toContain("name: harness-cost\n");
  expect(front).toMatch(/^description: Use when /m);
  expect(front.length).toBeLessThanOrEqual(1024);
});

test("skill covers every tool and names only real tools and parameters", () => {
  const mentioned = backticked(skill);
  for (const t of tools) expect(mentioned).toContain(t.name);
  const real = new Set<string>(tools.map((t) => t.name));
  for (const t of tools) for (const p of Object.keys((t.inputSchema as any).properties ?? {})) real.add(p);
  const snakeNames = backticked(skill).filter((s) => /^[a-z]+(_[a-z]+)+$/.test(s));
  expect(snakeNames.length).toBeGreaterThan(0);
  for (const name of snakeNames) expect(real).toContain(name);
});

test("skill lists exactly the group_by values injected_context accepts", () => {
  const schema = tools.find((t) => t.name === "injected_context")!.inputSchema as any;
  const accepted: string[] = schema.properties.group_by.enum;
  const line = skill.split("\n").find((l) => l.includes("`group_by`"))!;
  const listed = backticked(line.slice(line.indexOf("`group_by`") + "`group_by`".length)).filter((s) => /^[a-z]+$/.test(s));
  expect(listed.sort()).toEqual([...accepted].sort());
});

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  writeTelemetry(env, [hookFiring(SID, T0, "UserPromptSubmit", "UserPromptSubmit", 1200)]);
});
afterEach(() => env.restore());

test("every SQL recipe in queries.md runs against the query schema", async () => {
  const sql = [...recipes.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  expect(sql.length).toBeGreaterThanOrEqual(4);
  const db = buildQueryDb(queryRows(await gather({}, { CLAUDE_CODE_SESSION_ID: SID })), telemetryPath());
  try {
    for (const q of sql) {
      let out = "";
      expect(() => (out = runQuery(db, q))).not.toThrow();
      expect(out.length).toBeGreaterThan(0);
    }
  } finally {
    db.close();
  }
});
