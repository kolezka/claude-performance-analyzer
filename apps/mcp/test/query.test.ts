import { afterEach, beforeEach, expect, test } from "bun:test";
import { gather } from "../src/gather";
import { buildQueryDb, checkSql, runQuery } from "../src/query";
import { hookFiring, SID, sessionTranscript, T0, tempEnv, writeTelemetry, writeTranscript, type TempEnv } from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
  writeTranscript(env, "-work-demo", SID, sessionTranscript());
  writeTelemetry(env, [hookFiring(SID, T0, "Stop", "Stop", 40)]);
});
afterEach(() => env.restore());

const current = { CLAUDE_CODE_SESSION_ID: SID };

test("checkSql allows one SELECT or WITH and nothing else", () => {
  expect(checkSql("select 1;")).toBe("select 1");
  expect(checkSql("WITH x AS (SELECT 1) SELECT * FROM x")).toContain("WITH");
  expect(() => checkSql("DELETE FROM blocks")).toThrow("Only SELECT");
  expect(() => checkSql("SELECT 1; DELETE FROM blocks")).toThrow("One statement");
});

test("queries see transcript tables and read-only telemetry", async () => {
  const db = buildQueryDb(await gather({}, current));
  try {
    expect(runQuery(db, "SELECT count(*) AS n FROM blocks")).toBe("n\n6");
    expect(runQuery(db, "SELECT family, count(*) AS n FROM blocks GROUP BY family ORDER BY family")).toBe("family | n\n | 2\nhindsight | 4");
    expect(runQuery(db, "SELECT sum(repeat) AS r FROM blocks")).toBe("r\n1");
    expect(runQuery(db, "SELECT count(*) AS n FROM tel.events")).toBe("n\n1");
    expect(runQuery(db, "SELECT prompts FROM sessions")).toBe("prompts\n2");
  } finally {
    db.close();
  }
});

test("the query connection cannot write, even past the SQL check", async () => {
  const db = buildQueryDb(await gather({}, current));
  try {
    expect(() => db.run("INSERT INTO blocks (chars) VALUES (1)")).toThrow();
    expect(() => db.run("DELETE FROM tel.events")).toThrow();
    expect(runQuery(db, "SELECT count(*) AS n FROM tel.events")).toBe("n\n1");
  } finally {
    db.close();
  }
});

test("large results stop at the row cap", async () => {
  const db = buildQueryDb(await gather({}, current));
  try {
    const text = runQuery(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) SELECT i FROM n");
    expect(text.split("\n")).toHaveLength(102);
    expect(text).toContain("stopped at 100 rows");
  } finally {
    db.close();
  }
});
