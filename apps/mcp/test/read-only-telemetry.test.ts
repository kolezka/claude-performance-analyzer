// The collector owns telemetry.sqlite, so the MCP server may only read it, on every SQLite build.
// Trap: Bun on Linux bundles a SQLite that treats "file:...?mode=ro" as a plain file name unless
// the connection asks for URIs, so every telemetry read failed there while macOS passed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { buildQueryDb } from "../src/query-db";
import { openTelemetry } from "../src/telemetry";
import { hookFiring, SID, T0, tempEnv, writeTelemetry, type TempEnv } from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
  writeTelemetry(env, [hookFiring(SID, T0, "Stop", "Stop", 40)]);
});
afterEach(() => env.restore());

const telemetryFile = () => join(env.telemetryDir, "telemetry.sqlite");

test("telemetry opens for reading, and that connection cannot write to it", () => {
  const t = openTelemetry(telemetryFile());
  expect(t.ok ? null : t.reason).toBeNull();
  if (!t.ok) return;
  try {
    expect(() => t.db.run("DELETE FROM events")).toThrow("readonly");
    expect(t.db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
  } finally {
    t.db.close();
  }
});

test("harness_query attaches telemetry read-only, even with query_only switched off", () => {
  const db = buildQueryDb({ blocks: [], runs: [], sessions: [] }, telemetryFile());
  try {
    db.run("PRAGMA query_only = OFF");
    expect(() => db.run("DELETE FROM tel.events")).toThrow("readonly");
    expect(db.query("SELECT count(*) AS n FROM tel.events").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
