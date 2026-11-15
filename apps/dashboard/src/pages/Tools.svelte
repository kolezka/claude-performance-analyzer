<script lang="ts">
  // Tools & MCP: tool table, MCP connects, skills, subagents, permissions. ?name= opens one tool or subagent.
  import { fmtMs } from "@cpa/analytics";
  import { clockSec, pct, usd } from "../format";
  import { apiUrl } from "../hosts";
  import { PageLoader } from "./loader";
  import { barWidth, extraNum, mcpHealth, selectionFrom, splitPermission, splitToolLabel, toolShare, totals } from "./tools/logic";
  import type { PageProps } from "./types";

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
    sessionKind: string | null;
    sessionLabel: string | null;
    branch: string | null;
  };
  type Item = {
    kind: string;
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
  };

  let s = $derived(summary!);
  let tools = $derived(s.tools);
  let tot = $derived(totals(tools));
  let maxTool = $derived(Math.max(1, ...tools.map((t) => t.totalMs)));
  let maxAgent = $derived(Math.max(1, ...s.subagents.map((a) => a.totalMs)));
  let skills = $derived([...s.skills].sort((a, b) => extraNum(b, "activations") + b.count - (extraNum(a, "activations") + a.count)));
  let permTotal = $derived(s.permissions.reduce((n, [, c]) => n + c, 0));
  let sel = $derived(selectionFrom(params));

  const loader = new PageLoader();
  let item = $state<Item | null>(null);
  let itemError = $state<string | null>(null);
  let loadedScope: string | null = null;

  $effect(() => {
    tick;
    const cur = sel;
    if (!cur) {
      loader.dispose();
      item = null;
      itemError = null;
      loadedScope = null;
      return;
    }
    const scope = `${hostId}|${minutes}|${cur.kind}|${cur.name}`;
    // A new selection clears the old answer; a tick refresh keeps it on screen until the new one lands.
    if (scope !== loadedScope) {
      item = null;
      itemError = null;
      loadedScope = scope;
    }
    loader.load<Item>(
      scope,
      apiUrl("/api/item", hostId, { kind: cur.kind, name: cur.name, minutes, excludeHeadless: 1 }),
      (v) => {
        item = v;
        itemError = null;
      },
      (err) => (itemError = err),
    );
  });
  $effect(() => () => loader.dispose());

  function open(kind: "tools" | "agents", name: string) {
    navigate("tools", kind === "agents" ? { name, kind } : { name });
  }
  function isSel(kind: "tools" | "agents", name: string) {
    return sel?.kind === kind && sel.name === name;
  }
</script>

<div class="stack">
  {#if sel}
    <section class="panel detail">
      <div class="section-head">
        <h2 class="truncate">{sel.name}</h2>
        <span class="badge">{sel.kind === "agents" ? "subagent" : "tool"}</span>
        <button class="btn link push" onclick={() => navigate("tools")}>Close</button>
      </div>
      {#if itemError}
        <p class="bad">Could not load {sel.name}: {itemError}</p>
      {:else if !item}
        <p class="empty">Loading...</p>
      {:else if !item.count}
        <p class="empty">No calls in this window{item.headlessCount ? ` (${item.headlessCount} from headless sessions hidden)` : ""}.</p>
      {:else}
        <div class="kpi-grid cols-4">
          <div class="kpi">
            <div class="label">Calls</div>
            <div class="value">{item.count}</div>
            <div class="sub">{item.headlessCount ? `${item.headlessCount} headless hidden` : "interactive sessions"}</div>
          </div>
          <div class="kpi"><div class="label">Total</div><div class="value">{fmtMs(item.totalMs)}</div><div class="sub">max {fmtMs(item.maxMs)}</div></div>
          <div class="kpi"><div class="label">p50</div><div class="value">{fmtMs(item.p50)}</div><div class="sub">p95 {fmtMs(item.p95)}</div></div>
          <div class="kpi" class:flag={item.failures > 0}>
            <div class="label">Failures</div>
            <div class="value" class:crit-text={item.failures > 0}>{item.failures}</div>
            <div class="sub">{pct(item.failures / item.count)} of calls</div>
          </div>
        </div>

        <div class="grid-2 detail-lists">
          <div>
            <h3>By repo</h3>
            <table>
              <thead><tr><th>Repo</th><th class="num">Calls</th><th class="num">Total</th><th class="num">p95</th></tr></thead>
              <tbody>
                {#each item.repos as r (r.root ?? r.label)}
                  <tr>
                    <td class="name" class:muted={!r.name} title={r.root ?? ""}>{r.label}</td>
                    <td class="num">{r.count}</td>
                    <td class="num">{fmtMs(r.totalMs)}</td>
                    <td class="num">{fmtMs(r.p95)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div>
            <h3>Failed calls</h3>
            {#if !item.failed.length}
              <p class="empty">No failed calls.</p>
            {:else}
              {@render calls(item.failed)}
            {/if}
          </div>
        </div>
        <div>
          <h3>Recent calls</h3>
          {@render calls(item.recent)}
        </div>
      {/if}
    </section>
  {/if}

  <section>
    <div class="section-head">
      <h2>Tools</h2>
      <span class="muted xs">{fmtMs(tot.totalMs)} total · {pct(toolShare(s.breakdown))} of in-turn time · {tot.count} calls</span>
    </div>
    {#if !tools.length}
      <p class="empty">No tool calls in this window.</p>
    {:else}
      <table>
        <thead>
          <tr><th>Tool</th><th style="width:34%">Total</th><th class="num">Calls</th><th class="num">p50</th><th class="num">p95</th><th class="num">Fail</th></tr>
        </thead>
        <tbody class="mono">
          {#each tools as t (t.name)}
            {@const l = splitToolLabel(t.name)}
            <tr class="clickable" class:selected={isSel("tools", t.name)} onclick={() => open("tools", t.name)}>
              <td class="name" title={t.name}>{l.main}{#if l.hint}<span class="hint">({l.hint})</span>{/if}</td>
              <td>
                <div class="row"><div class="bar bg-tools" style="width:{barWidth(t.totalMs, maxTool)}"></div><span>{fmtMs(t.totalMs)}</span></div>
              </td>
              <td class="num">{t.count}</td>
              <td class="num">{fmtMs(t.p50)}</td>
              <td class="num">{fmtMs(t.p95)}</td>
              <td class="num" class:crit-text={t.failures > 0} class:faint={!t.failures}>{t.failures}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section class="grid-2">
    <div>
      <div class="section-head"><h2>MCP servers</h2><span class="push">connect time at session start</span></div>
      {#if !s.mcpConnections.length}
        <p class="empty">No MCP server connects in this window.</p>
      {:else}
        <div class="list">
          {#each s.mcpConnections as m (m.name)}
            {@const h = mcpHealth(m)}
            <div class="row item" title={`p95 ${fmtMs(m.p95)} · max ${fmtMs(m.maxMs)}`}>
              <span class="dot" class:bg-hooks={h === "ok"} class:bg-warn={h === "warn"} class:bg-crit={h === "crit"}></span>
              <span class="mono truncate">{m.name}</span>
              <span class="muted">{m.count} {m.count === 1 ? "connect" : "connects"}</span>
              <span class="mono push" class:warn-text={m.p50 > 2000}>{fmtMs(m.p50)}</span>
              <span class="mono" class:crit-text={m.failures > 0} class:faint={!m.failures}>{m.failures} failed</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div>
      <div class="section-head"><h2>Skills</h2><span class="push">loads in this window</span></div>
      {#if !skills.length}
        <p class="empty">No skills loaded in this window.</p>
      {:else}
        <div class="list mono">
          {#each skills as k (k.name)}
            {@const cost = extraNum(k, "costUsd")}
            <div class="row item">
              <span class="truncate">{k.name}</span>
              {#if k.count}
                <span class="muted xs" title="API requests made while this skill was active">{k.count} req · {fmtMs(k.totalMs)}{cost ? ` · ${usd(cost)}` : ""}</span>
              {/if}
              <span class="push">{extraNum(k, "activations")}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <section class="grid-2">
    <div>
      <div class="section-head"><h2>Subagents</h2><span class="push">runs · total · p95 · tool uses</span></div>
      {#if !s.subagents.length}
        <p class="empty">No subagents finished in this window.</p>
      {:else}
        <div class="barlist">
          {#each s.subagents as a (a.name)}
            <a href="#/tools" class="agent" class:on={isSel("agents", a.name)} onclick={(e) => (e.preventDefault(), open("agents", a.name))}>
              <div class="row">
                <span class="truncate">{a.name}</span>
                <span class="push">{a.count}× · {fmtMs(a.totalMs)} · {fmtMs(a.p95)} · {extraNum(a, "toolUses")}</span>
              </div>
              <div class="meter"><i class="bg-tools" style="width:{barWidth(a.totalMs, maxAgent)}"></i></div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
    <div>
      <div class="section-head"><h2>Permissions</h2><span class="push">{permTotal} decisions</span></div>
      {#if !s.permissions.length}
        <p class="empty">No permission decisions in this window.</p>
      {:else}
        <table>
          <thead><tr><th>Source</th><th>Decision</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
          <tbody>
            {#each s.permissions as [key, count] (key)}
              {@const p = splitPermission(key)}
              <tr>
                <td class="mono">{p.source}</td>
                <td><span class="badge" class:ok={p.decision === "accept"} class:crit={p.decision === "reject"}>{p.decision}</span></td>
                <td class="num">{count}</td>
                <td class="num muted">{pct(count / (permTotal || 1))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>
</div>

{#snippet calls(list: Recent[])}
  <table>
    <thead><tr><th>Time</th><th>Detail</th><th>Repo</th><th class="num">Took</th></tr></thead>
    <tbody>
      {#each list as c (c.id)}
        <tr class:clickable={!!c.promptId} onclick={() => c.promptId && navigate("turns", { prompt: c.promptId })} title={c.promptId ? "Open the turn" : ""}>
          <td class="mono muted">{clockSec(c.tsMs)}</td>
          <td class="name mono" class:crit-text={!c.ok}>{c.detail ?? (c.ok ? "ok" : "failed")}</td>
          <td class="name muted">
            {c.repo ?? "no repo"}{#if c.branch}<span class="faint"> · {c.branch}</span>{/if}
            {#if c.sessionKind === "headless"}<span class="badge">headless</span>{/if}
          </td>
          <td class="num">{fmtMs(c.ms)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<style>
  .bar { height: 8px; border-radius: 2px; flex-shrink: 0; }
  .hint { font-family: ui-sans-serif, system-ui, sans-serif; color: var(--muted); margin-left: 6px; }
  .list { border: 1px solid var(--hairline); border-radius: var(--r-lg); font-size: 12px; }
  .list .item { padding: 9px 12px; gap: 12px; }
  .list .item + .item { border-top: 1px solid var(--hairline); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .agent { color: inherit; text-decoration: none; }
  .agent:hover { text-decoration: none; }
  .agent.on .row { color: var(--api); }
  .detail { display: flex; flex-direction: column; gap: 16px; }
  .detail .section-head { margin-bottom: 0; }
  .detail h3 { margin-bottom: 6px; }
  .detail-lists { align-items: start; }
</style>
