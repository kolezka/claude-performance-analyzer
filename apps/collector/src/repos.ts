// Maps a filesystem path to the git repo it lives in, without spawning git.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface RepoInfo {
  name: string;
  root: string;
  worktree: string | null;
}

// A dir cached as "no repo" must not stay stale forever (e.g. after `git init` runs there).
export const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { result: RepoInfo | null; at: number }>();

function cacheGet(dir: string): RepoInfo | null | undefined {
  const hit = cache.get(dir);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(dir);
    return undefined;
  }
  return hit.result;
}

function cacheSet(dir: string, result: RepoInfo | null) {
  cache.set(dir, { result, at: Date.now() });
}

// Starting point for the walk: path itself if it is a directory, its parent if a file,
// or the nearest existing ancestor directory if the path does not exist on disk.
// Resolved to its canonical form so a symlinked ancestor does not get treated as its own repo.
function nearestExistingDir(path: string): string {
  let dir: string;
  if (existsSync(path)) {
    dir = statSync(path).isDirectory() ? path : dirname(path);
  } else {
    dir = dirname(path);
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return realpathSync(dir);
}

// A worktree's .git file holds "gitdir: <main>/.git/worktrees/<name>", absolute or relative
// to the .git file's own directory.
function mainRootFromWorktreeGitDir(gitDirAbs: string): string | null {
  const m = gitDirAbs.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
  return m ? m[1]! : null;
}

function resolveFrom(dir: string): RepoInfo | null {
  const visited: string[] = [];
  let cur = dir;
  for (;;) {
    const cached = cacheGet(cur);
    if (cached !== undefined) {
      for (const v of visited) cacheSet(v, cached);
      return cached;
    }
    visited.push(cur);

    const gitPath = `${cur}/.git`;
    if (existsSync(gitPath)) {
      const st = statSync(gitPath);
      let result: RepoInfo | null = null;
      if (st.isDirectory()) {
        result = { name: basename(cur), root: cur, worktree: null };
      } else {
        const content = readFileSync(gitPath, "utf8");
        const m = content.match(/^gitdir:\s*(.+)$/m);
        const gitDirAbs = m ? resolve(cur, m[1]!.trim()) : null;
        const mainRoot = gitDirAbs ? mainRootFromWorktreeGitDir(gitDirAbs) : null;
        if (mainRoot) {
          result = { name: basename(mainRoot), root: mainRoot, worktree: cur };
        } else if (gitDirAbs) {
          // Not a worktree link: a submodule's "gitdir: ../.git/modules/<name>" (or anything
          // else pointing elsewhere) is still its own repo, rooted where its .git file lives.
          result = { name: basename(cur), root: cur, worktree: null };
        }
      }
      if (result) {
        for (const v of visited) cacheSet(v, result);
        return result;
      }
    }

    const parent = dirname(cur);
    if (parent === cur) {
      for (const v of visited) cacheSet(v, null);
      return null;
    }
    cur = parent;
  }
}

// Walks up from `path` (or its nearest existing ancestor) to find the enclosing git repo.
export function gitRoot(path: string): RepoInfo | null {
  return resolveFrom(nearestExistingDir(path));
}
