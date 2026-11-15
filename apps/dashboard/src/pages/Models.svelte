<script lang="ts">
  // Models: per-model latency cards, overall API latency, token and cache totals.
  import { fmtMs } from "@cpa/analytics";
  import Chart from "../Chart.svelte";
  import { latencyOption, palette } from "../charts";
  import { compact, pct, usd } from "../format";
  import { apiErrors, cacheHitLow, modelCards } from "./models/model-stats";
  import type { PageProps } from "./types";

  let { summary, navigate }: PageProps = $props();

  let s = $derived(summary!);
  let k = $derived(s.kpis);
  let cards = $derived(modelCards(s.models));
  let points = $derived(s.apiSeries.points);
  let pal = $derived.by(() => {
    summary;
    return palette();
  });
  let latencyOpt = $derived(points.some((p) => p.count) ? latencyOption(pal, points) : null);
  let bucketText = $derived(`p50 and p95, ${fmtMs(s.apiSeries.bucketMs)} buckets`);
  let errs = $derived(apiErrors(s.errors));
  let errCount = $derived(errs.reduce((n, [, c]) => n + c, 0));
  let totalInput = $derived(k.tokens.input + k.tokens.cacheRead + k.tokens.cacheCreation);
  let lowHit = $derived(cacheHitLow(k.cacheHitRatio, totalInput));
</script>

<div class="stack">
  {#if !cards.length}
    <p class="empty">No API requests in this window.</p>
  {:else}
    <section class="kpi-grid" id="model-cards">
      {#each cards as m (m.name)}
        <div class="kpi" class:flag={m.failures > 0}>
          <div class="label mono">{m.name}</div>
          <div class="value-row"><span class="value">{fmtMs(m.p50)}</span></div>
          <div class="sub">p50 · p95 {fmtMs(m.p95)} · {m.count} req</div>
          <div class="sub">
            {pct(m.share)} of requests · {usd(m.costUsd)} · {compact(m.output)} out{#if m.failures}<span class="warn-text"> · {m.failures} failed</span>{/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <section>
    <div class="section-head">
      <h2>API latency</h2>
      <span class="push">{bucketText}</span>
    </div>
    <div class="chart-frame">
      <Chart id="c-model-latency" option={latencyOpt} empty="No API requests in this window." />
    </div>
    <p class="empty xs">
      All models combined. A per-model series is not available yet.
      {#if errCount}
        <a href="#/errors" onclick={(e) => (e.preventDefault(), navigate("errors"))}
          ><span class="crit-text">{errs.map(([kind, n]) => `${kind} ×${n}`).join(", ")}</span> in this window →</a
        >
      {/if}
    </p>
  </section>

  <section>
    <div class="section-head">
      <h2>Tokens and cache</h2>
      <span class="push">per model</span>
    </div>
    {#if !k.apiRequests}
      <p class="empty">No API requests in this window.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Scope</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num"
              >Hit</th
            ><th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each cards as m (m.name)}
            <tr>
              <td class="mono name">{m.name}</td>
              <td class="num">{compact(m.input)}</td>
              <td class="num">{compact(m.output)}</td>
              <td class="num">{compact(m.cacheRead)}</td>
              <td class="num">{compact(m.cacheCreation)}</td>
              <td class="num" class:warn-text={m.cacheHit !== null && cacheHitLow(m.cacheHit, 1)}>{m.cacheHit === null ? "-" : pct(m.cacheHit)}</td>
              <td class="num">{usd(m.costUsd)}</td>
            </tr>
          {/each}
          <tr>
            <td class="mono"><strong>All models</strong></td>
            <td class="num">{compact(k.tokens.input)}</td>
            <td class="num">{compact(k.tokens.output)}</td>
            <td class="num">{compact(k.tokens.cacheRead)}</td>
            <td class="num">{compact(k.tokens.cacheCreation)}</td>
            <td class="num" class:warn-text={lowHit}>{pct(k.cacheHitRatio)}</td>
            <td class="num"><strong>{usd(k.costUsd)}</strong></td>
          </tr>
        </tbody>
      </table>
      <p class="empty xs">Hit is cache read over all input tokens.</p>
    {/if}
  </section>
</div>
