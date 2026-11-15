<script lang="ts">
  // Live activity: WebSocket feed of events as Claude Code exports them.
  import type { LiveEvent } from "@cpa/analytics";
  import { fmtMs } from "@cpa/analytics";
  import { clockSec } from "./format";
  import { RequestGate, RunningHooks, apiUrl, liveForHost } from "./hosts";

  let { hostId, hostLabel = "", onData, onState }: { hostId: string; hostLabel?: string; onData: () => void; onState?: (state: string, ago: string) => void } = $props();

  const FEED_MAX = 40;
  const STALE_HOOK_MS = 120_000;
  const KIND_CLASS: Record<string, string> = { api: "k-api", tool: "k-tool", hook: "k-hook", error: "k-error" };
  // Hooks slower than this are tinted, matching the 2s p95 flag on the KPI.
  const SLOW_HOOK_MS = 2000;

  interface Row extends LiveEvent {
    _id: number;
    fresh: boolean;
  }
  let nextId = 0;
  const wrap = (e: LiveEvent, fresh: boolean): Row => ({ ...e, _id: nextId++, fresh });

  let feed = $state<Row[]>([]);
  let connState = $state<"Connecting" | "Live" | "Reconnecting">("Connecting");
  let agoText = $state("");
  let runningList = $state<[string, number][]>([]);
  let nowTick = $state(Date.now());
  let lastSeen = 0;
  let socketOpen = false;
  const running = new RunningHooks(STALE_HOOK_MS);
  const gate = new RequestGate();

  let visibleRows = $derived(feed.filter((e) => e.kind !== "hook_start"));

  async function backlog() {
    await gate.run<LiveEvent[]>(fetch, apiUrl("/api/live", hostId), {
      ok: (events) => {
        feed = events.map((e) => wrap(e, false));
        lastSeen = events[0]?.tsMs ?? 0;
      },
    });
  }

  // A host switch drops everything from the old host, including in-flight backlog requests.
  function resetForHost() {
    gate.invalidate();
    feed = [];
    lastSeen = 0;
    agoText = "";
    running.clear();
    runningList = [];
    if (socketOpen) backlog();
  }

  $effect(() => {
    hostId;
    resetForHost();
  });

  $effect(() => {
    let retryMs = 1000;
    let ws: WebSocket;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        retryMs = 1000;
        connState = "Live";
        socketOpen = true;
        backlog();
      };
      ws.onmessage = (msg) => {
        const data = liveForHost(String(msg.data), hostId);
        if (!data) return;
        const fresh = [...data.events].sort((a, b) => b.tsMs - a.tsMs);
        running.track(data.events);
        if (fresh.length) {
          lastSeen = Math.max(lastSeen, fresh[0]!.tsMs);
          feed = [...fresh.map((e) => wrap(e, true)), ...feed.map((r) => (r.fresh ? { ...r, fresh: false } : r))].slice(0, FEED_MAX);
        }
        if (data.changed) onData();
      };
      ws.onclose = () => {
        socketOpen = false;
        if (closed) return;
        connState = "Reconnecting";
        reconnectTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    }
    connect();
    return () => {
      closed = true;
      gate.invalidate();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  });

  $effect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      agoText = lastSeen ? `last event ${fmtMs(Math.max(0, now - lastSeen))} ago` : "";
      runningList = running.entries(now);
      nowTick = now;
      onState?.(connState, agoText);
    }, 250);
    return () => clearInterval(id);
  });
</script>

<section id="live" aria-live="polite">
  <div class="live-head">
    <h2>Live</h2>
    <span class="live-dot" class:on={connState === "Live"} title={connState}></span>
    <span class="push small muted">{hostLabel}</span>
  </div>
  <div class="small muted" style="margin-top:2px">{connState}{agoText ? ` · ${agoText}` : ""}</div>
  {#each runningList as [k, t] (k)}
    <div class="running-banner"><span class="mono">{k.split("|")[1]}</span> running <strong class="mono">{fmtMs(nowTick - t)}</strong></div>
  {/each}
  {#if !visibleRows.length}
    <p class="empty" style="margin-top:12px">Waiting for events...</p>
  {:else}
    <ol class="feed">
      {#each visibleRows as e (e._id)}
        <li class:fresh={e.fresh} class:bad={!e.ok}>
          <span class="t">{clockSec(e.tsMs)}</span>
          <span class="lbl truncate" title={e.label}
            ><span class={KIND_CLASS[e.kind] ?? "k-other"}>{e.kind === "error" ? "err" : e.kind}</span> {e.label}{e.ok || e.label.endsWith("failed") ? "" : " (failed)"}</span
          >
          <span class="ms" class:slow={e.kind === "hook" && (e.ms ?? 0) > SLOW_HOOK_MS}>{e.ms ? fmtMs(e.ms) : ""}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>
