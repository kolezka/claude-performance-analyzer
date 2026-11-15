<script lang="ts">
  // Overview: KPIs with sparklines, API latency, slowest turns, hooks and tools by total time.
  import { fmtMs } from "@cpa/analytics";
  import Chart from "../Chart.svelte";
  import Kpi from "../Kpi.svelte";
  import { latencyOption, palette } from "../charts";
  import { compact, pct, usd } from "../format";
  import { apiUrl } from "../hosts";
  import { PageLoader } from "./loader";
  import type { PageProps } from "./types";

  let { hostId, minutes, summary, tick, navigate }: PageProps = $props();

  type TurnItem = {
    promptId: string;
    startMs: number;
    activeMs: number;
    idleMs: number;
    inProgress: boolean;
    sessionKind: string | null;
    repo: string | null;
    command: string | null;
    apiMs: number;
    toolMs: number;
    hookMs: number;
  };

  const loader = new PageLoader();
  let slowest = $state<TurnItem[] | null>(null);
  let turnsError = $state<string | null>(null);

  $effect(() => {
    tick;
    const scope = `${hostId}|${minutes}`;
    loader.load<TurnItem[]>(
      scope,
      apiUrl("/api/turns", hostId, { minutes, sort: "slowest", limit: 5 }),
      (list) => {
        slowest = list;
        turnsError = null;
      },
      (err) => (turnsError = err),
    );
  });
  $effect(() => () => loader.dispose());

  let s = $derived(summary!);
  let k = $derived(s.kpis);
  let points = $derived(s.apiSeries.points);
  let pal = $derived.by(() => {
    summary;
    return palette();
  });
  let latencyOpt = $derived(points.some((p) => p.count) ? latencyOption(pal, points) : null);
  let slowHook = $derived(s.hooks.find((h) => h.p95 > 2000));
  let bucketText = $derived(`${fmtMs(s.apiSeries.bucketMs)} buckets`);
  let hooks = $derived(s.hooks.slice(0, 5));
  let tools = $derived(s.tools.slice(0, 5));
  let maxHook = $derived(Math.max(1, ...hooks.map((h) => h.totalMs)));
  let maxTool = $derived(Math.max(1, ...tools.map((t) => t.totalMs)));

  function share(t: TurnItem, part: number) {
    const total = t.apiMs + t.toolMs + t.hookMs;
    return total ? `${(part / total) * 100}%` : "0%";
  }
</script>

<div class="stack">
  <section class="kpi-grid" id="kpi-row">
    <Kpi label="API latency p50" value={fmtMs(k.apiP50)} sub={`p95 ${fmtMs(k.apiP95)} · ${k.apiRequests} req`} spark={points.map((p) => p.p50)} />
    <Kpi
      label="Turn time p50"
      value={fmtMs(k.turnP50)}
      sub={`${k.prompts} prompts · ${k.sessions} sessions`}
      tip="From interaction spans when traces are on, else first-to-last event per prompt"
    />
    <Kpi
      label="Hook time"
      value={fmtMs(k.hookTotalMs)}
      sub={`${pct(k.hookShare)} of in-turn time`}
      flag={k.hookShare > 0.15 || !!slowHook}
      tip={slowHook ? `Slowest: ${slowHook.name}, p95 ${fmtMs(slowHook.p95)}` : ""}
    />
    <Kpi
      label="Time to first token"
      value={k.ttftP50 === null ? "n/a" : fmtMs(k.ttftP50)}
      na={k.ttftP50 === null}
      sub={k.ttftP50 === null ? "needs traces (beta)" : "p50"}
    />
    <Kpi label="Cost" value={usd(k.costUsd)} sub={`${compact(k.tokens.output)} out · ${compact(k.tokens.input)} in`} />
    <Kpi label="Cache hit" value={pct(k.cacheHitRatio)} sub={`${compact(k.tokens.cacheRead)} read · ${compact(k.tokens.cacheCreation)} write`} />
  </section>

  <section>
    <div class="section-head">
      <h2>API latency</h2>
      <span class="push">{bucketText}</span>
    </div>
    <div class="chart-frame">
      <Chart id="c-latency" option={latencyOpt} empty="No API requests in this window." />
    </div>
  </section>

  <section>
    <div class="section-head">
      <h2>Slowest turns</h2>
      <a class="push" href="#/turns?sort=slowest" onclick={(e) => (e.preventDefault(), navigate("turns", { sort: "slowest" }))}>All {k.prompts} turns →</a>
    </div>
    {#if turnsError}
      <p class="bad">Could not load turns: {turnsError}</p>
    {:else if !slowest}
      <p class="empty">Loading...</p>
    {:else if !slowest.length}
      <p class="empty">No turns in this window.</p>
    {:else}
      <table>
        <thead>
          <tr><th>Turn</th><th>Repo</th><th style="width:38%">Model · tools · hooks</th><th class="num">Active</th><th class="num">Idle</th></tr>
        </thead>
        <tbody>
          {#each slowest as t (t.promptId)}
            <tr class="clickable" class:running={t.inProgress} onclick={() => navigate("turns", { prompt: t.promptId })}>
              <td class="name" class:mono={!!t.command}>{t.command ?? "prompt"}</td>
              <td class="muted name">
                {t.repo ?? "no repo"}
                {#if t.sessionKind === "headless"}<span class="badge">headless</span>{/if}
              </td>
              <td>
                <div class="stackbar">
                  <i class="bg-api" style="width:{share(t, t.apiMs)}"></i><i class="bg-tools" style="width:{share(t, t.toolMs)}"></i><i
                    class="bg-hooks"
                    style="width:{share(t, t.hookMs)}"
                  ></i>
                </div>
              </td>
              <td class="num">{fmtMs(t.activeMs)}</td>
              <td class="num muted">{t.idleMs ? fmtMs(t.idleMs) : "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section class="grid-2">
    <div>
      <div class="section-head">
        <h2>Hooks</h2>
        <a class="push" href="#/hooks" onclick={(e) => (e.preventDefault(), navigate("hooks"))}>total · p95</a>
      </div>
      {#if !hooks.length}
        <p class="empty">No hooks ran in this window.</p>
      {:else}
        <div class="barlist">
          {#each hooks as h (h.name)}
            <a href="#/hooks" onclick={(e) => (e.preventDefault(), navigate("hooks", { name: h.name }))} style="color:inherit;text-decoration:none">
              <div class="row"><span class="truncate">{h.name}</span><span class="push">{fmtMs(h.totalMs)} · <span class:warn-text={h.p95 > 2000}>{fmtMs(h.p95)}</span></span></div>
              <div class="meter"><i class="bg-hooks" style="width:{(h.totalMs / maxHook) * 100}%"></i></div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
    <div>
      <div class="section-head">
        <h2>Tools &amp; MCP</h2>
        <a class="push" href="#/tools" onclick={(e) => (e.preventDefault(), navigate("tools"))}>total · p95</a>
      </div>
      {#if !tools.length}
        <p class="empty">No tool calls in this window.</p>
      {:else}
        <div class="barlist">
          {#each tools as t (t.name)}
            <a href="#/tools" onclick={(e) => (e.preventDefault(), navigate("tools", { name: t.name }))} style="color:inherit;text-decoration:none">
              <div class="row"><span class="truncate">{t.name}</span><span class="push">{fmtMs(t.totalMs)} · {fmtMs(t.p95)}</span></div>
              <div class="meter"><i class="bg-tools" style="width:{(t.totalMs / maxTool) * 100}%"></i></div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  </section>
</div>
