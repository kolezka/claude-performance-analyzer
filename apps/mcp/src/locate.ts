// Finds Claude Code transcripts on disk and parses them, caching each file by size and mtime.
// A session's transcript lives under the project folder of its working directory, and moves
// when the session switches directory (e.g. into a worktree), so lookups by id scan every
// project folder instead of trusting the folder the session started in.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeDir } from "@cpa/claude-settings";
import { parseTranscript, type TranscriptData } from "./transcript";

export interface SessionFiles {
  sessionId: string;
  main: string | null;
  subagents: string[];
}

export function projectsDir(): string {
  return join(claudeDir(), "projects");
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(path, d.name));
  } catch {
    return [];
  }
}

function listFiles(path: string, suffix: string): string[] {
  try {
    return readdirSync(path)
      .filter((n) => n.endsWith(suffix))
      .map((n) => join(path, n));
  } catch {
    return [];
  }
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function subagentFiles(projectDir: string, sessionId: string): string[] {
  return listFiles(join(projectDir, sessionId, "subagents"), ".jsonl");
}

// Exact id, or a unique prefix of at least 8 characters.
export function findSession(idOrPrefix: string): SessionFiles[] {
  const found = new Map<string, SessionFiles>();
  for (const dir of listDirs(projectsDir())) {
    for (const file of listFiles(dir, ".jsonl")) {
      const id = basename(file, ".jsonl");
      if (id !== idOrPrefix && !(idOrPrefix.length >= 8 && id.startsWith(idOrPrefix))) continue;
      const entry = found.get(id) ?? { sessionId: id, main: null, subagents: [] };
      entry.main ??= file;
      entry.subagents.push(...subagentFiles(dir, id));
      found.set(id, entry);
    }
  }
  return [...found.values()];
}

// Sessions whose main transcript or any subagent transcript changed since `sinceMs`.
export function recentSessions(sinceMs: number): SessionFiles[] {
  const found = new Map<string, SessionFiles>();
  for (const dir of listDirs(projectsDir())) {
    const ids = new Set<string>();
    for (const file of listFiles(dir, ".jsonl")) ids.add(basename(file, ".jsonl"));
    for (const sub of listDirs(dir)) ids.add(basename(sub));
    for (const id of ids) {
      const main = join(dir, `${id}.jsonl`);
      const subs = subagentFiles(dir, id);
      const hasMain = existsSync(main);
      const touched = (hasMain && mtimeMs(main) >= sinceMs) || subs.some((s) => mtimeMs(s) >= sinceMs);
      if (!touched) continue;
      const entry = found.get(id) ?? { sessionId: id, main: null, subagents: [] };
      if (hasMain) entry.main ??= main;
      entry.subagents.push(...subs);
      found.set(id, entry);
    }
  }
  return [...found.values()];
}

const cache = new Map<string, { size: number; mtimeMs: number; data: TranscriptData }>();
const CACHE_MAX = 2000;
// A week of transcripts is around a gigabyte of text that turns into garbage right after
// parsing. Collecting every so often keeps a long-lived server's memory from ballooning.
const GC_EVERY_BYTES = 64 * 1024 * 1024;
let bytesSinceGc = 0;

export async function readTranscript(path: string, agentId: string | null = null): Promise<TranscriptData> {
  const st = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.data;
  const data = parseTranscript(await Bun.file(path).text(), agentId);
  bytesSinceGc += st.size;
  if (bytesSinceGc >= GC_EVERY_BYTES) {
    bytesSinceGc = 0;
    Bun.gc(true);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, data });
  return data;
}

export interface SessionData {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  firstMs: number | null;
  lastMs: number | null;
  prompts: { id: string; tsMs: number }[];
  main: TranscriptData | null;
  subagents: TranscriptData[];
  // Hook lines that could not be parsed (e.g. cut short mid-write); shown, never hidden.
  badLines: number;
}

export async function loadSession(files: SessionFiles): Promise<SessionData> {
  const main = files.main ? await readTranscript(files.main) : null;
  const subagents: TranscriptData[] = [];
  for (const path of files.subagents) {
    subagents.push(await readTranscript(path, basename(path, ".jsonl").replace(/^agent-/, "")));
  }
  const all = [main, ...subagents].filter((d): d is TranscriptData => d !== null);
  const firsts = all.map((d) => d.firstMs).filter((v): v is number => v !== null);
  const lasts = all.map((d) => d.lastMs).filter((v): v is number => v !== null);
  return {
    sessionId: files.sessionId,
    cwd: main?.cwd ?? all.find((d) => d.cwd)?.cwd ?? null,
    gitBranch: main?.gitBranch ?? null,
    firstMs: firsts.length ? Math.min(...firsts) : null,
    lastMs: lasts.length ? Math.max(...lasts) : null,
    prompts: main?.prompts ?? [],
    main,
    subagents,
    badLines: all.reduce((sum, d) => sum + d.badLines, 0),
  };
}
