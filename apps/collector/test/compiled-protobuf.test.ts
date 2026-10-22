import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestType } from "@cpa/otlp";
import { freePort, otlpProtobuf } from "./server";

// The shipped collector is a standalone macOS binary with no source tree beside it. Protobuf
// schemas must be inside it: run from an empty cwd so nothing on disk can stand in for them.
const SIGNALS = ["logs", "traces", "metrics"] as const;
const TABLE = { logs: "events", traces: "spans", metrics: "metrics" } as const;

describe.skipIf(process.platform !== "darwin")("compiled collector", () => {
  let work = "";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let base = "";
  let dataDir = "";

  beforeAll(async () => {
    // Everything this suite creates lives under one owned temp dir, removed in afterAll.
    work = mkdtempSync(join(tmpdir(), "cc-compiled-"));
    const bin = join(work, "collector");
    const build = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/compile.ts"), `bun-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`, bin], { stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`compile failed: ${build.stderr.toString()}`);
    const port = freePort();
    dataDir = join(work, "data");
    const cwd = join(work, "empty-cwd");
    mkdirSync(cwd);
    proc = Bun.spawn([bin], {
      cwd,
      env: { PORT: String(port), CC_TELEMETRY_DIR: dataDir, CC_SETTINGS_PATH: join(work, "settings.json"), CC_CLAUDE_DIR: join(work, "claude") },
      stdout: "ignore",
      stderr: "pipe",
    });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/live`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(100);
    }
    throw new Error("compiled collector did not start");
  }, 120_000);

  afterAll(async () => {
    if (proc) {
      proc.kill();
      // The binary must be gone before its files are removed.
      await proc.exited;
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test("decodes and stores http/protobuf for every signal", async () => {
    for (const signal of SIGNALS) {
      const res = await fetch(`${base}/v1/${signal}`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: otlpProtobuf(signal, `s-${signal}`, `pb-marker-${signal}`, requestType) as unknown as BodyInit,
      });
      expect([signal, res.status, res.status === 200 ? "" : await res.text()]).toEqual([signal, 200, ""]);
    }
    const db = new Database(join(dataDir, "telemetry.sqlite"), { readonly: true });
    try {
      for (const signal of SIGNALS) {
        const rows = db.query(`SELECT host_id, session_id, attrs FROM ${TABLE[signal]}`).all() as { host_id: string; session_id: string; attrs: string }[];
        expect([signal, rows.map((r) => [r.host_id, r.session_id, JSON.parse(r.attrs).marker])]).toEqual([signal, [["local", `s-${signal}`, `pb-marker-${signal}`]]]);
      }
    } finally {
      db.close();
    }
    // The decoded tool call also reaches the API with its duration intact.
    const live = (await (await fetch(`${base}/api/live`)).json()) as { ms: number; sessionId: string }[];
    expect(live).toEqual([expect.objectContaining({ ms: 7, sessionId: "s-logs" })]);
  }, 60_000);
});
