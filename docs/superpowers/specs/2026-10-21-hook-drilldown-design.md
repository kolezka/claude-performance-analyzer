# Hook drill-down: from outlier to cause

Date: 2026-10-21. Status: draft for approval.

## Why

The hooks detail window (`ItemDetailView`, hooks kind) shows count, failures, p50/p95/max and a
list of recent calls, but it cannot answer the questions the user opens it with: which call was
slow or failed, in what session, and which script did it. Example from 2026-10-21, 24h of
`UserPromptSubmit`: 655 calls, 163 failures, p50 120ms, p95 388ms, max 25.5s. The window gave no
way to land on the 25.5s call or the failures and see what was behind them.

What the data actually holds (checked against `~/.claude-telemetry/telemetry.sqlite` for that
window):

- Calls fall into three distinct populations that one p50/p95 hides:
  - 3/3 hooks OK: 221 calls, avg 364ms.
  - 2/3 OK plus 1 non-blocking error: 163 calls, avg 297ms. All 163 come from
    `terminal.type = non-interactive` sessions. iTerm sessions: 492 calls, 0 failures.
  - 1/1 OK: 271 calls, avg 6ms (a one-hook group).
- The 25.5s max (`total_duration_ms` 25523) is a non-interactive call with 1 error.
- Telemetry reports time per hook group, never per script, and never names the failing script.
- Session transcripts do not fill the gap for this event: scripts that return JSON context are
  logged without command or duration, and only a few percent of sessions have a transcript at
  all. Headless sessions mostly have none.

So most of the value comes from presenting the data we already have honestly, and per-script
answers need a new source that the user's own scripts write.

## Goals

1. From the hooks window, reach the slowest or a failed call in one click.
2. Make the populations visible (session kind, success pattern) instead of one blended number.
3. A per-call detail that shows everything known about that call, and clearly marks what is not
   known.
4. Later: per-script duration, exit code and phase timings ("why"), for scripts the user owns.

## Non-goals

- Explaining third-party scripts (for example security-guidance) beyond what telemetry says.
- Broad transcript ingestion. Possibly a small, later add-on; not part of this design.
- Historical snapshots of hook configuration (user decision: label current config instead).
- Automatically rerunning hooks to diagnose them.

## Anti-goals (would count as failure even if it works)

- A candidate script shown as if proven guilty.
- Missing data rendered as 0ms, a green status or an empty list that reads as "healthy".
- A filter that hides failures without saying so (today "Hide headless" would hide all 163).
- Any change that rewrites hook commands in user or plugin config (a shell shim). Rejected: it
  is undone by plugin updates, can change hook behaviour (the self-improvement-loop command
  guards on `$PPID`), and cannot see function hooks.

## Evidence labels

Every fact in the call detail carries one of four labels. These are the contract for honesty.

| Label | Meaning |
|---|---|
| Recorded | Directly present in a record about this run (telemetry event or a script run log). |
| Time-matched | Linked to this call by session and time, not by a shared ID. |
| Current configuration | Read from config files today. A candidate, not proof of what ran then. |
| Not captured | Unknown. Never shown as 0, OK or green. |

## Which scripts belong to a call (lead's call)

Telemetry does not say which scripts a call ran. `hook_execution_complete` carries counts and
`hook_source: "merged"` for every UserPromptSubmit call in the window, for both the 3-hook and the
1-hook groups, so the source attr cannot tell them apart. Interactive sessions emit both kinds
(221 three-hook + 271 one-hook = 492 iTerm calls); which script the 1-hook call is stays unknown.

Rule:

- Candidate scripts for a call are the scripts that call's session registered for that event
  (`hook_registered` rows for the session ID), resolved against current configuration. Fall back
  to nothing when the session has no registrations: show "No hook registrations seen for this
  session" rather than guessing from other sessions.
- When the call's `num_hooks` equals the candidate count, show the candidates as "ran in this
  call", still labelled current configuration.
- When it does not match (for example a 1-hook call with three candidates), show "1 hook ran,
  which one is not reported" and list the candidates as candidates. No narrowing hint for that
  call.
- The narrowing hint (below) only runs when the counts match.

## What counts as an error (lead's call)

- Error: `num_non_blocking_error > 0`. Same rule as `itemFailed` in `packages/analytics`, so the
  Errors list, patterns and finding line agree with the existing `failures` total.
- Blocked (`num_blocking > 0`) and cancelled (`num_cancelled > 0`) are shown as their own outcome
  tags on rows and in the pattern key, not counted as errors. A block is often the hook working.

## Stage 1: existing data only (build first)

Collector (`apps/collector/src/index.ts`, `itemDetail`) and payload
(`apps/menubar/Sources/Models/DetailPayloads.swift`) changes, plus the Swift view. New payload
fields are optional, so older collectors keep working (existing convention in `DetailPayloads`).

### Hooks window

- **Finding line** at the top, computed from the rows, for example "163 calls reported errors,
  all headless. Failing script not reported." Wording rules are for the builder; it must state
  counts and must not name a script.
- **Patterns**: group hook calls by `num_success`/`num_hooks` plus error count. Show count and
  p95 per pattern (no averages). Clicking a pattern filters the call list. A 1/1 pattern must not
  look like it ran the three configured scripts.
- **One call list** with a Slowest / Errors / Recent switch. Slowest and Errors are computed over
  all rows in the window, not from the 10 most recent (today `recent` is cut to 10 at
  `index.ts:236`). Keep a small cap per list (builder's call, around 10 to 20).
- **Call row**: time, group duration, outcome ("2/3 OK, 1 error"), session kind badge, folder or
  "folder not recorded". Drop "Nk stdout".
- **Headless filter**: when it hides calls, show how many calls and how many errors it hides.
- **Hooks in this group**: show each script's configured timeout, labelled current configuration.
  No timeout set reads "no timeout set", not "unlimited". `HookDefinition` needs a `timeout`
  field read from the config entry.
- **Narrowing hint** (labelled current configuration): when a call's duration exceeds some
  scripts' configured timeouts, say which scripts could still have taken that long. Example:
  "25.5s exceeds self-improvement-loop's 5s timeout; hindsight (30s) or security-guidance (no
  timeout set) could be this slow."
- Repo breakdown and the old telemetry footnote move below the call list, collapsed by default.

### Hook call detail (new)

- Clicking a hook call opens a hook-call detail, not the turn waterfall. Today `openCall`
  (`ItemDetailView.swift:272`) pushes `.turn` when a prompt ID exists. The existing
  `DetailRoute.event(id:)` may be reused or a new route added (builder's call). "Open turn" stays
  as a secondary link.
- Header: "25.5s · 2 OK · 1 error · failing script not reported".
- Context: time, session kind and terminal, folder, branch, Claude Code version, session ID.
- One row per script in the group from current configuration. In stage 1 each row shows
  configured timeout and "Not captured" for duration and status.
- When nothing more can be known, a short "How to capture this" note pointing at stage 2/3.

## Stage 1b: who launched a headless session

Added after the 2026-10-21 investigation. Finding the launcher took a manual walk through `ps`,
launchd and plists; the window should answer it directly.

What was found (verified): the 163 failing headless calls came from the self-improvement-loop
worker (launchd `com.raqz.sil-worker` runs `sil worker --once`, which runs `claude -p
--no-session-persistence`). Its baked PATH had no `node`, so the hindsight hook (`node
claude-hook.js`) failed with exit 127 in every run. The PATH fix lives in self-improvement-loop.

Mechanism (verified with a live probe): Claude Code copies `OTEL_RESOURCE_ATTRIBUTES` onto every
event it exports, and the collector already merges resource attrs into event attrs
(`packages/otlp/src/json.ts:77`). A run started with `OTEL_RESOURCE_ATTRIBUTES=launcher=X` shows
`launcher: "X"` on its `hook_execution_complete` events.

Collector and UI:

- Read `launcher` from event attrs, per session (first non-empty value wins).
- Session context in the hook call detail shows "Launched by: X" (recorded). Without the attr:
  "Launcher not reported", plus a short hint that a launcher can set `OTEL_RESOURCE_ATTRIBUTES`.
- Call rows and the finding line may group headless calls by launcher (for example "163 errors,
  all headless, launched by self-improvement-loop").
- self-improvement-loop tags its `claude -p` runs with `launcher=self-improvement-loop` (done in
  that repo, same change set as the PATH fix).

Note: `terminal.type` is `iTerm.app` for a `claude -p` started from an iTerm shell, so
"headless" in this app means "no terminal", not "any `-p` run". The launcher attr is the reliable
way to tell scripted runs apart.

## Stage 2: one manual diagnostic run (not code)

Run one headless session from the same launcher that produces the failing sessions with
`--debug=hooks --debug-file <path>` and read which script fails and why. This is separate evidence
about a new run. It is never attached to old calls as proof. The launcher is now known (stage 1b);
the remaining check is that worker runs show 0 hook errors once the PATH fix is installed.

## Stage 3: per-script run log (after stage 1 ships)

Out of scope for the stage 1 plan (lead's call). It needs work in another repo
(self-improvement-loop, possibly hindsight) and a schema contract, so it gets its own short design
before planning. That design must define the script ID so a run line matches one configured
script; the proposal is `<source>:<plugin or "user">:<command>`, using the same command string the
collector already reads from config. The direction below is kept so stage 1 does not block it.

- The user's own hook scripts append one JSON line per run to a local file, proposed
  `~/.claude-telemetry/hook-runs.jsonl`. Fields: session ID, hook event, script ID, start and end
  timestamps, exit code, short error, optional phase timings (for example fetch ms, retries,
  timeout hit), script version.
- Certain to be instrumented: self-improvement-loop (user's own plugin). Hindsight only if the
  user controls that code (not confirmed). security-guidance stays "Not captured".
- The collector tails the file by offset and links runs to telemetry calls by session ID, hook
  event and time window. Matches are labelled time-matched; ambiguous matches are rejected, not
  guessed.
- The call detail fills script rows from these runs (duration, exit, error, phases), labelled
  recorded or time-matched. "Hooks in this group" gains per-script p50/p95/failures where runs
  exist, plus a coverage line ("per-script timing for 2 of 3 scripts").
- Writing the log must never slow or break the hook: local append only, no network, failures to
  write are ignored by the script.

## Constraints

- Bun/TypeScript collector, SwiftUI menubar app, existing endpoints and payload conventions.
- Numeric hook attrs are stored as JSON strings; cast before comparing or sorting.
- Dotted attr keys need quoting in SQLite JSON paths (`'$."terminal.type"'`).
- No new dependencies needed.

## Left to the builder

- Exact copy for the finding line and labels, within the anti-goals above.
- List caps, pattern ordering, layout and styling.
- Route choice for the call detail.
- Whether pattern stats come from a new endpoint or extend `/api/item`.
- Stage 3 file rotation and offset bookkeeping.
