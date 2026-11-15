<script lang="ts">
  // Hooks: table of every hook by total or p95, one selected hook in detail, one selected call.
  import { fmtMs } from "@cpa/analytics";
  import { clock, clockSec, pct } from "../format";
  import { apiUrl } from "../hosts";
  import { PageLoader } from "./loader";
  import type { PageProps } from "./types";
  import { SLOW_P95_MS, callBars, candidateNote, parseSort, pickHook, sortHooks, type CandidateStatus } from "./hooks/logic";

  let { hostId, minutes, summary, tick, params, navigate }: PageProps = $props();

  type Recent = {
    id: number;
    tsMs: number;
    ms: number;
    ok: boolean;
    sessionId: string | null;
    repo: string | null;
    detail: string | null;
    promptId: string | null;
    sessionKind: "interactive" | "headless" | null;
    sessionLabel: string | null;
    branch: string | null;
    pattern: string | null;
    launcher: string | null;
    folder: string | null;
    worktree: boolean;
  };
  type Definition = {
    source: "plugin" | "user" | "project" | "local";
    plugin: string | null;
    matcher: string | null;
    type: string;
    command: string | null;
    summary: string;
    sessions: number;
    configPath: string | null;
    timeoutSec: number | null;
  };
  type Pattern = { key: string; label: string; count: number; errors: number; p95: number };
  type HookItem = {
    name: string;
    count: number;
    failures: number;
    totalMs: number;
    p50: number;
    p95: number;
    maxMs: number;
    headlessCount: number;
    repos: { name: string | null; root: string | null; label: string; count: number; totalMs: number; p95: number }[];
    recent: Recent[];
    failed: Recent[];
    definitions: Definition[];
    patterns?: Pattern[];
    finding?: string | null;
    hiddenByHeadless?: { calls: number; errors: number } | null;
  };
  type HookCallDetail = {
    call: Recent;
    name: string;
    session: { kindLabel: string | null; terminal: string | null; claudeVersion: string | null; launcher: string | null; sessionId: string | null };
    candidates: { status: CandidateStatus; scripts: Definition[] };
    hint: string | null;
  };

  const itemLoader = new PageLoader();
  const callLoader = new PageLoader();
  $effect(() => () => (itemLoader.dispose(), callLoader.dispose()));

  let s = $derived(summary!);
  let sort = $derived(parseSort(params.sort));
  let rows = $derived(sortHooks(s.hooks, sort));
  let selected = $derived(pickHook(s.hooks, params.name));
  let pattern = $derived(params.pattern || undefined);
  let callId = $derived(params.call || undefined);
  let totalMs = $derived(s.hooks.reduce((a, h) => a + h.totalMs, 0));
  let totalCalls = $derived(s.hooks.reduce((a, h) => a + h.count, 0));
  let maxTotal = $derived(Math.max(1, ...s.hooks.map((h) => h.totalMs)));

  let item = $state<HookItem | null>(null);
  let itemError = $state<string | null>(null);
  let itemScope = "";

  $effect(() => {
    tick;
    if (!selected) return;
    const scope = `${hostId}|${minutes}|${selected}|${pattern ?? ""}`;
    // A new selection clears the old detail; a tick refresh keeps it on screen while loading.
    if (scope !== itemScope) {
      item = null;
      itemError = null;
      itemScope = scope;
    }
    itemLoader.load<HookItem>(
      scope,
      apiUrl("/api/item", hostId, { kind: "hooks", name: selected, minutes, excludeHeadless: 1, pattern }),
      (v) => ((item = v), (itemError = null)),
      (err) => (itemError = err),
    );
  });

  let call = $state<HookCallDetail | null>(null);
  let callError = $state<string | null>(null);

  $effect(() => {
    const id = callId;
    const host = hostId;
    call = null;
    callError = null;
    if (!id) return;
    callLoader.load<HookCallDetail>(
      `${host}|${id}`,
      apiUrl("/api/hook-call", host, { id }),
      (v) => (call = v),
      (err, status) => (callError = status === 404 ? "This call is no longer stored." : err),
    );
  });

  // Every navigation keeps the other selections, so Back steps through them one by one.
  function go(next: Record<string, string | undefined>) {
    navigate("hooks", { name: selected ?? undefined, sort: sort === "p95" ? "p95" : undefined, pattern, call: callId, ...next });
  }

  let maxRepoP95 = $derived(Math.max(1, ...(item?.repos ?? []).map((r) => r.p95)));
  let bars = $derived(item ? callBars(item.recent) : []);
  let avgMs = $derived(item && item.count ? item.totalMs / item.count : 0);

  function sourceLabel(d: Definition) {
    return d.plugin ? `plugin ${d.plugin}` : d.source;
  }
  function place(r: Recent) {
    return r.repo ?? r.folder ?? "no repo";
  }
</script>

{#snippet callRow(r: Recent)}
  <tr class="clickable" class:selected={callId === String(r.id)} onclick={() => go({ call: String(r.id) })}>
    <td class="mono muted">{clockSec(r.tsMs)}</td>
    <td class="name">
      {place(r)}
      {#if r.branch}<span class="faint mono"> · {r.branch}</span>{/if}
      {#if r.sessionKind === "headless"}<span class="badge">headless</span>{/if}
    </td>
    <td class="mono muted name">{r.pattern ?? r.detail ?? ""}</td>
    <td class="num" class:warn-text={r.ms > SLOW_P95_MS}>{fmtMs(r.ms)}</td>
    <td class="num">{#if r.ok}<span class="faint">ok</span>{:else}<span class="crit-text">fail</span>{/if}</td>
  </tr>
{/snippet}

{#snippet defList(defs: Definition[])}
  <ol class="defs mono">
    {#each defs as d, i (i)}
      <li>
        <span class="faint">{i + 1}</span>
        <span class="truncate" title={d.command ?? d.summary}>{d.summary}</span>
        <span class="push faint small nowrap">{sourceLabel(d)}{d.timeoutSec !== null ? ` · ${d.timeoutSec}s timeout` : ""}</span>
      </li>
    {/each}
  </ol>
{/snippet}

<div class="stack">
  <section>
    <div class="section-head">
      <h2>All hooks</h2>
      <span class="muted xs">{fmtMs(totalMs)} total · {pct(s.kpis.hookShare)} of in-turn time · {totalCalls} calls</span>
      <div class="seg push sans">
        <button class:on={sort === "total"} onclick={() => go({ sort: undefined })}>By total</button>
        <button class:on={sort === "p95"} onclick={() => go({ sort: "p95" })}>By p95</button>
      </div>
    </div>
    {#if !rows.length}
      <p class="empty">No hooks ran in this window.</p>
    {:else}
      <table>
        <thead>
          <tr><th>Hook</th><th style="width:34%">Total</th><th class="num">Calls</th><th class="num">p50</th><th class="num">p95</th><th class="num">Fail</th></tr>
        </thead>
        <tbody>
          {#each rows as h (h.name)}
            <tr class="clickable" class:selected={h.name === selected} onclick={() => go({ name: h.name, pattern: undefined, call: undefined })}>
              <td class="mono name">
                {#if h.p95 > SLOW_P95_MS}<span class="dot-warn"></span>{/if}{h.name}
              </td>
              <td>
                <div class="row mono">
                  <div class="hbar bg-hooks" style="width:{(h.totalMs / maxTotal) * 70}%"></div>
                  <span>{fmtMs(h.totalMs)}</span>
                </div>
              </td>
              <td class="num">{h.count}</td>
              <td class="num">{fmtMs(h.p50)}</td>
              <td class="num" class:warn-text={h.p95 > SLOW_P95_MS} class:strong={h.p95 > SLOW_P95_MS}>{fmtMs(h.p95)}</td>
              <td class="num" class:crit-text={h.failures > 0} class:faint={!h.failures}>{h.failures}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if selected}
    <section class="detail">
      <div class="detail-head">
        <h2 class="mono">{selected}</h2>
        {#if item}
          <span class="muted xs">
            {item.count} calls · p95 {fmtMs(item.p95)} · max {fmtMs(item.maxMs)} · avg {fmtMs(avgMs)} per call{#if item.failures}
              · <span class="crit-text">{item.failures} failed</span>{/if}
          </span>
        {/if}
      </div>

      {#if itemError}
        <p class="bad pad">Could not load this hook: {itemError}</p>
      {:else if !item}
        <p class="empty pad">Loading...</p>
      {:else}
        {#if item.finding}
          <div class="finding"><b>Finding:</b> {item.finding}</div>
        {/if}
        {#if item.hiddenByHeadless && item.hiddenByHeadless.calls > 0}
          <div class="note muted">
            {item.hiddenByHeadless.calls} calls from headless SDK sessions are hidden{#if item.hiddenByHeadless.errors}, {item.hiddenByHeadless.errors} of them failed{/if}.
          </div>
        {/if}

        {#if !item.count}
          <p class="empty pad">No calls from interactive sessions{pattern ? " with this outcome" : ""} in this window.</p>
        {:else}
          <div class="cells">
            <div class="cell">
              <div class="label">By repo · p95</div>
              <div class="repo-list mono">
                {#each item.repos as r (r.root ?? r.label)}
                  <div class="repo-row" title={`${r.count} calls · ${fmtMs(r.totalMs)} total`}>
                    <span class="truncate">{r.label}</span>
                    <div><div class="hbar" class:bg-warn={r.p95 > SLOW_P95_MS} class:bg-hooks={r.p95 <= SLOW_P95_MS} style="width:{(r.p95 / maxRepoP95) * 100}%"></div></div>
                    <span class="right" class:warn-text={r.p95 > SLOW_P95_MS}>{fmtMs(r.p95)}</span>
                  </div>
                {/each}
              </div>
            </div>
            <div class="cell">
              <div class="label">Commands in this hook · from settings</div>
              {#if !item.definitions.length}
                <p class="empty">No configured commands found for these sessions.</p>
              {:else}
                {@render defList(item.definitions)}
              {/if}
            </div>
          </div>

          {#if item.patterns && item.patterns.length > 1}
            <div class="pad patterns">
              <span class="label">Outcomes</span>
              <button class="chip" class:on={!pattern} onclick={() => go({ pattern: undefined, call: undefined })}>All</button>
              {#each item.patterns as p (p.key)}
                <button class="chip" class:on={pattern === p.key} onclick={() => go({ pattern: p.key, call: undefined })}>
                  {p.label} <span class="faint">· {p.count} · p95 {fmtMs(p.p95)}</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="pad">
            <div class="row baseline">
              <span class="label">Recent calls</span>
              <span class="legend"><span><i class="bg-warn"></i>over 1s</span><span><i class="bg-hooks"></i>under 1s</span></span>
              <span class="push faint small">click a call for details</span>
            </div>
            <div class="callbars">
              {#each bars as b (b.call.id)}
                <button
                  class="callbar"
                  class:bg-warn={b.slow}
                  class:bg-hooks={!b.slow}
                  class:fail={!b.call.ok}
                  class:on={callId === String(b.call.id)}
                  style="height:{b.height}%"
                  title={`${clockSec(b.call.tsMs)} · ${fmtMs(b.call.ms)}${b.call.ok ? "" : " · failed"}`}
                  aria-label={`Call at ${clockSec(b.call.tsMs)}, ${fmtMs(b.call.ms)}`}
                  onclick={() => go({ call: String(b.call.id) })}
                ></button>
              {/each}
            </div>
            {#if bars.length}
              <div class="row mono faint small"><span>{clock(bars[0]!.call.tsMs)}</span><span class="push">{clock(bars.at(-1)!.call.tsMs)}</span></div>
            {/if}
            <table class="calls">
              <tbody>
                {#each item.recent as r (r.id)}{@render callRow(r)}{/each}
              </tbody>
            </table>
          </div>

          {#if item.failed.length}
            <div class="pad">
              <span class="label crit-text">Failed calls</span>
              <table class="calls">
                <tbody>
                  {#each item.failed as r (r.id)}{@render callRow(r)}{/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}

  {#if callId}
    <section class="panel">
      <div class="section-head">
        <h3>Call details</h3>
        <button class="btn link push" onclick={() => go({ call: undefined })}>Close</button>
      </div>
      {#if callError}
        <p class="bad">Could not load this call: {callError}</p>
      {:else if !call}
        <p class="empty">Loading...</p>
      {:else}
        {@const c = call.call}
        <dl class="facts">
          <dt>Hook</dt><dd class="mono">{call.name}</dd>
          <dt>When</dt>
          <dd class="mono">
            {clockSec(c.tsMs)} · <span class:warn-text={c.ms > SLOW_P95_MS}>{fmtMs(c.ms)}</span> ·
            {#if c.ok}ok{:else}<span class="crit-text">failed</span>{/if}
          </dd>
          {#if c.pattern}<dt>Outcome</dt><dd class="mono">{c.pattern}</dd>{/if}
          <dt>Where</dt>
          <dd class="mono">{c.folder ?? place(c)}{c.branch ? ` · ${c.branch}` : ""}{c.worktree ? " · worktree" : ""}</dd>
          <dt>Session</dt>
          <dd>
            {call.session.kindLabel ?? "unknown"}
            {#if call.session.launcher}<span class="muted"> · {call.session.launcher}</span>{/if}
            {#if call.session.terminal}<span class="muted"> · {call.session.terminal}</span>{/if}
            {#if call.session.claudeVersion}<span class="muted mono"> · v{call.session.claudeVersion}</span>{/if}
            {#if call.session.sessionId}<div class="mono faint small">{call.session.sessionId}</div>{/if}
          </dd>
          {#if c.promptId}
            <dt>Turn</dt>
            <dd><a href="#/turns" onclick={(e) => (e.preventDefault(), navigate("turns", { prompt: c.promptId }))}>Open the turn →</a></dd>
          {/if}
        </dl>

        <div class="label" style="margin-top:12px">Candidate scripts</div>
        <p class="muted xs">{candidateNote(call.candidates.status, call.candidates.scripts.length)}</p>
        {#if call.candidates.scripts.length}
          {@render defList(call.candidates.scripts)}
        {/if}
        {#if call.hint}
          <div class="finding hint"><b>Hint:</b> {call.hint}</div>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .sans { font-family: inherit; }
  .nowrap { white-space: nowrap; }
  .detail { border: 1px solid var(--hairline); border-radius: var(--r-lg); overflow: hidden; }
  .detail-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 10px 16px; border-bottom: 1px solid var(--hairline); }
  .pad { padding: 12px 16px; }
  .finding { padding: 10px 16px; font-size: 12px; background: color-mix(in srgb, var(--warn) 10%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
  .finding.hint { margin-top: 10px; border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: var(--r-md); }
  .note { padding: 8px 16px; font-size: 12px; border-bottom: 1px solid var(--hairline); }
  .cells { display: grid; gap: 1px; background: var(--hairline); border-bottom: 1px solid var(--hairline); }
  @media (min-width: 1024px) { .cells { grid-template-columns: 1fr 1fr; } }
  .cell { background: var(--page); padding: 16px; min-width: 0; }
  .label { font-size: 11px; font-weight: 500; color: var(--muted); margin-bottom: 8px; }
  .row .label { margin-bottom: 0; }
  .repo-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .repo-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px 52px; align-items: center; gap: 8px; }
  .hbar { height: 8px; border-radius: 2px; min-width: 2px; flex-shrink: 0; }
  .defs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .defs li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .dot-warn { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); margin-right: 6px; vertical-align: 1px; }
  .strong { font-weight: 600; }
  .patterns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border-bottom: 1px solid var(--hairline); }
  .patterns .label { margin: 0 4px 0 0; }
  .chip { font: inherit; font-family: var(--mono); font-size: 11px; color: var(--ink-3); background: transparent; border: 1px solid var(--hairline-strong); border-radius: var(--r-sm); padding: 1px 7px; cursor: pointer; }
  .chip.on { background: var(--surface); color: var(--ink); border-color: var(--faint); }
  .callbars { display: flex; align-items: flex-end; gap: 2px; height: 56px; margin-top: 8px; }
  .callbar { flex: 1; border: 0; padding: 0; border-radius: 2px 2px 0 0; cursor: pointer; opacity: 0.85; }
  .callbar.bg-hooks { opacity: 0.6; }
  .callbar:hover, .callbar.on { opacity: 1; outline: 1px solid var(--ink-3); }
  .callbar.fail { box-shadow: inset 0 2px 0 var(--critical); }
  .calls { margin-top: 8px; }
  .facts { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 12px; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
</style>
