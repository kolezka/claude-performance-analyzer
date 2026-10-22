import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as settings from "@cpa/claude-settings";
import type { EventRow } from "@cpa/otlp";
import { openStore } from "../src/db";
import { buildHookDefinitions } from "../src/hooks";
import { hostContext } from "../src/hosts";
import { createHandler } from "../src/http";
import * as repos from "../src/repos";
import { buildSessionInfo, pathAsOf } from "../src/sessions";

const PORT = 4318;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let root: string;
let repo: string;
let claudeDir: string;
let prevClaudeDir: string | undefined;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-enrich-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", repo]);
  if (init.exitCode !== 0) throw new Error("git init failed");
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash project-hook.sh" }] }] } }));

  claudeDir = join(root, "claude");
  mkdirSync(join(claudeDir, "plugins"), { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /opt/user-hook.js" }] }] } }));
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 plug.py" }] }] } }));
  writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "myplug@market": [{ installPath: plugin, lastUpdated: "2026-10-01T00:00:00Z" }] } }));
  prevClaudeDir = process.env.CC_CLAUDE_DIR;
  process.env.CC_CLAUDE_DIR = claudeDir;
});
afterAll(() => {
  if (prevClaudeDir === undefined) delete process.env.CC_CLAUDE_DIR;
  else process.env.CC_CLAUDE_DIR = prevClaudeDir;
});

function telemetry(now: number): EventRow[] {
  const reg = (source: string, plugin?: string): EventRow => ({
    tsMs: now - 6000,
    name: "hook_registered",
    sessionId: "S",
    promptId: null,
    attrs: { hook_event: "PreToolUse", hook_source: source, hook_matcher: "Bash", ...(plugin ? { "plugin.name": plugin } : {}) },
  });
  return [
    reg("pluginHook", "myplug"),
    reg("userSettings"),
    reg("projectSettings"),
    { tsMs: now - 5000, name: "user_prompt", sessionId: "S", promptId: "P", attrs: {} },
    { tsMs: now - 4000, name: "api_request", sessionId: "S", promptId: "P", attrs: { query_source: "repl_main_thread", model: "m", duration_ms: 100 } },
    { tsMs: now - 3000, name: "tool_result", sessionId: "S", promptId: "P", attrs: { tool_name: "Read", duration_ms: 10, tool_input: JSON.stringify({ file_path: `${repo}/src/a.ts` }) } },
    { tsMs: now - 2500, name: "tool_result", sessionId: "S", promptId: "P", attrs: { tool_name: "Bash", duration_ms: 5, tool_input: JSON.stringify({ command: "cd ~/proj && ls" }) } },
    { tsMs: now - 2000, name: "hook_execution_complete", sessionId: "S", promptId: "P", attrs: { hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", hook_matcher: "Bash", total_duration_ms: 50 } },
  ];
}

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-remote-enrich-db-")), "t.sqlite"));
  const handler = createHandler({ store, port: PORT, assets: () => new Response(""), rebind: () => {}, publish: () => {}, tailscaleAddress: () => null });
  const host = store.createHost("remote", "0".repeat(64), 1);
  const now = Date.now();
  store.addEvents(telemetry(now));
  store.addEvents(telemetry(now), host.id);
  const get = async (path: string) => {
    const res = (await handler(new Request(`${ORIGIN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }), { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false }))!;
    expect([path, res.status]).toEqual([path, 200]);
    return res.json() as Promise<any>;
  };
  return { store, host, get };
}

function spies() {
  const list = {
    gitRoot: spyOn(repos, "gitRoot"),
    readFileSync: spyOn(fs, "readFileSync"),
    existsSync: spyOn(fs, "existsSync"),
    statSync: spyOn(fs, "statSync"),
    realpathSync: spyOn(fs, "realpathSync"),
    claudeDir: spyOn(settings, "claudeDir"),
  };
  return {
    clear: () => Object.values(list).forEach((s) => s.mockClear()),
    counts: () => Object.fromEntries(Object.entries(list).map(([k, s]) => [k, s.mock.calls.length])),
    restore: () => Object.values(list).forEach((s) => s.mockRestore()),
  };
}

const zero = { gitRoot: 0, readFileSync: 0, existsSync: 0, statSync: 0, realpathSync: 0, claudeDir: 0 };

const remotePaths = (path: string, hostId: string) => `${path}${path.includes("?") ? "&" : "?"}host=${hostId}`;
const ENDPOINTS = ["/api/item?kind=tools&name=Read", "/api/item?kind=tools&name=Bash", "/api/item?kind=hooks&name=PreToolUse:Bash", "/api/turns", "/api/turn?prompt=P", "/api/turn", "/api/summary", "/api/live", "/api/status"];

for (const order of ["remote first", "local first"] as const) {
  test(`remote telemetry never reads this Mac's disk, local still does (${order})`, async () => {
    const { store, host, get } = setup();
    const spy = spies();
    try {
      const remote = async () => {
        for (const path of ENDPOINTS) {
          spy.clear();
          await get(remotePaths(path, host.id));
          expect([path, spy.counts()]).toEqual([path, zero]);
        }
        const id = store.events(0, host.id).find((e) => e.name === "tool_result")!.id!;
        spy.clear();
        await get(`/api/event?id=${id}&host=${host.id}`);
        expect(spy.counts()).toEqual(zero);
      };
      const local = async () => {
        spy.clear();
        const item = await get("/api/item?kind=tools&name=Read");
        expect(item.recent[0].repo).toBe("repo");
        expect(spy.counts().gitRoot).toBeGreaterThan(0);
        spy.clear();
        const hooks = await get("/api/item?kind=hooks&name=PreToolUse:Bash");
        expect(hooks.definitions.length).toBe(3);
        expect(spy.counts().claudeDir).toBeGreaterThan(0);
      };
      if (order === "remote first") {
        await remote();
        await local();
      } else {
        await local();
        await remote();
      }
    } finally {
      spy.restore();
    }
  });
}

test("local enrichment resolves the fixture repo and config hooks", async () => {
  const { get } = setup();
  const read = await get("/api/item?kind=tools&name=Read");
  expect(read.repos[0]).toMatchObject({ name: "repo", root: repo });
  expect(read.recent[0]).toMatchObject({ repo: "repo", folder: repo, worktree: false });
  const turns = await get("/api/turns");
  expect(turns[0]).toMatchObject({ repo: "repo", folder: repo });
  const turn = await get("/api/turn?prompt=P");
  expect(turn).toMatchObject({ repo: "repo", folder: repo });
  const hooks = await get("/api/item?kind=hooks&name=PreToolUse:Bash");
  expect(hooks.definitions.map((d: any) => [d.source, d.command, d.configPath])).toEqual([
    ["plugin", "python3 plug.py", join(root, "plugin", "hooks", "hooks.json")],
    ["user", "node /opt/user-hook.js", join(claudeDir, "settings.json")],
    ["project", "bash project-hook.sh", join(repo, ".claude", "settings.json")],
  ]);
});

test("remote rows keep their transmitted paths, with no repo, worktree or config", async () => {
  const { store, host, get } = setup();
  const q = (path: string) => get(remotePaths(path, host.id));

  const read = await q("/api/item?kind=tools&name=Read");
  expect(read.repos).toEqual([expect.objectContaining({ name: null, root: null, label: "No repo · interactive sessions" })]);
  expect(read.recent[0]).toMatchObject({ repo: null, folder: `${repo}/src/a.ts`, worktree: false, branch: null });

  // The call's own path comes first; "~" is never expanded with this Mac's home.
  const bash = await q("/api/item?kind=tools&name=Bash");
  expect(bash.recent[0]).toMatchObject({ repo: null, folder: "~/proj", worktree: false });

  const hooks = await q("/api/item?kind=hooks&name=PreToolUse:Bash");
  // A hook call carries no path, so it shows the session's path as of its own moment.
  expect(hooks.recent[0]).toMatchObject({ repo: null, folder: "~/proj", worktree: false });
  const remoteDef = (source: string, hookSource: string, plugin: string | null) => ({
    source,
    plugin,
    matcher: "Bash",
    type: "telemetry",
    command: null,
    summary: "Registered on remote host",
    sessions: 1,
    configPath: null,
    hookEvent: "PreToolUse",
    hookSource,
  });
  expect(hooks.definitions).toEqual([remoteDef("plugin", "pluginHook", "myplug"), remoteDef("user", "userSettings", null), remoteDef("project", "projectSettings", null)]);

  const turns = await q("/api/turns");
  expect(turns[0]).toMatchObject({ repo: null, folder: `${repo}/src/a.ts` });
  const turn = await q("/api/turn?prompt=P");
  expect(turn).toMatchObject({ repo: null, folder: `${repo}/src/a.ts`, branch: null });

  const id = store.events(0, host.id).find((e) => e.attrs.tool_name === "Read")!.id!;
  const event = await q(`/api/event?id=${id}`);
  expect(event.session.repo).toBeNull();
  expect(event.session.repoTimeline).toEqual([]);
  expect(event.session.pathTimeline.map((p: any) => p.path)).toEqual([`${repo}/src/a.ts`, "~/proj"]);
});

test("buildSessionInfo and buildHookDefinitions honour the host context directly", () => {
  const now = Date.now();
  const rows = telemetry(now);
  const spy = spies();
  try {
    const remote = buildSessionInfo("S", rows, hostContext("remote-id"))!;
    expect(remote.repo).toBeNull();
    expect(remote.pathTimeline).toEqual([
      { tsMs: now - 3000, promptId: "P", path: `${repo}/src/a.ts` },
      { tsMs: now - 2500, promptId: "P", path: "~/proj" },
    ]);
    expect(pathAsOf(remote, now - 2600, "P")).toBe(`${repo}/src/a.ts`);
    expect(pathAsOf(remote, now - 4000, "P")).toBe(`${repo}/src/a.ts`);
    expect(pathAsOf(remote, now - 4000, "other")).toBeNull();
    const defs = buildHookDefinitions(
      "PreToolUse:Bash",
      rows.filter((r) => r.name === "hook_registered"),
      () => {
        throw new Error("repoRootForSession must not run for a remote host");
      },
      hostContext("remote-id"),
    );
    expect(defs.map((d) => [d.source, d.plugin, d.command, d.configPath])).toEqual([
      ["plugin", "myplug", null, null],
      ["user", null, null, null],
      ["project", null, null, null],
    ]);
    expect(spy.counts()).toEqual(zero);

    // Positive control: the same calls with the local context do read.
    const local = buildSessionInfo("S", rows, hostContext("local"))!;
    expect(local.repo?.root).toBe(repo);
    expect(spy.counts().gitRoot).toBeGreaterThan(0);
  } finally {
    spy.restore();
  }
});
