import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { CACHE_TTL_MS, gitRoot } from "../src/repos";

// Canonicalized because macOS puts the real tmp dir behind a symlink (/var -> /private/var),
// and git itself writes the canonical path into a worktree's gitdir file.
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("gitRoot resolves a path inside a normal repo", async () => {
  const dir = tempDir("cc-repo-");
  await $`git init -q`.cwd(dir).quiet();
  writeFileSync(join(dir, "file.txt"), "hi");

  expect(gitRoot(join(dir, "file.txt"))).toEqual({ name: basename(dir), root: dir, worktree: null });
});

test("gitRoot resolves a worktree to its main repo's root", async () => {
  const main = tempDir("cc-main-");
  await $`git init -q`.cwd(main).quiet();
  await $`git -c user.email=a@b.c -c user.name=a commit --allow-empty -q -m init`.cwd(main).quiet();
  const worktree = join(realpathSync(tmpdir()), `cc-wt-${Date.now()}`);
  await $`git worktree add -q ${worktree} -b feat/x`.cwd(main).quiet();
  writeFileSync(join(worktree, "file.txt"), "hi");

  expect(gitRoot(join(worktree, "file.txt"))).toEqual({ name: basename(main), root: main, worktree });
});

test("gitRoot returns null for a path outside any repo", () => {
  const dir = tempDir("cc-none-");
  expect(gitRoot(join(dir, "file.txt"))).toBeNull();
});

test("gitRoot resolves a nonexistent file via its nearest existing ancestor", async () => {
  const dir = tempDir("cc-repo2-");
  await $`git init -q`.cwd(dir).quiet();
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });

  expect(gitRoot(join(sub, "missing.txt"))).toEqual({ name: basename(dir), root: dir, worktree: null });
});

test("gitRoot resolves a path reached through a symlink to the real repo, not the link", async () => {
  const target = tempDir("cc-sym-target-");
  await $`git init -q`.cwd(target).quiet();
  writeFileSync(join(target, "file.txt"), "hi");

  const container = tempDir("cc-sym-container-");
  const link = join(container, "link");
  symlinkSync(target, link, "dir");

  expect(gitRoot(join(link, "file.txt"))).toEqual({ name: basename(target), root: target, worktree: null });
});

test("gitRoot re-checks a directory after the cache TTL instead of caching 'no repo' forever", async () => {
  const dir = tempDir("cc-ttl-");
  expect(gitRoot(join(dir, "file.txt"))).toBeNull();
  await $`git init -q`.cwd(dir).quiet();

  const realNow = Date.now;
  Date.now = () => realNow() + CACHE_TTL_MS + 1000;
  try {
    expect(gitRoot(join(dir, "file.txt"))).toEqual({ name: basename(dir), root: dir, worktree: null });
  } finally {
    Date.now = realNow;
  }
});

test("gitRoot resolves a worktree whose gitdir line is relative to the .git file's directory", async () => {
  const main = tempDir("cc-rel-main-");
  await $`git init -q`.cwd(main).quiet();
  const worktree = tempDir("cc-rel-wt-");
  const worktreeGitDir = join(main, ".git", "worktrees", "wt1");
  const relGitDir = relative(worktree, worktreeGitDir);
  writeFileSync(join(worktree, ".git"), `gitdir: ${relGitDir}\n`);

  expect(gitRoot(worktree)).toEqual({ name: basename(main), root: main, worktree });
});

test("gitRoot treats a submodule as its own repo, not part of the parent", async () => {
  const sub = tempDir("cc-sub-");
  await $`git init -q`.cwd(sub).quiet();
  await $`git -c user.email=a@b.c -c user.name=a commit --allow-empty -q -m init`.cwd(sub).quiet();
  writeFileSync(join(sub, "file.txt"), "hi");
  await $`git add -A`.cwd(sub).quiet();
  await $`git -c user.email=a@b.c -c user.name=a commit -q -m f`.cwd(sub).quiet();

  const outer = tempDir("cc-outer-");
  await $`git init -q`.cwd(outer).quiet();
  await $`git -c protocol.file.allow=always submodule add -q ${sub} sub`.cwd(outer).quiet();
  const outerSub = join(outer, "sub");

  expect(gitRoot(join(outerSub, "file.txt"))).toEqual({ name: "sub", root: outerSub, worktree: null });

  // A path in the outer repo itself (outside the submodule) must still resolve to the outer repo.
  writeFileSync(join(outer, "top.txt"), "hi");
  expect(gitRoot(join(outer, "top.txt"))).toEqual({ name: basename(outer), root: outer, worktree: null });
});
