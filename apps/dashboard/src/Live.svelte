<script lang="ts">
  // Live activity: WebSocket feed of events as Claude Code exports them.
  import type { LiveEvent } from "@cpa/analytics";
  import { fmtMs } from "@cpa/analytics";
  import { clockSec } from "./format";
  import { RequestGate, RunningHooks, apiUrl, liveForHost } from "./hosts";

  let { hostId, onData }: { hostId: string; onData: () => void } = $props();

  const FEED_MAX = 40;
  const STALE_HOOK_MS = 120_000;
  const KIND_COLOR: Record<string, string> = { api: "--api", tool: "--tools", hook: "--hooks", error: "--critical" };

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
  let maxMs = $derived(Math.max(...visibleRows.map((e) => e.ms ?? 0), 1000));

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
    }, 250);
    return () => clearInterval(id);
  });
</script>

<section id="live" class="card" aria-live="polite">
  <div class="live-head">
    <span class="dot" class:on={connState === "Live"}></span><strong>{connState}</strong>
    <span class="muted">{agoText}</span>
    <span>
      {#each runningList as [k, t] (k)}
        <span class="running">hook {k.split("|")[1]} running {fmtMs(nowTick - t)}</span>
      {/each}
    </span>
  </div>
  <div class="feed">
    {#if !visibleRows.length}
      <p class="empty">Waiting for events...</p>
    {:else}
      {#each visibleRows as e (e._id)}
        <div class="row" class:fresh={e.fresh} class:bad={!e.ok}>
          <span class="t">{clockSec(e.tsMs)}</span>
          <span class="chip" style="background:var({KIND_COLOR[e.kind] ?? '--muted'})"></span>
          <span class="lbl" title={e.label}>{e.label}{e.ok || e.label.endsWith("failed") ? "" : " (failed)"}</span>
          <span class="track">
            {#if e.ms}<span class="bar" style="width:{Math.max(2, (e.ms / maxMs) * 100)}%;background:var({KIND_COLOR[e.kind] ?? '--muted'})"></span>{/if}
          </span>
          <span class="ms">{e.ms ? fmtMs(e.ms) : ""}</span>
        </div>
      {/each}
    {/if}
  </div>
</section>
