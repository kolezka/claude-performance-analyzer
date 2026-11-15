<script lang="ts">
  // Telemetry settings: which telemetry env keys this Mac's Claude Code settings have, a button
  // that adds the missing ones (POST /api/setup), and what the collector reports for this host.
  import type { EnvPlan } from "@cpa/claude-settings";
  import { apiUrl } from "../hosts";
  import { PageLoader } from "./loader";
  import { applyLabel, bannerText, keyRows, missingImpact } from "./settings/keys";
  import type { PageProps } from "./types";

  let { hostId, hostName, tick, setup, onSetupChanged }: PageProps = $props();

  type Note = { kind: "ok"; added: string[]; backup: string | null } | { kind: "bad"; message: string } | null;
  type Status = { label: string; state: string; tooltip: string; values: Record<string, string> };

  // Seeded from App's fetch, refreshed on mount. A failed refetch keeps the old plan.
  let plan = $state<EnvPlan | null>(null);
  let planError = $state<string | null>(null);
  let planLoading = $state(true);
  let note = $state<Note>(null);
  let applying = $state(false);

  $effect.pre(() => {
    if (plan === null && setup) plan = setup;
  });

  async function loadPlan() {
    planLoading = true;
    try {
      const res = await fetch("/api/setup");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      plan = (await res.json()) as EnvPlan;
      planError = null;
      onSetupChanged(plan);
    } catch (err) {
      planError = (err as Error).message;
    } finally {
      planLoading = false;
    }
  }

  $effect(() => {
    loadPlan();
  });

  async function apply() {
    if (!plan) return;
    applying = true;
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      plan = out.plan as EnvPlan;
      note = { kind: "ok", added: out.added, backup: out.backup ?? null };
      onSetupChanged(plan);
    } catch (err) {
      note = { kind: "bad", message: (err as Error).message };
    } finally {
      applying = false;
    }
  }

  // Collector status for the selected host (last 15 minutes, same as the menu bar).
  const loader = new PageLoader();
  let status = $state<Status | null>(null);
  let statusError = $state<string | null>(null);

  $effect(() => {
    tick;
    const scope = hostId;
    loader.load<Status>(
      scope,
      apiUrl("/api/status", hostId),
      (s) => {
        status = s;
        statusError = null;
      },
      (err) => (statusError = err),
    );
  });
  $effect(() => () => loader.dispose());

  let rows = $derived(plan ? keyRows(plan) : []);
  let banner = $derived(plan ? bannerText(plan) : null);
  let origin = typeof location === "undefined" ? "" : location.origin;

  const VALUE_LABELS: Record<string, string> = {
    apiP50: "API p50",
    apiP95: "API p95",
    turnP50: "Turn p50",
    ttftP50: "First token p50",
    cost: "Cost",
    cacheHit: "Cache hit",
    requests: "API requests",
  };
</script>

<div class="stack">
  {#if !plan}
    {#if planLoading}
      <p class="empty">Loading settings...</p>
    {:else}
      <p class="bad">Cannot load settings: {planError ?? "no answer"}</p>
      <button class="btn" onclick={loadPlan}>Retry</button>
    {/if}
  {:else}
    {#if planError}
      <p class="small bad">Refresh failed: {planError}. Showing the last known state.</p>
    {/if}

    {#if banner}
      <section class="panel {plan.error ? 'crit' : 'warn'} xs" id="setup">
        {#if plan.error}
          <h3>{banner}</h3>
          <p class="bad">{plan.error}</p>
          <div class="muted">Fix <code>{plan.path}</code> by hand, then reload this page.</div>
        {:else}
          <h3>{banner} <code>{plan.path}</code></h3>
          {#if plan.missing.length}
            <div class="muted">
              {missingImpact(plan)} Existing values are never changed. A backup is written first.
            </div>
            <button id="setup-apply" class="btn primary apply" disabled={applying} onclick={apply}>
              {applyLabel(plan.missing.length, applying)}
            </button>
          {/if}
          {#if plan.conflicts.length}
            <p class="muted">
              Left unchanged, already set to another value:
              {#each plan.conflicts as k, i}{i > 0 ? " " : ""}<code class="key">{k}</code>{/each}. Data may not reach this dashboard
              until you change them by hand.
            </p>
          {/if}
        {/if}
      </section>
    {/if}

    {#if note?.kind === "ok"}
      <p class="ok xs">
        {#if note.added.length}
          Added {#each note.added as k, i}{i > 0 ? " " : ""}<code class="key">{k}</code>{/each}.{#if note.backup}
            Backup: <code>{note.backup}</code>.{/if} Restart Claude Code sessions to start sending data.
        {:else}
          Nothing to add, every setting is already there.
        {/if}
      </p>
    {:else if note?.kind === "bad"}
      <p class="bad xs">Update failed: {note.message}</p>
    {/if}

    <section>
      <div class="section-head">
        <h2>Telemetry settings on This Mac</h2>
        <span class="push">{plan.exists ? "" : "settings.json does not exist yet, it will be created"}</span>
      </div>
      {#if plan.error}
        <p class="empty">Key status is unknown until settings.json can be read.</p>
      {:else if !rows.length}
        <p class="empty">The collector wants no settings.</p>
      {:else}
        <table>
          <thead><tr><th>Key</th><th>Needed for</th><th class="right">Status</th></tr></thead>
          <tbody>
            {#each rows as r (r.key)}
              <tr>
                <td class="mono">{r.key}</td>
                <td class="muted">{r.neededFor}</td>
                <td class="right {r.status === 'set' ? 'ok-text' : 'warn-text'}">
                  {r.status === "conflict" ? "other value" : r.status}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="small faint">Values are not shown. The env block can hold secrets, so only key names leave the collector.</p>
      {/if}
    </section>
  {/if}

  <section class="grid-2">
    <div class="panel flat xs">
      <h2>Collector</h2>
      <dl class="facts">
        <dt class="muted">Endpoint</dt>
        <dd class="mono">{origin || "unknown"}</dd>
        <dt class="muted">Host</dt>
        <dd>{hostName}</dd>
        {#if statusError}
          <dt class="muted">Status</dt>
          <dd class="bad">{statusError}</dd>
        {:else if !status}
          <dt class="muted">Status</dt>
          <dd class="faint">loading...</dd>
        {:else}
          <dt class="muted">Last 15 min</dt>
          <dd class={status.state === "slow" ? "warn-text" : status.state === "ok" ? "ok-text" : "faint"}>
            {status.state === "idle" ? "idle, no API requests" : status.state}
          </dd>
          {#each Object.entries(status.values) as [key, value] (key)}
            <dt class="muted">{VALUE_LABELS[key] ?? key}</dt>
            <dd class="mono">{value}</dd>
          {/each}
        {/if}
      </dl>
    </div>
    <div class="panel flat xs">
      <h2>Last backup</h2>
      {#if note?.kind === "ok" && note.backup}
        <div class="mono backup">{note.backup}</div>
        <div class="muted">written before the change just made</div>
      {:else}
        <p class="empty">No backup in this session. One is written before every change.</p>
      {/if}
    </div>
  </section>
</div>

<style>
  .apply {
    margin-top: 12px;
  }
  .facts {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    row-gap: 6px;
    margin: 8px 0 0;
  }
  .facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .backup {
    margin-top: 8px;
    overflow-wrap: anywhere;
  }
</style>
