<script lang="ts">
  import { onMount } from "svelte";
  import type { Summary, TurnTimeline } from "@cpa/analytics";
  import { fmtMs } from "@cpa/analytics";
  import Chart from "./Chart.svelte";
  import DataTable from "./DataTable.svelte";
  import Kpi from "./Kpi.svelte";
  import Legend from "./Legend.svelte";
  import Hosts from "./Hosts.svelte";
  import Live from "./Live.svelte";
  import Setup from "./Setup.svelte";
  import { PARTS, WF_ROW_H, WF_VISIBLE_ROWS, breakdownOption, latencyOption, palette, promptsOption, statBarOption, waterfallOption, waterfallTitle } from "./charts";
  import { clock, compact, pct, usd } from "./format";
  import { LOCAL_HOST, LOCAL_HOST_ID, RequestGate, apiUrl, hostFromSearch, hostName, reconcileSelection, searchWithHost, type Host } from "./hosts";

  function safeGet(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function safeSet(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  const WINDOWS: [number, string][] = [
    [15, "15m"],
    [60, "1h"],
    [1440, "24h"],
    [10080, "7d"],
  ];

  let minutes = $state(Number(safeGet("window") ?? 60));
  let summary = $state<Summary | null>(null);
  let loadError = $state<string | null>(null);
  let updatedText = $state("");
  let selectedPromptId: string | null = null;
  let turn = $state<TurnTimeline | null>(null);

  let hostId = $state(hostFromSearch(location.search));
  let hosts = $state<Host[]>([LOCAL_HOST]);
  let hostsError = $state<string | null>(null);
  let hostsLoaded = false;
  // HTTP status of the last failed summary load; null means the collector did not answer at all.
  let loadErrorStatus = $state<number | null>(null);
  let selectedName = $derived(hostName(hosts, hostId));
  // Everything loaded for the selected host goes through this gate, so a switch drops late answers.
  const gate = new RequestGate();
  // Host list requests have their own gate: only the newest list may decide the selection.
  const hostsGate = new RequestGate();

  function selectHost(id: string, history: "push" | "replace" | "none" = "push") {
    // The URL is fixed even when the host stays the same, e.g. Back to a removed host while on This Mac.
    if (history !== "none" && hostFromSearch(location.search) !== id) {
      const url = `${location.pathname}${searchWithHost(location.search, id)}${location.hash}`;
      if (history === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    }
    if (id === hostId) return;
    gate.invalidate();
    hostId = id;
    summary = null;
    turn = null;
    selectedPromptId = null;
    loadError = null;
    updatedText = "";
    load();
  }

  async function refreshHosts() {
    hostsGate.invalidate();
    await hostsGate.run<Host[]>(fetch, "/api/hosts", {
      ok: (list) => {
        hostsError = null;
        hostsLoaded = true;
        hosts = list;
        const next = reconcileSelection(hostId, list);
        if (next !== hostId) selectHost(next, "replace");
      },
      // Keep the selection: a failed list says nothing about whether the host still exists.
      fail: (error) => (hostsError = error),
    });
  }

  function selectWindow(m: number) {
    minutes = m;
    safeSet("window", String(m));
    // Called directly so clicking the active window still refreshes.
    load();
  }

  async function load() {
    await gate.run<Summary>(fetch, apiUrl("/api/summary", hostId, { minutes }), {
      ok: (s) => {
        summary = s;
        loadError = null;
        updatedText = `${s.eventCount} events · ${clock(s.generatedAt)}`;
        if (!selectedPromptId && s.eventCount > 0) loadTurn();
      },
      fail: (error, status) => {
        loadError = error;
        loadErrorStatus = status;
        // Probably deleted in another client: check the list now instead of at the next refresh.
        if (status === 404 && hostId !== LOCAL_HOST_ID) refreshHosts();
      },
    });
  }

  async function loadTurn(promptId?: string) {
    await gate.run<TurnTimeline | null>(fetch, apiUrl("/api/turn", hostId, { prompt: promptId }), { ok: (t) => (turn = t) });
  }

  function selectPrompt(promptId: string) {
    selectedPromptId = promptId;
    loadTurn(promptId);
  }

  // Pushed events trigger a refresh; batch bursts so the summary query runs at most twice a second.
  function loadSoon() {
    gate.soon(load, 500);
  }

  onMount(() => {
    // A remote host from the URL is checked against the list first, so a deleted one falls back
    // to This Mac instead of flashing an error. This Mac loads at once, as before.
    if (hostId === LOCAL_HOST_ID) {
      load();
      refreshHosts();
    } else {
      const requested = hostId;
      // If the list dropped the host, selectHost already loaded This Mac.
      refreshHosts().then(() => {
        if (hostId === requested) load();
      });
    }
    const onPop = () => {
      const wanted = hostFromSearch(location.search);
      const next = hostsLoaded ? reconcileSelection(wanted, hosts) : wanted;
      selectHost(next, next === wanted ? "none" : "replace");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  // Fallback for when the socket is down, and to roll the time window forward.
  $effect(() => {
    const id = setInterval(() => {
      load();
      refreshHosts();
    }, 30_000);
    return () => clearInterval(id);
  });

  // Recompute whenever summary/turn change even though palette() itself reads no Svelte state.
  let pal = $derived.by(() => {
    summary;
    return palette();
  });
  let wfPal = $derived.by(() => {
    turn;
    return palette();
  });

  let breakdownOpt = $derived(summary ? breakdownOption(pal, summary.breakdown) : null);

  let latencyPts = $derived(summary?.apiSeries.points ?? []);
  let latencyOpt = $derived(latencyPts.some((p) => p.count) ? latencyOption(pal, latencyPts) : null);

  let hooksRows = $derived(summary ? summary.hooks.slice(0, 12) : []);
  let hooksOpt = $derived(
    hooksRows.length
      ? statBarOption(pal, hooksRows, "hooks", (r) => [`blocking ${r.extra?.blocking ?? 0}, injected context ${compact(Number(r.extra?.contextChars ?? 0))} chars`])
      : null,
  );
  let hooksHeight = $derived(hooksRows.length ? `${hooksRows.length * 22}px` : undefined);

  let toolsRows = $derived(summary ? summary.tools.slice(0, 12) : []);
  let toolsOpt = $derived(toolsRows.length ? statBarOption(pal, toolsRows, "tools", () => []) : null);
  let toolsHeight = $derived(toolsRows.length ? `${toolsRows.length * 22}px` : undefined);

  let promptsList = $derived(summary?.recentPrompts ?? []);
  let promptsOpt = $derived(promptsList.length ? promptsOption(pal, promptsList) : null);
  let promptsHeight = $derived(promptsList.length ? `${promptsList.length * 22}px` : undefined);

  function onPromptsInit(inst: import("echarts/core").EChartsType) {
    inst.on("click", (params: any) => {
      if (params.componentType !== "series") return;
      const p = promptsList[params.dataIndex as number];
      if (p) selectPrompt(p.promptId);
    });
  }

  let waterfallOpt = $derived(turn && turn.spans.length ? waterfallOption(wfPal, turn) : null);
  let waterfallTitleText = $derived(!turn ? "No recent prompt." : !turn.spans.length ? "No spans recorded." : waterfallTitle(turn));
  let waterfallHeight = $derived(
    turn && turn.spans.length ? `${Math.min(Math.max(1, turn.spans.length), WF_VISIBLE_ROWS) * WF_ROW_H + 40}px` : undefined,
  );

  // KPI tile tooltips (non-chart elements; charts use echarts' own tooltip).
  let tipEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    function onMove(ev: MouseEvent) {
      const el = (ev.target as Element).closest?.("[data-tip]");
      if (!el || !tipEl) {
        if (tipEl) tipEl.style.display = "none";
        return;
      }
      const text = el.getAttribute("data-tip")!;
      tipEl.textContent = text;
      tipEl.style.display = "block";
      const w = tipEl.offsetWidth;
      tipEl.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - w - 8)}px`;
      tipEl.style.top = `${ev.clientY + 14}px`;
    }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  });
</script>

<header>
  <h1>Claude Code speed</h1>
  <nav id="window" role="tablist">
    {#each WINDOWS as [m, label]}
      <button data-min={m} class:on={minutes === m} onclick={() => selectWindow(m)}>{label}</button>
    {/each}
  </nav>
  <label id="host-pick">
    <span class="muted">Host</span>
    <select value={hostId} onchange={(e) => selectHost(e.currentTarget.value)}>
      {#if !hosts.some((h) => h.id === hostId)}
        <option value={hostId}>Loading...</option>
      {/if}
      {#each hosts as h (h.id)}
        <option value={h.id}>{h.name}</option>
      {/each}
    </select>
  </label>
  <span id="updated" class="muted">{updatedText}</span>
</header>

<Setup />
<Hosts {hosts} listError={hostsError} onChanged={refreshHosts} />
<Live {hostId} onData={loadSoon} />

<main id="app">
  {#if loadError}
    <div class="card">
      <h2>{loadErrorStatus === null ? "Collector unreachable" : `Could not load ${selectedName}`}</h2>
      <p class="muted">{loadError}</p>
    </div>
  {:else if !summary}
    <p class="muted">Loading...</p>
  {:else if summary.eventCount === 0 && hostId !== LOCAL_HOST_ID}
    <div class="card">
      <h2>No telemetry from {selectedName} yet</h2>
      <p class="muted">
        Paste the env block shown when this host was added into <code>~/.claude/settings.json</code> on that machine, then restart Claude Code there. The
        token is shown only once: if it is lost, regenerate it under Remote hosts.
      </p>
    </div>
  {:else if summary.eventCount === 0}
    <div class="card">
      <h2>No telemetry yet</h2>
      <p>Use the button above, or start Claude Code with these variables:</p>
      <pre>CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_LOGS_EXPORT_INTERVAL=1000
OTEL_LOG_TOOL_DETAILS=1
# optional, beta: time-to-first-token and turn spans
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_TRACES_EXPORTER=otlp</pre>
    </div>
  {:else}
    {@const k = summary.kpis}
    {@const slowHook = summary.hooks.find((h) => h.p95 > 2000)}
    <section class="kpis" id="kpi-row">
      <Kpi label="API latency p50" value={fmtMs(k.apiP50)} sub={`p95 ${fmtMs(k.apiP95)} · ${k.apiRequests} req`} />
      <Kpi
        label="Turn time p50"
        value={fmtMs(k.turnP50)}
        sub={`${k.prompts} prompts · ${k.sessions} sessions`}
        tip="From interaction spans when traces are on, else first-to-last event per prompt"
      />
      <Kpi label="Time to first token" value={k.ttftP50 === null ? "n/a" : fmtMs(k.ttftP50)} sub={k.ttftP50 === null ? "needs traces (beta)" : "p50"} />
      <Kpi
        label="Hook time"
        value={fmtMs(k.hookTotalMs)}
        sub={`${pct(k.hookShare)} of in-turn time`}
        flag={k.hookShare > 0.15 || !!slowHook}
        tip={slowHook ? `Slowest: ${slowHook.name}, p95 ${fmtMs(slowHook.p95)}` : ""}
      />
      <Kpi label="Cost" value={usd(k.costUsd)} sub={`${compact(k.tokens.output)} out · ${compact(k.tokens.input)} in`} />
      <Kpi label="Cache hit" value={pct(k.cacheHitRatio)} sub={`${compact(k.tokens.cacheRead)} read · ${compact(k.tokens.cacheCreation)} write`} />
    </section>

    <div class="card">
      <h2>Where turn time goes</h2>
      <Legend items={PARTS.map(([c, , l]) => [c, l])} />
      <Chart id="c-breakdown" option={breakdownOpt} />
      <p class="muted" style="margin:4px 0 0;font-size:11px">Summed component time. Parallel tool calls can overlap, so parts may exceed wall clock.</p>
    </div>

    <div class="card">
      <h2>Turn waterfall</h2>
      <div class="muted" id="wf-title" style="font-size:11px;margin-bottom:6px">{waterfallTitleText}</div>
      <Legend
        items={[
          ["--api", "Model (API)"],
          ["--tools", "Tools"],
          ["--hooks", "Hooks"],
          ["--muted", "Agent / compaction"],
        ]}
      />
      <Chart id="c-waterfall" option={waterfallOpt} height={waterfallHeight} empty="No data for this prompt." notMerge={true} />
    </div>

    <div class="card">
      <h2>API latency over time</h2>
      <Chart id="c-latency" option={latencyOpt} empty="No API requests in this window." />
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Hooks by total time</h2>
        <Chart id="c-hooks" option={hooksOpt} height={hooksHeight} notMerge={true} />
      </div>
      <div class="card">
        <h2>Tools, skills, MCP by total time</h2>
        <Chart id="c-tools" option={toolsOpt} height={toolsHeight} notMerge={true} />
      </div>
    </div>

    <div class="card">
      <h2>Recent prompts</h2>
      <Legend items={PARTS.map(([c, , l]) => [c, l])} />
      <Chart id="c-prompts" option={promptsOpt} height={promptsHeight} empty="No prompts in this window." notMerge={true} onInit={onPromptsInit} />
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Skills</h2>
        <div id="t-skills">
          <DataTable
            headers={["Skill", "Activations", "API calls", "API time", "Cost"]}
            rows={summary.skills.map((r) => [r.name, r.extra?.activations ?? 0, r.count, fmtMs(r.totalMs), usd(Number(r.extra?.costUsd ?? 0))])}
          />
        </div>
      </div>
      <div class="card">
        <h2>Subagents</h2>
        <div id="t-subagents">
          <DataTable
            headers={["Agent", "Runs", "p50", "Total", "Tool uses"]}
            rows={summary.subagents.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.totalMs), r.extra?.toolUses ?? 0])}
          />
        </div>
      </div>
      <div class="card">
        <h2>Models</h2>
        <div id="t-models">
          <DataTable headers={["Model", "Requests", "p50", "p95", "Total"]} rows={summary.models.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.p95), fmtMs(r.totalMs)])} />
        </div>
      </div>
      <div class="card">
        <h2>Permission decisions (rules = config)</h2>
        <div id="t-permissions">
          <DataTable headers={["Source / decision", "Count"]} rows={summary.permissions} />
        </div>
      </div>
      <div class="card">
        <h2>MCP server connect</h2>
        <div id="t-mcp">
          <DataTable headers={["Server", "Connects", "p50", "Max", "Failed"]} rows={summary.mcpConnections.map((r) => [r.name, r.count, fmtMs(r.p50), fmtMs(r.maxMs), r.failures])} />
        </div>
      </div>
      <div class="card">
        <h2>Errors and compaction</h2>
        <div id="t-errors">
          <DataTable
            headers={["Kind", "Count"]}
            rows={[...summary.errors, ...(summary.kpis.compactions ? [[`Compactions (${fmtMs(summary.kpis.compactionMs)})`, summary.kpis.compactions]] : [])]}
          />
        </div>
      </div>
    </div>
  {/if}
</main>

<div id="tip" role="tooltip" bind:this={tipEl}></div>
