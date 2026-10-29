import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compiles the app's real Swift sources (minus the App entry point) with the panel layout
// harness in Tests/, which renders the production PanelHeader offscreen and checks that it fits
// the panel. macOS only: the app links SwiftUI, Charts and ServiceManagement.

const appRoot = join(import.meta.dir, "..");

async function swiftFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".swift"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

test.skipIf(process.platform !== "darwin")(
  "panel header fits the panel at every width",
  async () => {
    const sources = (await swiftFiles(join(appRoot, "Sources"))).filter((f) => !f.endsWith("/ClaudeTelemetryApp.swift"));
    expect(sources.length).toBeGreaterThan(20);
    const harness = join(appRoot, "Tests", "PanelLayoutTests.swift");
    const dir = await mkdtemp(join(tmpdir(), "cpa-menubar-layout-"));
    try {
      const binary = join(dir, "PanelLayoutTests");
      const arch = process.arch === "arm64" ? "arm64" : "x86_64";
      const compile = Bun.spawnSync(
        [
          "swiftc", "-parse-as-library", "-Onone",
          "-target", `${arch}-apple-macos14`,
          "-module-cache-path", join(dir, "module-cache"),
          "-framework", "SwiftUI", "-framework", "Charts", "-framework", "ServiceManagement",
          ...sources, harness, "-o", binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const compileOutput = compile.stdout.toString() + compile.stderr.toString();
      if (compile.exitCode !== 0) console.error(compileOutput);
      expect(compile.exitCode).toBe(0);

      const run = Bun.spawnSync([binary], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        env: { ...process.env, CPA_TEST_PREFS_DIR: join(dir, "prefs") },
      });
      const output = run.stdout.toString() + run.stderr.toString();
      console.log(output);
      const passed = [...output.matchAll(/^PASS (.+)$/gm)].map((m) => m[1]);
      const failed = [...output.matchAll(/^FAIL (.+)$/gm)].map((m) => m[1]);
      expect(failed).toEqual([]);
      // Every declared check must pass and be listed here, so none can drop out quietly.
      const declared = [...(await Bun.file(harness).text()).matchAll(/h\.run\("([^"]+)"/g)].map((m) => m[1]);
      const required = [
        "probe reports a fixed-size child wider than the panel",
        "scroll probe detects genuine overflow",
        "panel refresh does not enable a scrollbar when content fits",
        "overflowing panel remains scrollable across refresh",
        "long host name has 80 characters",
        "local-only header fits every panel width with every window enabled",
        "remote host header fits every panel width with every window enabled",
      ];
      expect(declared.sort()).toEqual([...required].sort());
      expect(passed.sort()).toEqual([...required].sort());
      expect(run.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
