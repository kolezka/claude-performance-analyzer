<script lang="ts">
  // Errors: counters for API errors, tool failures, denials and compactions, then every error
  // source grouped by item, then recent failed tool and hook calls that can open their turn.
  import { fmtMs } from "@cpa/analytics";
  import Kpi from "../Kpi.svelte";
  import { clockSec } from "../format";
  import { apiUrl } from "../hosts";
  import { counters, failedTargets, groups, mergeFailed, type ErrorKind, type FailedCall } from "./errors/model";
  import { PageLoader } from "./loader";
  import type { PageProps } from "./types";

  let { hostId, minutes, summary, tick, navigate }: PageProps = $props();

  type Recent = { id: number; tsMs: number; ms: number; detail: string | null; repo: string | null; promptId: string | null };
  type ItemDetail = { failed: Recent[] };

  let s = $derived(summary!);
  let cards = $derived(counters(s, fmtMs));
  let rows = $derived(groups(s, fmtMs));
  let targets = $derived(failedTargets(s));

  const loader = new PageLoader();
  let failed = $state<FailedCall[] | null>(null);
  let failedError = $state<string | null>(null);

  $effect(() => {
    tick;
    const list = targets;
    const scope = `${hostId}|${minutes}|${list.map((t) => `${t.kind}:${t.name}`).join(",")}`;
    if (!list.length) {
      loader.dispose();
      failed = [];
      failedError = null;
      return;
    }
    const parts: FailedCall[][] = list.map(() => []);
    let pending = list.length;
    let error: string | null = null;
    list.forEach((t, i) => {
      loader.load<ItemDetail>(
        scope,
        apiUrl("/api/item", hostId, { kind: t.kind, name: t.name, minutes, excludeHeadless: 1 }),
        (d) => {
          parts[i] = d.failed.map((r) => ({ ...r, kind: t.kind === "tools" ? "tool" : "hook", name: t.name }));
          if (--pending === 0) finish(parts, error);
        },
        (err) => {
          error = err;
          if (--pending === 0) finish(parts, error);
        },
      );
    });
  });
  $effect(() => () => loader.dispose());

  function finish(parts: FailedCall[][], error: string | null) {
    const merged = mergeFailed(parts);
    // A partial answer still shows what loaded; the error only wins when nothing did.
    failedError = merged.length ? null : error;
    failed = merged;
  }

  const LABEL: Record<ErrorKind, string> = { api: "api", tool: "tool", hook: "hook", mcp: "mcp", denied: "denied", compact: "compact" };
  const BADGE: Record<ErrorKind, string> = { api: "crit", tool: "warn", hook: "warn", mcp: "crit", denied: "", compact: "api" };
</script>

<div class="stack">
  <section class="kpi-grid cols-4">
    {#each cards as c (c.label)}
      <Kpi label={c.label} value={String(c.value)} sub={c.sub} flag={c.value > 0 && c.label !== "Compactions"} />
    {/each}
  </section>

  <section>
    <div class="section-head">
      <h2>Errors</h2>
      <span class="push">grouped by source, most first within each</span>
    </div>
    {#if !rows.length}
      <p class="empty">No errors, failures, denials or compactions in this window.</p>
    {:else}
      <table>
        <thead>
          <tr><th style="width:80px">Kind</th><th>Source</th><th>Detail</th><th class="num">Count</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as r (`${r.kind}|${r.title}`)}
            {@const link = r.link}
            <tr class:clickable={!!link} onclick={() => link && navigate(link.page, { name: link.name })}>
              <td><span class="badge {BADGE[r.kind]}">{LABEL[r.kind]}</span></td>
              <td class="name" class:mono={r.kind === "tool" || r.kind === "hook" || r.kind === "mcp"}>{r.title}</td>
              <td class="muted">{r.note}</td>
              <td class="num">{r.count}</td>
              <td class="right">
                {#if link}
                  <a href="#/{link.page}" onclick={(e) => (e.preventDefault(), e.stopPropagation(), navigate(link.page, { name: link.name }))}
                    >{link.page === "tools" ? "Open tool" : "Open hook"}</a
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if targets.length}
    <section>
      <div class="section-head">
        <h2>Recent failed calls</h2>
        <span class="push">newest first, top failing tools and hooks</span>
      </div>
      {#if failedError}
        <p class="bad">Could not load failed calls: {failedError}</p>
      {:else if !failed}
        <p class="empty">Loading...</p>
      {:else if !failed.length}
        <p class="empty">No failed calls outside headless sessions in this window.</p>
      {:else}
        <table>
          <thead>
            <tr><th style="width:90px">Time</th><th style="width:60px">Kind</th><th>Call</th><th>Repo</th><th class="num">Took</th><th></th></tr>
          </thead>
          <tbody>
            {#each failed as f (f.id)}
              {@const prompt = f.promptId}
              <tr class:clickable={!!prompt} onclick={() => prompt && navigate("turns", { prompt })}>
                <td class="mono muted">{clockSec(f.tsMs)}</td>
                <td><span class="badge warn">{f.kind}</span></td>
                <td class="name">
                  <span class="mono">{f.name}</span>
                  {#if f.detail && f.detail !== f.name && !f.name.startsWith(f.detail)}<span class="muted mono">{f.detail}</span>{/if}
                </td>
                <td class="muted name">{f.repo ?? "no repo"}</td>
                <td class="num">{fmtMs(f.ms)}</td>
                <td class="right">
                  {#if prompt}
                    <a href="#/turns" onclick={(e) => (e.preventDefault(), e.stopPropagation(), navigate("turns", { prompt }))}>Open turn</a>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}
</div>
