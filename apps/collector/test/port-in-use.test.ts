import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bundled collector runs under launchd. If another collector holds the port, it must take
// over once that one stops, instead of exiting for good or crash-looping.
test("waits for a taken port and serves once it is free", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
  const port = holder.port;
  const dir = mkdtempSync(join(tmpdir(), "cc-collector-"));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, PORT: String(port), CC_TELEMETRY_DIR: dir, NODE_ENV: "production", CC_WAIT_FOR_PORT: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await Bun.sleep(1500);
    expect(proc.exitCode).toBeNull();
    holder.stop(true);
    let live = false;
    for (let i = 0; i < 50 && !live; i++) {
      await Bun.sleep(100);
      live = await fetch(`http://127.0.0.1:${port}/api/live`).then((r) => r.ok, () => false);
    }
    expect(live).toBe(true);
  } finally {
    holder.stop(true);
    proc.kill();
  }
});
