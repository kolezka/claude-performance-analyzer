<script lang="ts">
  // Turns: every turn in the window with active vs idle time, recent or slowest, filterable.
  // Clicking a row opens its waterfall below the list (URL param `prompt`).
  import { fmtMs, type TurnTimeline } from "@cpa/analytics";
  import Chart from "../Chart.svelte";
  import Kpi from "../Kpi.svelte";
  import { WF_ROW_H, WF_VISIBLE_ROWS, palette, waterfallOption, waterfallTitle } from "../charts";
  import { clock, clockSec, pct } from "../format";
  import { apiUrl } from "../hosts";
  import { PageLoader } from "./loader";
  import type { PageProps } from "./types";
  import {
    PAGE_STEP,
    canLoadMore,
    filterByRepo,
    limitFor,
    nextLimit,
    repoOptions,
    shares,
    sortFrom,
    turnLabel,
    type TurnListItem,
  } from "./turns/logic";

  let { hostId, minutes, summary, tick, params, navigate }: PageProps = $props();

  type TurnDetail = TurnTimeline & {
    sessionKind: string | null;
    sessionLabel: string | null;
    repo: string | null;
    folder: string | null;
    branch: string | null;
    gaps: { startMs: number; endMs: number }[];
    activeMs: number;
    idleMs: number;
    breakdown: { apiMs: number; toolMs: number; hookMs: number };
  };

  let sort = $derived(sortFrom(params));
  let repo = $derived(params.repo || null);
  let hideHeadless = $derived(params.headless === "hide");
  let promptId = $derived(params.prompt || null);

  let requested = $state(PAGE_STEP);
  let limit = $derived(limitFor(requested, repo));

  const listLoader = new PageLoader();
  const detailLoader = new PageLoader();
  let turns = $state<TurnListItem[] | null>(null);
  let listError = $state<string | null>(null);
  let detail = $state<TurnDetail | null | undefined>(undefined);
  let detailError = $state<string | null>(null);

  $effect(() => {
    tick;
    const scope = `${hostId}|${minutes}|${sort}|${hideHeadless}|${limit}`;
    listLoader.load<TurnListItem[]>(
      scope,
      apiUrl("/api/turns", hostId, { minutes, sort, limit, excludeHeadless: hideHeadless ? 1 : undefined }),
      (list) => {
        turns = list;
        listError = null;
      },
      (err) => (listError = err),
    );
  });

  // A new host, window or selection starts from a blank detail; a tick refresh keeps the old one on screen.
  let detailScope = $derived(`${hostId}|${minutes}|${promptId}`);
  let shownScope = "";
  $effect(() => {
    tick;
    const scope = detailScope;
    if (!promptId) {
      detail = undefined;
      return;
    }
    if (scope !== shownScope) {
      shownScope = scope;
      detail = undefined;
      detailError = null;
    }
    detailLoader.load<TurnDetail | null>(
      scope,
      apiUrl("/api/turn", hostId, { prompt: promptId }),
      (t) => {
        detail = t;
        detailError = null;
      },
      (err) => (detailError = err),
    );
  });

  $effect(() => () => {
    listLoader.dispose();
    detailLoader.dispose();
  });

  let shown = $derived(turns ? filterByRepo(turns, repo) : null);
  let repos = $derived(repoOptions(turns ?? [], repo));
  let moreAvailable = $derived(!!turns && canLoadMore(limit, turns.length, repo));
  let totalPrompts = $derived(summary?.kpis.prompts ?? 0);

  function go(next: Record<string, string | null | undefined>) {
    navigate("turns", { sort: sort === "slowest" ? "slowest" : null, repo, headless: hideHeadless ? "hide" : null, prompt: promptId, ...next });
  }

  function select(t: TurnListItem) {
    go({ prompt: t.promptId === promptId ? null : t.promptId });
  }

  let pal = $derived.by(() => {
    summary;
    return palette();
  });
  let wfOpt = $derived(detail && detail.spans.length ? waterfallOption(pal, detail) : null);
  let wfHeight = $derived(detail && detail.spans.length ? `${Math.min(detail.spans.length, WF_VISIBLE_ROWS) * WF_ROW_H + 40}px` : undefined);
  let detailShares = $derived(detail ? shares(detail.breakdown) : null);
  let detailWall = $derived(detail ? detail.endMs - detail.startMs : 0);
</script>

<div class="stack">
  <section>
    <div class="row toolbar">
      <div class="seg sans">
        <button class:on={sort === "recent"} onclick={() => go({ sort: null })}>Recent</button>
        <button class:on={sort === "slowest"} onclick={() => go({ sort: "slowest" })}>Slowest</button>
      </div>
      <select class="input" value={repo ?? ""} onchange={(e) => go({ repo: (e.currentTarget as HTMLSelectElement).value || null })}>
        <option value="">All repos</option>
        {#each repos as r (r)}<option value={r}>{r}</option>{/each}
      </select>
      <label class="check"><input type="checkbox" checked={!hideHeadless} onchange={(e) => go({ headless: (e.currentTarget as HTMLInputElement).checked ? null : "hide" })} /> include headless</label>
      <span class="push xs muted">{totalPrompts} turns · active time excludes waiting on you</span>
    </div>

    {#if listError}
      <p class="bad">Could not load turns: {listError}</p>
    {:else if !shown}
      <p class="empty">Loading...</p>
    {:else if !shown.length}
      <p class="empty">{repo ? `No turns in ${repo} in this window.` : "No turns in this window."}</p>
    {:else}
      <table>
        <thead>
          <tr><th>Started</th><th>Turn</th><th>Repo</th><th style="width:30%">Model · tools · hooks</th><th class="num">Active</th><th class="num">Idle</th></tr>
        </thead>
        <tbody>
          {#each shown as t (t.promptId)}
            {@const s = shares(t)}
            <tr class="clickable" class:running={t.inProgress} class:selected={t.promptId === promptId} onclick={() => select(t)}>
              <td class="mono muted">{clock(t.startMs)}</td>
              <td class="name" class:mono={!!t.command}>{turnLabel(t)}</td>
              <td class="muted name" title={t.folder ?? undefined}>
                {t.repo ?? "no repo"}
                {#if t.sessionKind === "headless"}<span class="badge">headless</span>{/if}
              </td>
              <td>
                <div class="stackbar">
                  {#if s.empty && !t.inProgress}
                    <i class="bg-muted" style="width:100%"></i>
                  {:else}
                    <i class="bg-api" style="width:{s.api}%"></i><i class="bg-tools" style="width:{s.tools}%"></i><i class="bg-hooks" style="width:{s.hooks}%"></i>
                  {/if}
                </div>
              </td>
              {#if t.inProgress}
                <td class="num api-text">running {fmtMs(t.wallMs)}</td>
                <td class="num faint">·</td>
              {:else}
                <td class="num" class:strong={t.promptId === promptId}>{fmtMs(t.activeMs)}</td>
                <td class="num faint">{fmtMs(t.idleMs)}</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="xs muted foot">
        Showing {shown.length}{repo ? ` in ${repo}` : ""}{!repo && !hideHeadless && totalPrompts > shown.length ? ` of ${totalPrompts}` : ""}
        {#if moreAvailable}
          · <button class="btn link" onclick={() => (requested = nextLimit(limit))}>load more</button>
        {:else if turns && turns.length >= limit && limit >= 50}
          · newest 50 by this sort
        {/if}
      </div>
    {/if}
  </section>

  {#if promptId}
    <section>
      <div class="section-head">
        <h2>{detail ? waterfallTitle(detail) : "Turn"}</h2>
        <button class="btn link push" onclick={() => go({ prompt: null })}>Close</button>
      </div>
      {#if detailError}
        <p class="bad">Could not load this turn: {detailError}</p>
      {:else if detail === undefined}
        <p class="empty">Loading...</p>
      {:else if detail === null}
        <p class="empty">This turn has no events on this host. It may be older than the stored data.</p>
      {:else}
        <p class="xs muted">
          {detail.repo ?? "no repo"}{detail.branch ? ` · ${detail.branch}` : ""}{detail.folder ? ` · ${detail.folder}` : ""}{detail.sessionLabel
            ? ` · ${detail.sessionLabel}`
            : ""} · started {clockSec(detail.startMs)}
        </p>
        <div class="kpi-grid cols-4">
          <Kpi label="Active" value={fmtMs(detail.activeMs)} sub={detailWall ? `${pct(detail.activeMs / detailWall)} of wall clock` : ""} />
          <Kpi
            label="Idle"
            value={fmtMs(detail.idleMs)}
            sub={detail.gaps.length ? `${detail.gaps.length} gap${detail.gaps.length === 1 ? "" : "s"}, waiting on you` : "no gaps"}
          />
          <Kpi label="Wall clock" value={fmtMs(detailWall)} sub={`${clockSec(detail.startMs)} to ${clockSec(detail.endMs)}`} />
          <Kpi label="Spans" value={String(detail.spans.length)} sub={`${detail.lanes.length} lane${detail.lanes.length === 1 ? "" : "s"}`} />
        </div>

        {#if detailShares && !detailShares.empty}
          <div>
            <div class="stackbar tall">
              <i class="bg-api" style="width:{detailShares.api}%"></i><i class="bg-tools" style="width:{detailShares.tools}%"></i><i
                class="bg-hooks"
                style="width:{detailShares.hooks}%"
              ></i>
            </div>
            <div class="legend">
              <span><i class="bg-api"></i>Model (API) {fmtMs(detail.breakdown.apiMs)}</span>
              <span><i class="bg-tools"></i>Tools {fmtMs(detail.breakdown.toolMs)}</span>
              <span><i class="bg-hooks"></i>Hooks {fmtMs(detail.breakdown.hookMs)}</span>
              <span><i class="bg-muted"></i>Agents, compaction</span>
            </div>
          </div>
        {/if}

        <div class="chart-frame">
          <Chart id="c-waterfall" option={wfOpt} height={wfHeight} notMerge empty="No timed spans in this turn." />
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .toolbar {
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 8px;
  }
  .seg.sans {
    font-family: inherit;
  }
  .foot {
    margin-top: 8px;
  }
  .strong {
    font-weight: 600;
  }
  .stackbar.tall {
    height: 10px;
    margin-bottom: 6px;
  }
  section > * + * {
    margin-top: 12px;
  }
  .section-head + * {
    margin-top: 0;
  }
</style>
