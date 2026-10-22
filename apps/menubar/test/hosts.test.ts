import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compiles the app's real Swift sources (minus the App entry point) with the executable
// harness in Tests/, runs it, and requires every named check to pass. macOS only: the app
// links SwiftUI, Charts and ServiceManagement.

const appRoot = join(import.meta.dir, "..");

async function swiftFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".swift"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

test.skipIf(process.platform !== "darwin")(
  "Swift host selection harness passes against the production sources",
  async () => {
    const sources = (await swiftFiles(join(appRoot, "Sources"))).filter((f) => !f.endsWith("/ClaudeTelemetryApp.swift"));
    expect(sources.length).toBeGreaterThan(20);
    const harness = join(appRoot, "Tests", "TelemetryHostsTests.swift");
    const dir = await mkdtemp(join(tmpdir(), "cpa-menubar-tests-"));
    try {
      const binary = join(dir, "TelemetryHostsTests");
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

      // Test preference suites are written here and removed with the rest of the temp dir.
      const run = Bun.spawnSync([binary], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
        env: { ...process.env, CPA_TEST_PREFS_DIR: join(dir, "prefs") },
      });
      const output = run.stdout.toString() + run.stderr.toString();
      console.log(output);
      const passed = [...output.matchAll(/^PASS (.+)$/gm)].map((m) => m[1]);
      const failed = [...output.matchAll(/^FAIL (.+)$/gm)].map((m) => m[1]);
      expect(failed).toEqual([]);
      // Every check the harness declares must pass, and this list must name each one, so a
      // deleted, skipped or newly added but unlisted check fails here instead of passing quietly.
      const declared = [...(await Bun.file(harness).text()).matchAll(/h\.run\("([^"]+)"/g)].map((m) => m[1]);
      const required = [
        "isolated defaults stay out of the user's preferences",
        "local host is first and the default selection",
        "every telemetry request carries the encoded host",
        "local requests say host=local",
        "management writes send JSON, Origin and encoded ids",
        "origin keeps a non-default port and drops the path",
        "credentials decode, refresh the list and never persist",
        "management errors surface the collector message",
        "selection persists across launches",
        "a missing saved host falls back to local after a good list",
        "no fallback when the host list fails",
        "a slow host A cannot overwrite host B after switching",
        "delayed failures from host A do not mark host B as failed",
        "collector URL change with the same host id drops the old response",
        "collector URL change with a missing host falls back after the new list",
        "staged late status after host switch cannot revert state",
        "staged late summary after host switch cannot revert state",
        "staged late live after host switch cannot revert state",
        "staged late turns after host switch cannot revert state",
        "staged late pinned turn after host switch cannot revert state",
        "staged late status after same-id collector change cannot revert state",
        "staged late summary after same-id collector change cannot revert state",
        "staged late live after same-id collector change cannot revert state",
        "staged late turns after same-id collector change cannot revert state",
        "staged late pinned turn after same-id collector change cannot revert state",
        "an older host list cannot override a newer one",
        "an old collector's host list cannot apply after a collector change",
        "removing the selected host selects local",
        "a late remove on the old collector does not reset the new selection",
        "reset all selects local and bumps the generation",
        "dashboard URL carries the selected host",
        "remote paths stay verbatim, local paths shorten",
        "menu bar label names a remote host and keeps local unchanged",
        "remote hook definitions decode event and source without command",
        "host actions reveal credentials and errors for the current tab",
        "a late host action after the tab closed reveals nothing",
        "an old host action cannot clear a newer action's busy state",
        "a host action from before a collector A-B-A change reveals nothing",
      ];
      expect(new Set(declared).size).toBe(declared.length);
      expect([...declared].sort()).toEqual([...required].sort());
      expect([...passed].sort()).toEqual([...required].sort());
      expect(output).toMatch(new RegExp(`SUMMARY passed=${required.length} failed=0`));
      expect(run.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  600_000,
);
