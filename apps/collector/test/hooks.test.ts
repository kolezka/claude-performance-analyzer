import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventRow } from "@cpa/otlp";
import { _configCacheSizeForTests, buildHookDefinitions, hookSummary, matcherApplies, splitHookItemName } from "../src/hooks";

const LOCAL = { id: "local", home: "/home/me", mayReadDisk: true };

test("splitHookItemName splits event:matcher, leaving events with no target untouched", () => {
  expect(splitHookItemName("PreToolUse:Bash")).toEqual({ event: "PreToolUse", matcherTarget: "Bash" });
  expect(splitHookItemName("UserPromptSubmit")).toEqual({ event: "UserPromptSubmit", matcherTarget: null });
});

test("matcherApplies: absent, empty and * match everything; otherwise an anchored regex, falling back to string equality", () => {
  expect(matcherApplies(undefined, "Bash")).toBe(true);
  expect(matcherApplies("", "Bash")).toBe(true);
  expect(matcherApplies("*", "Bash")).toBe(true);
  expect(matcherApplies("Bash", "Bash")).toBe(true);
  expect(matcherApplies("Bash|Write", "Write")).toBe(true);
  expect(matcherApplies("Bash", "Bashful")).toBe(false);
  expect(matcherApplies("[", "[")).toBe(true); // invalid regex falls back to string equality
  expect(matcherApplies("[", "other")).toBe(false);
  // An item with no matcher target (e.g. UserPromptSubmit) is never filtered by a matcher.
  expect(matcherApplies("Bash", null)).toBe(true);
});

test("matcherApplies never compiles a nested-quantifier matcher as regex: a catastrophic pattern returns fast", () => {
  const t0 = Bun.nanoseconds();
  // A hook's own matcher is attacker-reachable (a plugin's config, or hook_matcher off the
  // wire); (a+)+ against a run of "a"s is the classic catastrophic-backtracking shape.
  const result = matcherApplies("(a+)+", "a".repeat(28) + "!");
  const ms = (Bun.nanoseconds() - t0) / 1e6;
  expect(ms).toBeLessThan(50);
  expect(result).toBe(false); // falls back to plain string equality, which this is not
});

test("matcherApplies takes the literal-alternation fast path without compiling a regex", () => {
  expect(matcherApplies("Bash|Write|Edit", "Write")).toBe(true);
  expect(matcherApplies("Bash|Write|Edit", "Read")).toBe(false);
});

test("matcherApplies rejects an over-long pattern or target as regex, falling back to string equality", () => {
  const long = "a".repeat(201);
  expect(matcherApplies(long, long)).toBe(true);
  expect(matcherApplies(long, "short")).toBe(false);
});

test("hookSummary: a script path gets its interpreter and basename; otherwise the command, collapsed and capped", () => {
  expect(hookSummary('bun "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" --flag')).toBe("bun guard.sh");
  expect(hookSummary("node /opt/scripts/log-prompt.js")).toBe("node log-prompt.js");
  expect(hookSummary("echo hello world")).toBe("echo hello world");
  const long = "echo " + "x".repeat(100);
  expect(hookSummary(long)).toHaveLength(80);
});

function reg(sessionId: string, attrs: Record<string, unknown>): EventRow {
  return { tsMs: 0, name: "hook_registered", sessionId, promptId: null, attrs };
}

test("buildHookDefinitions resolves plugin, project and local config for the matching event/matcher", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "cc-claude-"));
  const pluginDir = join(claudeDir, "my-plugin");
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  mkdirSync(join(claudeDir, "plugins"), { recursive: true });
  writeFileSync(
    join(claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "my-plugin@my-marketplace": [{ scope: "user", installPath: pluginDir, version: "1.0.0", lastUpdated: "2026-10-01T00:00:00Z" }] } }),
  );
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"' }] }] } }),
  );

  const repoRoot = mkdtempSync(join(tmpdir(), "cc-hook-repo-"));
  mkdirSync(join(repoRoot, ".claude"), { recursive: true });
  writeFileSync(join(repoRoot, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo project-hook", timeout: 15 }] }] } }));
  writeFileSync(join(repoRoot, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo local-hook" }] }] } }));

  const prevDir = process.env.CC_CLAUDE_DIR;
  process.env.CC_CLAUDE_DIR = claudeDir;
  try {
    const registered = [
      reg("s-plugin", { hook_event: "PreToolUse", hook_type: "command", hook_source: "pluginHook", "plugin.name": "my-plugin", hook_matcher: "Bash" }),
      reg("s-project", { hook_event: "PreToolUse", hook_type: "command", hook_source: "projectSettings" }),
      // A different event must never show up for a "PreToolUse:Bash" item.
      reg("s-other", { hook_event: "UserPromptSubmit", hook_type: "command", hook_source: "userSettings" }),
    ];
    const defs = buildHookDefinitions("PreToolUse:Bash", registered, (sessionId) => (sessionId === "s-project" ? repoRoot : null), LOCAL);

    expect(defs.map((d) => d.source)).toEqual(["plugin", "project", "local"]);
    const plugin = defs.find((d) => d.source === "plugin")!;
    expect(plugin).toMatchObject({ plugin: "my-plugin", matcher: "Bash", command: 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"', summary: "bun guard.sh", sessions: 1, timeoutSec: null });
    expect(plugin.configPath).toContain("hooks.json");
    const project = defs.find((d) => d.source === "project")!;
    expect(project).toMatchObject({ command: "echo project-hook", sessions: 1, timeoutSec: 15 });
    const local = defs.find((d) => d.source === "local")!;
    expect(local).toMatchObject({ command: "echo local-hook", sessions: 1 });
  } finally {
    if (prevDir === undefined) delete process.env.CC_CLAUDE_DIR;
    else process.env.CC_CLAUDE_DIR = prevDir;
  }
});

test("the config file cache stays bounded even after reading many distinct project config paths", () => {
  const roots: string[] = [];
  for (let n = 0; n < 260; n++) {
    const root = mkdtempSync(join(tmpdir(), `cc-hook-cap-${n}-`));
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `echo ${n}` }] }] } }));
    roots.push(root);
  }

  for (const root of roots) {
    const registered = [reg("s", { hook_event: "Stop", hook_type: "command", hook_source: "projectSettings" })];
    buildHookDefinitions("Stop", registered, () => root, LOCAL);
  }

  expect(_configCacheSizeForTests()).toBeLessThanOrEqual(200);
});

test("buildHookDefinitions never throws on missing or invalid config, and emits every matching command for a matcher-less registration", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "cc-claude-bad-"));
  writeFileSync(join(claudeDir, "settings.json"), "{ not json");

  const prevDir = process.env.CC_CLAUDE_DIR;
  process.env.CC_CLAUDE_DIR = claudeDir;
  try {
    const registered = [reg("s1", { hook_event: "UserPromptSubmit", hook_type: "command", hook_source: "userSettings" })];
    expect(buildHookDefinitions("UserPromptSubmit", registered, () => null, LOCAL)).toEqual([]);
  } finally {
    if (prevDir === undefined) delete process.env.CC_CLAUDE_DIR;
    else process.env.CC_CLAUDE_DIR = prevDir;
  }
});

test("buildHookDefinitions skips a malformed entry instead of throwing: valid JSON, wrong shape", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "cc-claude-shape-"));
  // Valid JSON, but the PreToolUse array holds a null where an entry object belongs.
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [null, { matcher: "Bash", hooks: [{ type: "command", command: "echo ok" }] }] } }));

  const prevDir = process.env.CC_CLAUDE_DIR;
  process.env.CC_CLAUDE_DIR = claudeDir;
  try {
    const registered = [reg("s1", { hook_event: "PreToolUse", hook_type: "command", hook_source: "userSettings" })];
    const defs = buildHookDefinitions("PreToolUse:Bash", registered, () => null, LOCAL);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ command: "echo ok" });
  } finally {
    if (prevDir === undefined) delete process.env.CC_CLAUDE_DIR;
    else process.env.CC_CLAUDE_DIR = prevDir;
  }
});
