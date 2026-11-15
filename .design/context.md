# Context: claude-performance-analyzer web UI

Source: `apps/dashboard` (Svelte 5 + ECharts 6, served by the collector via Bun HTML import). Single page, no router.

## Purpose
Local dashboard answering "why is Claude Code slow right now?" for this Mac and for remote hosts (Tailscale). Data comes from Claude Code OpenTelemetry logs/metrics/traces collected by `apps/collector` into SQLite.

## Current shell (apps/dashboard/src/App.svelte)
- Header: title "Claude Code speed", window segmented control `15m · 1h · 24h · 7d` (persisted in localStorage), Host select ("This Mac" + remote hosts), right-aligned "`{eventCount} events · HH:MM`".
- Setup card (only when settings are missing): "Send Claude Code telemetry from this Mac here", lists missing env keys, primary button "Add 3 missing settings", note "Existing values are never changed. A backup is written first."
- Remote hosts card (collapsible `<details>`): host list, add host form, one-time token reveal with env block.
- Live card: dot + "Live" / "Connecting" / "Reconnecting", "last event 4s ago", running hook chips "hook PreToolUse:Bash running 1.2s", feed of up to 40 rows: time `20:31:07`, colour chip, label, duration bar, ms.
- Then one long vertical stack of cards:
  1. KPI row (6 tiles): API latency p50 (sub "p95 9.8s · 142 req"), Turn time p50 ("38 prompts · 4 sessions"), Time to first token ("p50" or "n/a · needs traces (beta)"), Hook time ("12% of in-turn time", warn flag when > 15% or a hook p95 > 2s), Cost ("$4.12", "182k out · 2.1M in"), Cache hit ("91%", "1.9M read · 140k write").
  2. "Where turn time goes": one stacked 100% bar Model (API) / Tools / Hooks.
  3. "Turn waterfall": Gantt of one prompt's spans (lanes main, subagents, background).
  4. "API latency over time": p50/p95 line chart.
  5. Grid: "Hooks by total time", "Tools, skills, MCP by total time" horizontal bars (top 12).
  6. "Recent prompts": stacked bars per prompt; click selects it for the waterfall.
  7. Tables: Skills, Subagents, Models, Permission decisions, MCP server connect, Errors and compaction.
- Empty states: "Collector unreachable", "No telemetry yet" (env block), "No telemetry from {host} yet", "No API requests in this window.", "No prompts in this window.", "Waiting for events...".

## Visual tokens today (src/style.css)
"Liquid Glass": translucent cards, blur(28px), 18px radius, colour-field gradient background. System font 13px. api `#2a78d6`, tools `#eb6834`, hooks `#1baf7a`, warn `#fab219`, critical `#d03b3b`. Light + dark.

## Problems with today's UI
- One long scroll; the "why is it slow" answer (outlier hook, slow turn) sits below charts.
- Waterfall shows only one prompt; the prompt list is a chart, not a scannable list.
- Setup, hosts and live feed push the analytics down.
- The collector serves data the web UI never shows (the menu bar app uses it): `/api/turns` (sort recent|slowest, activeMs vs idleMs, repo, folder, inProgress, sessionLabel), `/api/item?kind=hooks|tools|agents&name=` (count, failures, p50/p95/max, per-repo buckets, recent, failed, slowest, hook patterns, `finding` line, hook definitions), `/api/event?id=`, `/api/hook-call?id=` (resolved script candidates).

## Data (packages/analytics)
- Summary.kpis: sessions, prompts, apiRequests, apiP50, apiP95, ttftP50|null, turnP50, costUsd, tokens{input,output,cacheRead,cacheCreation}, cacheHitRatio, hookTotalMs, hookShare, compactions, compactionMs.
- breakdown{api,tools,hooks}, apiSeries.points[{t,p50,p95,count}]; models/hooks/tools/skills/subagents/mcpConnections as LatencyStats{name,count,totalMs,p50,p95,maxMs,failures,extra}.
- permissions, errors, recentPrompts.
- Turn: lanes{kind main|subagent|background,title,model}, rows{lane,kind api|tool|hooks|agent|compaction,label,detail,startMs,endMs,ok,pre,post,hookMs}, gaps, activeMs, idleMs, branch, repo.

## Sample values
Hosts: This Mac, studio-mini, ci-runner-02. Repos: claude-performance-analyzer, design-studio, tmuxaxxing. Hooks: `PreToolUse:Bash` (p95 2.8s), `UserPromptSubmit`, `PostToolUse:Edit`, `SessionStart`, `Stop`. Tools: Bash, Read, Edit, Grep, mcp__outline__list_documents, Task. Models: claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5.
