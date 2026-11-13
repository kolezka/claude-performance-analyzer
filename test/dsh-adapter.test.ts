import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const adapter = join(root, "dsh");
const skipped = new Set([".git", "node_modules", "dist", "build", ".codegraph", "graphify-out"]);

// Runs under node so a missing package cannot be fetched by Bun's auto-install.
const probe = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const index = new URL("./index.js", import.meta.url);
let resolved;
try { resolved = createRequire(index).resolve("claude-plugin-dsh/package.json"); }
catch { console.log(JSON.stringify({ error: "dependency-resolution-failed" })); process.exit(4); }
const { default: plugin } = await import(index.href);
let provider;
const sections = [];
plugin.apply({
  inject(services, register) {
    if (services.includes("skills")) register({ skills: { registerProvider(factory) { provider = factory(); } } });
    if (services.includes("systemPrompt")) register({ systemPrompt: { section(s) { sections.push(s.name); } } });
    if (services.includes("commands")) register({ commands: { register() { throw new Error("no commands expected"); } } });
  },
  on() {},
});
const skills = await provider.list();
const skill = await provider.get(skills[0]);
const runtime = JSON.parse((await import("node:fs")).readFileSync(resolved, "utf8"));
console.log(JSON.stringify({ resolved, version: runtime.version, name: plugin.name, names: skills.map((s) => s.name), sections, content: skill.content }));
`;

test("DSH adapter pins the published runtime with no vendored copy", () => {
  const manifest = JSON.parse(readFileSync(join(adapter, "package.json"), "utf8"));
  const pluginVersion = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")).version;
  expect(manifest.version).toBe(pluginVersion);
  expect(manifest.dependencies).toEqual({ "claude-plugin-dsh": "0.2.0" });
  expect(manifest.files).toEqual(["index.js", "bun.lock", "cordis.patch.yml", "locale/*.json"]);
  const index = readFileSync(join(adapter, "index.js"), "utf8");
  expect(index).toContain("import { createPlugin, rootFrom } from 'claude-plugin-dsh'");
  expect(index).toContain("root: rootFrom(import.meta.url)");
  expect(existsSync(join(adapter, "claude-compat.js"))).toBe(false);
  expect(readFileSync(join(adapter, "bun.lock"), "utf8")).toContain(
    "sha512-pzSobglwIh7NuG5Y5W331kVIg5NExU5wnzW3citMKXl57CMmVW255b5zPLDyVA/ERSgUjhrsugBgkEq5p+S1Zw==",
  );
  // The harness MCP server reads Claude Code sessions, so its explicit row stays off by default.
  const patch = readFileSync(join(adapter, "cordis.patch.yml"), "utf8");
  expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
  expect(patch).toMatch(/id: claude-compat-performance-analyzer-mcp\n\s+name: '@deepseek-ai\/dsh-mcp-client'\n\s+disabled: true/);
});

test("standalone adapter install loads the skill from the installed runtime", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "cpa-dsh-")));
  try {
    cpSync(root, fixture, {
      recursive: true,
      filter: (source) => !relative(root, source).split("/").some((part) => skipped.has(part)),
    });
    expect(existsSync(join(fixture, "node_modules"))).toBe(false);
    const dsh = join(fixture, "dsh");
    const install = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: dsh, encoding: "utf8" });
    expect({ code: install.status, stderr: install.stderr }).toEqual({ code: 0, stderr: install.stderr });
    writeFileSync(join(dsh, "probe.mjs"), probe);
    const run = () => spawnSync("node", ["probe.mjs"], { cwd: dsh, encoding: "utf8" });

    const result = run();
    expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const decoded = JSON.parse(result.stdout);
    expect(decoded.resolved).toBe(join(dsh, "node_modules/claude-plugin-dsh/package.json"));
    expect(decoded.version).toBe("0.2.0");
    expect(decoded.name).toBe("claude-compat-performance-analyzer");
    expect(decoded.names).toEqual(["harness-cost"]);
    expect(decoded.sections).toEqual([]);
    expect(decoded.content).toContain(`Plugin root: \`${fixture}\``);
    expect(decoded.content).toContain("# Measuring what the harness costs");
    expect(decoded.content).toContain("harness_summary");

    // Negative control: a broken install must fail at dependency resolution.
    rmSync(join(dsh, "node_modules/claude-plugin-dsh"), { recursive: true, force: true });
    const broken = run();
    expect({ code: broken.status, stdout: JSON.parse(broken.stdout) }).toEqual({
      code: 4,
      stdout: { error: "dependency-resolution-failed" },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 120000);
