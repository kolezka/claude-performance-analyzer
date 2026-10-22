// Resolves the config behind a hooks item: which command runs for an event/matcher, read from
// plugin, user and project config files, matched against what sessions actually registered.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeDir } from "@cpa/claude-settings";
import type { Attrs, EventRow } from "@cpa/otlp";
import { BoundedCache } from "./bounded-cache";
import type { HostContext } from "./hosts";

export interface HookCall {
  hookEvent: string;
  matcher: string | null;
  count: number;
  success: number;
  errors: number;
  blocking: number;
  cancelled: number;
  stdoutChars: number;
  contextChars: number;
}

export interface HookDefinition {
  source: "plugin" | "user" | "project" | "local";
  plugin: string | null;
  matcher: string | null;
  type: string;
  command: string | null;
  summary: string;
  sessions: number;
  configPath: string | null;
  // Remote hosts only: the registration as telemetry carried it. Their config is not on this Mac.
  hookEvent?: string;
  hookSource?: Registration["hookSource"];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function hookCallFromAttrs(a: Attrs): HookCall {
  return {
    hookEvent: String(a.hook_event ?? ""),
    matcher: typeof a.hook_matcher === "string" && a.hook_matcher !== "" ? a.hook_matcher : null,
    count: num(a.num_hooks),
    success: num(a.num_success),
    errors: num(a.num_non_blocking_error),
    blocking: num(a.num_blocking),
    cancelled: num(a.num_cancelled),
    stdoutChars: num(a.stdout_chars),
    contextChars: num(a.additional_context_chars) + num(a.system_message_chars),
  };
}

// An item name is "<event>" (no matcher target, e.g. UserPromptSubmit) or "<event>:<matcher
// target>" (e.g. "PreToolUse:Bash"). Only the first colon splits; targets can contain more.
export function splitHookItemName(name: string): { event: string; matcherTarget: string | null } {
  const i = name.indexOf(":");
  return i === -1 ? { event: name, matcherTarget: null } : { event: name.slice(0, i), matcherTarget: name.slice(i + 1) };
}

// A plain "name|name|name" alternation of literal tool/hook names: common enough (and safe
// enough) to answer with a split and an exact membership check, never touching RegExp.
const LITERAL_ALTERNATION = /^[\w.:-]+(\|[\w.:-]+)*$/;
// The shape behind catastrophic backtracking: a group holding a quantifier, itself quantified
// again right outside (e.g. (a+)+, (a*){2,}). A matcher this shaped is rejected, not compiled.
const NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)[+*{?]/;
// Matchers and targets both come from config files or the wire; neither should ever need to be
// this long, and a very long pattern is itself a cheap way to make RegExp compilation or
// matching expensive even without nested quantifiers.
const MAX_MATCHER_LEN = 200;

// matcherApplies is on the request path for every /api/item?kind=hooks call, so its answer is
// memoized: the function is pure, and (matcher, target) pairs repeat constantly across rows.
const matcherAppliesCache = new Map<string, boolean>();

// Whether a registered/configured matcher applies to an item's matcher target. Absent, empty
// or "*" applies to everything. A literal "a|b|c" alternation is an exact membership check.
// Otherwise the matcher is compiled as an anchored regex against the target, but only when it
// has no nested-quantifier shape and both strings are short; anything else, or an invalid
// pattern, falls back to plain string equality. An event with no matcher target (its item name
// carries none) is never filtered by a matcher.
export function matcherApplies(matcher: string | null | undefined, target: string | null): boolean {
  if (target === null) return true;
  if (!matcher || matcher === "*") return true;

  const cacheKey = `${matcher}\u0000${target}`;
  const cached = matcherAppliesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: boolean;
  if (LITERAL_ALTERNATION.test(matcher)) {
    result = matcher.split("|").includes(target);
  } else if (matcher.length > MAX_MATCHER_LEN || target.length > MAX_MATCHER_LEN || NESTED_QUANTIFIER.test(matcher)) {
    result = matcher === target;
  } else {
    try {
      result = new RegExp(`^(?:${matcher})$`).test(target);
    } catch {
      result = matcher === target;
    }
  }
  matcherAppliesCache.set(cacheKey, result);
  return result;
}

// Basename of the first script-like token, prefixed by the interpreter word when the command
// starts with one; otherwise the command collapsed to one line and capped at 80 chars.
const INTERPRETERS = ["node", "python3", "python", "python2", "bun", "bunx", "bash", "sh", "zsh", "ts-node", "deno", "ruby", "perl"];
export function hookSummary(command: string): string {
  const m = command.match(/[^\s"'`]+\.(sh|py|js|mjs|cjs|ts|rb|pl)\b/);
  if (m) {
    const name = basename(m[0]);
    const firstWord = command.trim().split(/\s+/)[0] ?? "";
    const interp = INTERPRETERS.find((w) => firstWord === w || firstWord.endsWith(`/${w}`));
    return interp ? `${interp} ${name}` : name;
  }
  const collapsed = command.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? collapsed.slice(0, 80) : collapsed;
}

interface HookEntryConfig {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}
type HooksConfig = Partial<Record<string, HookEntryConfig[]>>;

// Config files change rarely; a short memo keeps repeated /api/item calls from re-reading and
// re-parsing them, without going stale for long if something does edit one. Bounded so years of
// distinct project roots and plugin paths a long-running collector sees do not grow it forever.
const CONFIG_CACHE_MS = 10_000;
const CONFIG_CACHE_MAX = 200;
const configCache = new BoundedCache<any>(CONFIG_CACHE_MAX, CONFIG_CACHE_MS);

function readJsonCached(path: string): any | null {
  const hit = configCache.get(path);
  if (hit !== undefined) return hit;
  let data: any = null;
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = null;
  }
  configCache.set(path, data);
  return data;
}

// Exposed only so a test can assert the cache stays bounded; not part of the module's real API.
export function _configCacheSizeForTests(): number {
  return configCache.size;
}

interface Registration {
  sessionId: string | null;
  hookEvent: string;
  hookSource: "pluginHook" | "userSettings" | "projectSettings";
  pluginName: string | null;
  hookMatcher: string | null;
}

function registrationFromEvent(e: EventRow): Registration | null {
  const a = e.attrs;
  const hookEvent = a.hook_event;
  const hookSource = a.hook_source;
  if (typeof hookEvent !== "string" || typeof hookSource !== "string") return null;
  if (hookSource !== "pluginHook" && hookSource !== "userSettings" && hookSource !== "projectSettings") return null;
  return {
    sessionId: e.sessionId,
    hookEvent,
    hookSource,
    pluginName: typeof a["plugin.name"] === "string" ? a["plugin.name"] : null,
    hookMatcher: typeof a.hook_matcher === "string" && a.hook_matcher !== "" ? a.hook_matcher : null,
  };
}

// installed_plugins.json keys a plugin as "<name>@<marketplace>"; telemetry's plugin.name is
// just the part before "@", so several marketplace entries can share one telemetry name.
function resolvePluginHookConfig(pluginName: string): { entries: HooksConfig; configPath: string } | null {
  const installed = readJsonCached(join(claudeDir(), "plugins", "installed_plugins.json"));
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object") return null;

  const candidates: any[] = [];
  for (const [key, list] of Object.entries(plugins)) {
    if (key.split("@")[0] !== pluginName) continue;
    if (Array.isArray(list)) candidates.push(...list);
  }
  if (!candidates.length) return null;
  const chosen = candidates.sort((a, b) => (Date.parse(b?.lastUpdated ?? "") || 0) - (Date.parse(a?.lastUpdated ?? "") || 0))[0];
  const installPath = chosen?.installPath;
  if (typeof installPath !== "string") return null;

  const hooksJsonPath = join(installPath, "hooks", "hooks.json");
  const hooksJson = readJsonCached(hooksJsonPath);
  if (hooksJson?.hooks && typeof hooksJson.hooks === "object") return { entries: hooksJson.hooks, configPath: hooksJsonPath };

  const pluginJsonPath = join(installPath, ".claude-plugin", "plugin.json");
  const pluginJson = readJsonCached(pluginJsonPath);
  if (pluginJson?.hooks === undefined) return null;
  if (typeof pluginJson.hooks === "string") {
    const refPath = join(installPath, pluginJson.hooks);
    const ref = readJsonCached(refPath);
    const entries = ref?.hooks && typeof ref.hooks === "object" ? ref.hooks : ref;
    return entries && typeof entries === "object" ? { entries, configPath: refPath } : null;
  }
  if (typeof pluginJson.hooks === "object") return { entries: pluginJson.hooks, configPath: pluginJsonPath };
  return null;
}

function entriesFor(config: HooksConfig | null | undefined, event: string): HookEntryConfig[] {
  const entries = config?.[event];
  return Array.isArray(entries) ? entries : [];
}

// A config file is valid JSON but can still hold the wrong shape in any one entry (a null, a
// string, an array where an object belongs: a typo or a hand-edited settings.json). Every
// entry and hook is checked before use; a malformed one is skipped, never thrown on.
function definitionsFromEntries(
  entries: HookEntryConfig[],
  source: HookDefinition["source"],
  plugin: string | null,
  matcherTarget: string | null,
  sessions: number,
  configPath: string,
): HookDefinition[] {
  const out: HookDefinition[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const matcher = typeof entry.matcher === "string" ? entry.matcher : null;
    if (!matcherApplies(matcher, matcherTarget)) continue;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (!hook || typeof hook !== "object" || Array.isArray(hook) || typeof hook.type !== "string") continue;
      const command = typeof hook.command === "string" ? hook.command : null;
      out.push({ source, plugin, matcher, type: hook.type, command, summary: hookSummary(command ?? ""), sessions, configPath });
    }
  }
  return out;
}

interface Group {
  hookSource: Registration["hookSource"];
  pluginName: string | null;
  hookMatcher: string | null;
  sessionIds: Set<string>;
}

// Builds the HookDefinition list for one hooks item: which sessions in `registeredRows"
// (hook_registered events) registered a hook for the item's event/matcher, and what command
// config actually configures for it, read from plugin/user/project/local settings files.
export function buildHookDefinitions(
  itemName: string,
  registeredRows: EventRow[],
  repoRootForSession: (sessionId: string) => string | null,
  context: HostContext,
): HookDefinition[] {
  const { event, matcherTarget } = splitHookItemName(itemName);

  const groups = new Map<string, Group>();
  for (const e of registeredRows) {
    const reg = registrationFromEvent(e);
    if (!reg || reg.hookEvent !== event) continue;
    if (!matcherApplies(reg.hookMatcher, matcherTarget)) continue;
    const key = `${reg.hookSource}|${reg.pluginName ?? ""}|${reg.hookMatcher ?? ""}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { hookSource: reg.hookSource, pluginName: reg.pluginName, hookMatcher: reg.hookMatcher, sessionIds: new Set() }));
    if (reg.sessionId) g.sessionIds.add(reg.sessionId);
  }

  const sourceOrder: Record<HookDefinition["source"], number> = { plugin: 0, user: 1, project: 2, local: 3 };

  // A remote host's config files live on that host, so only what it registered is known.
  if (!context.mayReadDisk) {
    const remoteSource = { pluginHook: "plugin", userSettings: "user", projectSettings: "project" } as const;
    return [...groups.values()]
      .map(
        (g): HookDefinition => ({
          source: remoteSource[g.hookSource],
          plugin: g.pluginName,
          matcher: g.hookMatcher,
          type: "telemetry",
          command: null,
          summary: "Registered on remote host",
          sessions: g.sessionIds.size,
          configPath: null,
          hookEvent: event,
          hookSource: g.hookSource,
        }),
      )
      .sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || (a.plugin ?? "").localeCompare(b.plugin ?? "") || (a.matcher ?? "").localeCompare(b.matcher ?? ""));
  }

  const defs: HookDefinition[] = [];
  for (const g of groups.values()) {
    if (g.hookSource === "pluginHook" && g.pluginName) {
      const cfg = resolvePluginHookConfig(g.pluginName);
      if (cfg) defs.push(...definitionsFromEntries(entriesFor(cfg.entries, event), "plugin", g.pluginName, matcherTarget, g.sessionIds.size, cfg.configPath));
    } else if (g.hookSource === "userSettings") {
      const path = join(claudeDir(), "settings.json");
      const config = readJsonCached(path)?.hooks as HooksConfig | undefined;
      defs.push(...definitionsFromEntries(entriesFor(config, event), "user", null, matcherTarget, g.sessionIds.size, path));
    } else if (g.hookSource === "projectSettings") {
      // Telemetry does not say which file (settings.json vs settings.local.json) registered
      // the hook, so both are read for each repo the group's sessions worked in.
      const rootSessions = new Map<string, Set<string>>();
      for (const sid of g.sessionIds) {
        const root = repoRootForSession(sid);
        if (!root) continue;
        (rootSessions.get(root) ?? rootSessions.set(root, new Set()).get(root)!).add(sid);
      }
      for (const [root, sids] of rootSessions) {
        for (const [file, source] of [
          ["settings.json", "project"],
          ["settings.local.json", "local"],
        ] as const) {
          const path = join(root, ".claude", file);
          const config = readJsonCached(path)?.hooks as HooksConfig | undefined;
          defs.push(...definitionsFromEntries(entriesFor(config, event), source, null, matcherTarget, sids.size, path));
        }
      }
    }
  }

  const seen = new Set<string>();
  const deduped = defs.filter((d) => {
    const key = `${d.source}|${d.plugin ?? ""}|${d.matcher ?? ""}|${d.command ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || (a.plugin ?? "").localeCompare(b.plugin ?? ""));
  return deduped;
}
