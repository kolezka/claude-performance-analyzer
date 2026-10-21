# Hook drill-down stage 1 + 1b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hooks detail window leads from a slow or failed hook call to everything known about it, with honest evidence labels, using only existing telemetry plus the `launcher` resource attr.

**Architecture:** Pure helpers in a new `apps/collector/src/hook-drilldown.ts` (patterns, finding line, candidates, narrowing hint). `/api/item` gains optional hook fields and a `pattern` filter; a new `/api/hook-call?id=` returns one call with its session context and candidate scripts. The SwiftUI menubar app adds a `hookCall` route and view and reworks the hooks section of `ItemDetailView`.

**Tech Stack:** Bun + TypeScript (`bun test`), SwiftUI built by `apps/menubar/scripts/build.sh` (no Swift unit tests exist).

**Spec:** `docs/superpowers/specs/2026-10-21-hook-drilldown-design.md`

## Global Constraints

- New payload fields are optional on the Swift side (`let x: T?`) so an older collector still decodes.
- Error means `num_non_blocking_error > 0`, same as `itemFailed` in `packages/analytics/src/index.ts:633`.
- Blocked (`num_blocking > 0`) and cancelled (`num_cancelled > 0`) are outcome tags, never errors.
- Config-derived facts are labelled "current configuration". Unknown values show "Not captured", never 0ms or OK.
- No timeout reads "no timeout set", never "unlimited".
- No long dashes (U+2014, U+2013) in code, comments or UI copy.
- Numeric hook attrs arrive as strings; always go through `hookCallFromAttrs` / `num()`.

## Review Focus

1. A window with zero failures: no finding line that mentions errors; patterns still render.
2. Failures split across headless and interactive sessions: finding line states both counts, never "all headless".
3. A 1-hook call in a session that registered 3 scripts: candidates status `mismatch`, no narrowing hint.
4. A call where no candidate has a timeout below its duration: hint is null (nothing to rule out).
5. `excludeHeadless=1` with headless failures present: response says how many calls and errors are hidden.

Each item has a test in the task that owns it (Tasks 1, 2, 3).

---

### Task 1: Pure drill-down helpers

**Files:**
- Create: `apps/collector/src/hook-drilldown.ts`
- Modify: `apps/collector/src/hooks.ts` (`HookDefinition` gets `timeoutSec: number | null`, filled in `definitionsFromEntries` from `hook.timeout`)
- Test: `apps/collector/test/hook-drilldown.test.ts`

**Interfaces:**
- Consumes: `HookCall`, `HookDefinition` from `./hooks`.
- Produces:
  - `patternKey(c: HookCall): string` returns `"<success>/<count>:<errors>:<blocking>:<cancelled>"`.
  - `patternLabel(c: HookCall): string` returns `"<success>/<count> OK"` plus `" · N error(s)"`, `" · N blocked"`, `" · N cancelled"` for each non-zero count.
  - `interface HookPattern { key: string; label: string; count: number; errors: number; p95: number }`
  - `summarizePatterns(rows: { call: HookCall; ms: number }[]): HookPattern[]` sorted by count desc, `errors` = rows with `call.errors > 0`, `p95` via `percentile` from `@cpa/analytics`.
  - `findingLine(rows: { call: HookCall; headless: boolean; launcher: string | null }[]): string | null`
  - `type CandidateStatus = "matched" | "mismatch" | "none"`
  - `candidates(call: HookCall, sessionDefs: HookDefinition[]): { status: CandidateStatus; scripts: HookDefinition[] }`
  - `narrowingHint(ms: number, status: CandidateStatus, scripts: HookDefinition[]): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
test("patternKey and patternLabel", () => {
  const c = call({ count: 3, success: 2, errors: 1 });
  expect(patternKey(c)).toBe("2/3:1:0:0");
  expect(patternLabel(c)).toBe("2/3 OK · 1 error");
  expect(patternLabel(call({ count: 1, success: 0, blocking: 1 }))).toBe("0/1 OK · 1 blocked");
});
test("summarizePatterns groups, counts errors, sorts by count", () => {
  const p = summarizePatterns([r(3, 3, 0, 300), r(3, 3, 0, 400), r(3, 2, 1, 250)]);
  expect(p.map((x) => [x.label, x.count, x.errors])).toEqual([["3/3 OK", 2, 0], ["2/3 OK · 1 error", 1, 1]]);
});
test("findingLine: none when no errors", () => {
  expect(findingLine([{ call: call({ count: 1, success: 1 }), headless: false, launcher: null }])).toBeNull();
});
test("findingLine: all headless with one launcher", () => {
  const rows = [1, 2].map(() => ({ call: call({ count: 3, success: 2, errors: 1 }), headless: true, launcher: "self-improvement-loop" }));
  expect(findingLine(rows)).toBe("2 calls reported errors, all headless, launched by self-improvement-loop. Failing script not reported.");
});
test("findingLine: mixed kinds states both counts", () => {
  const rows = [
    { call: call({ count: 3, success: 2, errors: 1 }), headless: true, launcher: null },
    { call: call({ count: 3, success: 2, errors: 1 }), headless: false, launcher: null },
  ];
  expect(findingLine(rows)).toBe("2 calls reported errors: 1 headless, 1 interactive. Failing script not reported.");
});
test("candidates: matched, mismatch, none", () => {
  const defs = [def("a", 5), def("b", 30), def("c", null)];
  expect(candidates(call({ count: 3, success: 3 }), defs).status).toBe("matched");
  expect(candidates(call({ count: 1, success: 1 }), defs).status).toBe("mismatch");
  expect(candidates(call({ count: 1, success: 1 }), []).status).toBe("none");
});
test("narrowingHint rules out scripts whose timeout is below the duration", () => {
  const defs = [def("self-improvement-loop", 5), def("hindsight", 30), def("security-guidance", null)];
  expect(narrowingHint(25_523, "matched", defs)).toBe(
    "25.5s is over the 5s timeout of self-improvement-loop, so only hindsight (30s timeout) or security-guidance (no timeout set) could take this long.",
  );
  expect(narrowingHint(2_000, "matched", defs)).toBeNull();
  expect(narrowingHint(25_523, "mismatch", defs)).toBeNull();
});
```

Helpers `call`, `r`, `def` build `HookCall` / `HookDefinition` literals; `def(name, timeoutSec)` sets `plugin: name`. Script display name in the hint: `plugin ?? hookSummary(command)`. Seconds formatting: `ms / 1000` with one decimal when not whole (`25.5s`), whole seconds for timeouts (`5s`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/collector/test/hook-drilldown.test.ts`
Expected: FAIL, module `../src/hook-drilldown` not found.

- [ ] **Step 3: Implement the helpers and `timeoutSec`**

`findingLine` counts rows with `call.errors > 0`; launcher clause only when every failing row has the same non-null launcher. `narrowingHint` returns null unless status is `matched` and at least one script has `timeoutSec * 1000 < ms` and at least one remains.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/collector/test/hook-drilldown.test.ts apps/collector/test/hooks.test.ts`
Expected: PASS (update any `hooks.test.ts` literal that now needs `timeoutSec`).

- [ ] **Step 5: Commit**

```bash
git add apps/collector/src/hook-drilldown.ts apps/collector/src/hooks.ts apps/collector/test/hook-drilldown.test.ts apps/collector/test/hooks.test.ts
git commit -m "feat(collector): hook patterns, finding line and narrowing hint"
```

### Task 2: Launcher on sessions and richer `/api/item` for hooks

**Files:**
- Modify: `apps/collector/src/sessions.ts` (`SessionInfo.launcher: string | null`, first non-empty `attrs.launcher` string across the session's events)
- Modify: `apps/collector/src/index.ts` (`itemDetail`, `Recent`, `toRecent`)
- Test: `apps/collector/test/item-hooks.test.ts` (extend), `apps/collector/test/session-kind.test.ts` (launcher case)

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces, on `/api/item?kind=hooks` (all new fields absent for other kinds):
  - query `pattern=<patternKey>` filters rows after the headless filter.
  - `patterns: HookPattern[]` (computed after the headless filter, before the pattern filter).
  - `finding: string | null` (over the same rows as `patterns`).
  - `hiddenByHeadless: { calls: number; errors: number } | null` (non-null only when `excludeHeadless=1`).
  - `slowest: Recent[]`, top 15 by `ms` over all filtered rows.
  - `failed` cap raised to 15; `recent` stays 10.
  - `Recent` gains `pattern: string | null` (label) and `launcher: string | null`.

- [ ] **Step 1: Write the failing tests** in `item-hooks.test.ts`, reusing its `record` helper. Seed for one hook name: 3 interactive OK calls (300, 400, 900 ms), 2 headless calls with 1 error each whose `user_prompt` event carries `launcher: s("self-improvement-loop")`. Assert:

```ts
expect(body.patterns.map((p: any) => p.label)).toEqual(["3/3 OK", "2/3 OK · 1 error"]);
expect(body.finding).toBe("2 calls reported errors, all headless, launched by self-improvement-loop. Failing script not reported.");
expect(body.slowest[0].ms).toBe(900);
expect(body.failed.every((f: any) => f.launcher === "self-improvement-loop")).toBe(true);
// excludeHeadless=1
expect(hidden.hiddenByHeadless).toEqual({ calls: 2, errors: 2 });
expect(hidden.finding).toBeNull();
// pattern filter
expect(filtered.count).toBe(2);
```

In `session-kind.test.ts`: a session whose events carry `launcher` gets `info.launcher === "x"`; one without gets `null`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/collector/test/item-hooks.test.ts apps/collector/test/session-kind.test.ts`
Expected: FAIL on `body.patterns` undefined and `launcher` undefined.

- [ ] **Step 3: Implement** in `itemDetail`: build `allRows` → headless filter → compute `patterns`, `finding`, `hiddenByHeadless` → pattern filter → existing stats, `slowest`, `recent`, `failed`. Session launcher via `sessionInfoFor(e.sessionId)?.launcher`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/collector/test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/collector/src/sessions.ts apps/collector/src/index.ts apps/collector/test/item-hooks.test.ts apps/collector/test/session-kind.test.ts
git commit -m "feat(collector): hook patterns, slowest calls and launcher in item detail"
```

### Task 3: `/api/hook-call` endpoint

**Files:**
- Modify: `apps/collector/src/index.ts` (new `hookCallDetail(req)`, route `"/api/hook-call": guarded(hookCallDetail)`)
- Test: `apps/collector/test/hook-call.test.ts`

**Interfaces:**
- Consumes: Task 1 `candidates`, `narrowingHint`; `buildHookDefinitions(name, registrations, repoRootForSession)` with registrations from `store.eventsByNameForSessions("hook_registered", [sessionId])`.
- Produces: `GET /api/hook-call?id=<event id>` → 404 for unknown id or a non-`hook_execution_complete` row, else:

```ts
{
  call: Recent;                       // toRecent("hooks", row)
  name: string;                       // itemKey("hooks", row.attrs)
  session: { kindLabel: string | null; terminal: string | null; claudeVersion: string | null; launcher: string | null; sessionId: string | null };
  candidates: { status: "matched" | "mismatch" | "none"; scripts: HookDefinition[] };
  hint: string | null;
}
```

- [ ] **Step 1: Write the failing tests.** Seed one session with three `hook_registered` rows (user settings command hook, two plugin hooks) and two calls: a 3-hook 25523 ms call and a 1-hook 7 ms call. Point `CC_CLAUDE_DIR` at a temp dir whose `settings.json` has a UserPromptSubmit command hook with `timeout: 30`. Assert for the 3-hook call: `status === "matched"`, the user script has `timeoutSec === 30`; for the 1-hook call: `status === "mismatch"` and `hint === null`; unknown id → 404.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/collector/test/hook-call.test.ts`
Expected: FAIL with 404 on the valid id (route missing).

- [ ] **Step 3: Implement `hookCallDetail`.**

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/collector/test/hook-call.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/collector/src/index.ts apps/collector/test/hook-call.test.ts
git commit -m "feat(collector): hook call detail endpoint with candidate scripts"
```

### Task 4: Swift payloads, route and hook call view

**Files:**
- Modify: `apps/menubar/Sources/Models/DetailPayloads.swift` (optional fields from Tasks 2 and 3; `Definition.timeoutSec: Double?`; new `HookCallDetail: Decodable`)
- Modify: `apps/menubar/Sources/Views/Detail/DetailRoute.swift` (`case hookCall(id: Int)`)
- Modify: `apps/menubar/Sources/Views/Detail/DetailWindowView.swift` (route switch)
- Create: `apps/menubar/Sources/Views/Detail/HookCallDetailView.swift`
- Modify: the `Telemetry` model file that loads `/api/event` (add `hookCall(id:) async throws -> HookCallDetail` next to it)

**Interfaces:**
- Consumes: Task 3 JSON.
- Produces: `DetailRoute.hookCall(id:)` for Task 5.

View content, top to bottom:
- Header: `"<duration> · <success> OK · <errors> error(s)"` plus `" · failing script not reported"` when errors > 0.
- Context rows: time, kind label, terminal, folder or "Folder not recorded", branch, Claude Code version, "Launched by: X" or "Launcher not reported", session ID (selectable).
- "Scripts" section with a caption "Current configuration". `matched`: one row per script with name, command, "Timeout: Ns" or "No timeout set", and "Duration: Not captured", "Status: Not captured" in tertiary text. `mismatch`: line "N hook(s) ran; which one is not reported." then the scripts listed as candidates. `none`: "No hook registrations seen for this session."
- Hint text when non-null, captioned "Current configuration".
- Note: "Per-script timing is not captured yet." in tertiary text.
- Secondary button "Open turn" when `call.promptId` exists (pushes `.turn`).

- [ ] **Step 1: Build to confirm the baseline compiles**

Run: `cd apps/menubar && ./scripts/build.sh`
Expected: exit 0.

- [ ] **Step 2: Implement payloads, route, loader and view.**

- [ ] **Step 3: Build**

Run: `cd apps/menubar && ./scripts/build.sh`
Expected: exit 0, no warnings about non-exhaustive switch.

- [ ] **Step 4: Commit**

```bash
git add apps/menubar/Sources
git commit -m "feat(menubar): hook call detail view"
```

### Task 5: Rework the hooks section of `ItemDetailView`

**Files:**
- Modify: `apps/menubar/Sources/Views/Detail/ItemDetailView.swift`
- Modify: the `/api/item` loader to pass `pattern` when set

**Interfaces:**
- Consumes: Task 2 fields, Task 4 route.

Changes for `kind == hooks` only; tools and agents keep today's layout:
- `finding` as a callout under the stats grid when non-null.
- "Patterns" strip: one row per pattern, `label · count · p95`; tapping selects it as a filter (tap again clears) and reloads with `pattern=<key>`.
- `hiddenByHeadless` shown under the headless toggle as "Hiding N calls (M errors) from headless sessions." when non-null.
- One call list with a segmented picker Slowest / Errors / Recent (default Slowest when `slowest` exists, else Recent). Row: time, duration, `pattern` label (replaces "N hooks · N errors · Nk stdout"), kind badge, folder or "Folder not recorded".
- `openCall` pushes `.hookCall(id:)` for hooks; other kinds unchanged.
- "Hooks in this group": each definition row shows "Timeout: Ns" or "No timeout set", section caption "Current configuration". Remove the old "Telemetry reports time per group..." footnote.
- "By repository" moves below the call list inside a collapsed `DisclosureGroup`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Build**

Run: `cd apps/menubar && ./scripts/build.sh`
Expected: exit 0.

- [ ] **Step 3: Full checks**

Run: `bun test` and `bun run typecheck` at the repo root.
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/menubar/Sources
git commit -m "feat(menubar): cause-first hooks window"
```
