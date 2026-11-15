<script lang="ts">
  import { onMount } from "svelte";
  import type { Summary } from "@cpa/analytics";
  import type { EnvPlan } from "@cpa/claude-settings";
  import Live from "./Live.svelte";
  import Overview from "./pages/Overview.svelte";
  import Turns from "./pages/Turns.svelte";
  import Hooks from "./pages/Hooks.svelte";
  import Tools from "./pages/Tools.svelte";
  import Models from "./pages/Models.svelte";
  import Errors from "./pages/Errors.svelte";
  import HostsPage from "./pages/HostsPage.svelte";
  import Settings from "./pages/Settings.svelte";
  import { clock } from "./format";
  import { LOCAL_HOST, LOCAL_HOST_ID, RequestGate, apiUrl, hostFromSearch, hostName, reconcileSelection, searchWithHost, type Host } from "./hosts";
  import { PAGE_TITLES, parseRoute, routeHash, type Page } from "./route";

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

  let route = $state(parseRoute(location.hash));
  let setup = $state<EnvPlan | null>(null);
  let liveState = $state("Connecting");
  let liveAgo = $state("");
  // Pages refetch their own detail data whenever a fresh summary lands.
  let tick = $derived(summary?.generatedAt ?? 0);

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
        updatedText = `${s.eventCount.toLocaleString("en-US")} events · ${clock(s.generatedAt)}`;
      },
      fail: (error, status) => {
        loadError = error;
        loadErrorStatus = status;
        // Probably deleted in another client: check the list now instead of at the next refresh.
        if (status === 404 && hostId !== LOCAL_HOST_ID) refreshHosts();
      },
    });
  }

  // Pushed events trigger a refresh; batch bursts so the summary query runs at most twice a second.
  function loadSoon() {
    gate.soon(load, 500);
  }

  async function loadSetup() {
    try {
      setup = (await (await fetch("/api/setup")).json()) as EnvPlan;
    } catch {
      // The settings page shows its own error; the nav badge just stays empty.
    }
  }

  function navigate(page: Page, params: Record<string, string | number | undefined | null> = {}) {
    const hash = routeHash(page, params);
    if (location.hash !== hash) window.history.pushState(null, "", `${location.pathname}${location.search}${hash}`);
    route = parseRoute(hash);
    window.scrollTo(0, 0);
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
    loadSetup();
    const onPop = () => {
      const wanted = hostFromSearch(location.search);
      const next = hostsLoaded ? reconcileSelection(wanted, hosts) : wanted;
      selectHost(next, next === wanted ? "none" : "replace");
      route = parseRoute(location.hash);
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

  let remoteCount = $derived(hosts.filter((h) => h.id !== LOCAL_HOST_ID).length);
  let errorCount = $derived(summary ? summary.errors.reduce((n, [, c]) => n + c, 0) : 0);
  let slowHooks = $derived(!!summary && (summary.kpis.hookShare > 0.15 || summary.hooks.some((h) => h.p95 > 2000)));
  let missingSettings = $derived(setup && !setup.error ? setup.missing.length : 0);
  // Pages that need the summary wait for it; Remote hosts and settings work without telemetry.
  let needsSummary = $derived(route.page !== "hosts" && route.page !== "settings");

  const NAV: { page: Page; icon: string }[] = [
    { page: "overview", icon: "M2 13V7m4 6V3m4 10V9m4 4V5" },
    { page: "turns", icon: "M2 4h8M4 8h10M3 12h6" },
    { page: "hooks", icon: "M5 2v5a3 3 0 0 0 6 0V2M8 10v4" },
    { page: "tools", icon: "M10 2l4 4-8 8H2v-4z" },
    { page: "models", icon: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3l2 1" },
    { page: "errors", icon: "M8 2l6 11H2z" },
  ];
  const SETUP_NAV: { page: Page; icon: string }[] = [
    { page: "hosts", icon: "M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M5 14h6" },
    { page: "settings", icon: "M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4M8 1v2m0 10v2M1 8h2m10 0h2" },
  ];

  function onNavClick(ev: MouseEvent, page: Page) {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    navigate(page);
  }

  // Tooltips for non-chart elements (KPI tiles); charts use echarts' own tooltip.
  let tipEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    function onMove(ev: MouseEvent) {
      const el = (ev.target as Element).closest?.("[data-tip]");
      if (!el || !tipEl) {
        if (tipEl) tipEl.style.display = "none";
        return;
      }
      tipEl.textContent = el.getAttribute("data-tip")!;
      tipEl.style.display = "block";
      const w = tipEl.offsetWidth;
      tipEl.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - w - 8)}px`;
      tipEl.style.top = `${ev.clientY + 14}px`;
    }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  });

  let pageProps = $derived({
    hostId,
    hostName: selectedName,
    minutes,
    summary,
    tick,
    params: route.params,
    navigate,
    hosts,
    hostsError,
    onHostsChanged: refreshHosts,
    setup,
    onSetupChanged: (plan: EnvPlan) => (setup = plan),
  });
</script>

{#snippet navLink(item: { page: Page; icon: string })}
  <a class="navitem" class:active={route.page === item.page} href={`${location.search}${routeHash(item.page)}`} onclick={(e) => onNavClick(e, item.page)}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d={item.icon} /></svg>
    {PAGE_TITLES[item.page]}
    {#if item.page === "turns" && summary?.kpis.prompts}<span class="count">{summary.kpis.prompts}</span>{/if}
    {#if item.page === "hooks" && slowHooks}<span class="dot-warn" title="A hook is slow"></span>{/if}
    {#if item.page === "errors" && errorCount}<span class="count crit">{errorCount}</span>{/if}
    {#if item.page === "hosts" && remoteCount}<span class="count">{remoteCount}</span>{/if}
    {#if item.page === "settings" && missingSettings}<span class="count pill" title="Settings missing">{missingSettings}</span>{/if}
  </a>
{/snippet}

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">cc<span>/</span>speed</div>
      <select aria-label="Host" value={hostId} onchange={(e) => selectHost(e.currentTarget.value)}>
        {#if !hosts.some((h) => h.id === hostId)}
          <option value={hostId}>Loading...</option>
        {/if}
        {#each hosts as h (h.id)}
          <option value={h.id}>{h.name}</option>
        {/each}
      </select>
    </div>
    <nav class="nav" aria-label="Pages">
      {#each NAV as item (item.page)}{@render navLink(item)}{/each}
      <div class="nav-section">Setup</div>
      {#each SETUP_NAV as item (item.page)}{@render navLink(item)}{/each}
    </nav>
    <div class="foot">
      <div class="row"><span class="live-dot" class:on={liveState === "Live"}></span><strong>{liveState}</strong><span class="muted truncate">{liveAgo}</span></div>
      <div class="mono">{updatedText}</div>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <h1>{PAGE_TITLES[route.page]}</h1>
      <div class="seg push" role="tablist" aria-label="Time window">
        {#each WINDOWS as [m, label]}
          <button role="tab" aria-selected={minutes === m} class:on={minutes === m} onclick={() => selectWindow(m)}>{label}</button>
        {/each}
      </div>
    </header>

    <div class="content-grid">
      <main class="page" id="app">
        {#if needsSummary && loadError}
          <div class="panel crit">
            <h2>{loadErrorStatus === null ? "Collector unreachable" : `Could not load ${selectedName}`}</h2>
            <p class="muted">{loadError}</p>
          </div>
        {:else if needsSummary && !summary}
          <p class="muted">Loading...</p>
        {:else if needsSummary && summary && summary.eventCount === 0}
          <div class="panel dashed">
            {#if hostId !== LOCAL_HOST_ID}
              <h2>No telemetry from {selectedName} yet</h2>
              <p>
                Paste the env block shown when this host was added into <code>~/.claude/settings.json</code> on that machine, then restart Claude Code there. The
                token is shown only once: if it is lost, regenerate it under <a href={routeHash("hosts")} onclick={(e) => onNavClick(e, "hosts")}>Remote hosts</a>.
              </p>
            {:else}
              <h2>No telemetry yet</h2>
              <p>
                Add the missing settings under <a href={routeHash("settings")} onclick={(e) => onNavClick(e, "settings")}>Telemetry settings</a>, then restart Claude
                Code.
              </p>
            {/if}
          </div>
        {:else if route.page === "overview"}
          <Overview {...pageProps} />
        {:else if route.page === "turns"}
          <Turns {...pageProps} />
        {:else if route.page === "hooks"}
          <Hooks {...pageProps} />
        {:else if route.page === "tools"}
          <Tools {...pageProps} />
        {:else if route.page === "models"}
          <Models {...pageProps} />
        {:else if route.page === "errors"}
          <Errors {...pageProps} />
        {:else if route.page === "hosts"}
          <HostsPage {...pageProps} />
        {:else if route.page === "settings"}
          <Settings {...pageProps} />
        {/if}
      </main>
      <aside class="rail">
        <Live {hostId} hostLabel={selectedName} onData={loadSoon} onState={(s, a) => ((liveState = s), (liveAgo = a))} />
      </aside>
    </div>
  </div>
</div>

<div id="tip" role="tooltip" bind:this={tipEl}></div>
