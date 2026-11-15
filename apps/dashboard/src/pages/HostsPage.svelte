<script lang="ts">
  // Remote machines that send telemetry here over Tailscale or the LAN. Tokens live only in the reveal below.
  import { copyEnv, createHost, envText, regenerateHostToken, removeHost, type Host, type HostCredentials } from "../hosts";
  import { confirmText, hostRows, type Pending } from "./hosts/rows";
  import type { PageProps } from "./types";

  let { hosts, hostsError, onHostsChanged, hostId }: PageProps = $props();

  let newName = $state("");
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let reveal = $state<HostCredentials | null>(null);
  let revealAction = $state<"added" | "regenerated">("added");
  let copyNote = $state<{ ok: boolean; text: string } | null>(null);
  // Inline confirmation for rotate and remove; replaces window.confirm.
  let pending = $state<Pending | null>(null);
  // Which of this Mac's addresses goes into the env block.
  let endpointIndex = $state(0);
  let endpoint = $derived(reveal?.endpoints[endpointIndex] ?? null);
  let now = $state(Date.now());

  let rows = $derived(hostRows(hosts, now));
  let remoteCount = $derived(rows.filter((r) => !r.local).length);

  // Close a reveal whose host was removed elsewhere. It must have been listed once first,
  // because the list refresh after Add lands after the reveal opens.
  let revealListed = false;
  $effect(() => {
    if (!reveal) return;
    const id = reveal.host.id;
    if (hosts.some((h) => h.id === id)) revealListed = true;
    else if (revealListed) dismiss();
  });

  // Drop a pending confirmation whose host disappeared.
  $effect(() => {
    if (pending && !hosts.some((h) => h.id === pending!.id)) pending = null;
  });

  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(id);
  });

  async function run(action: () => Promise<void>) {
    busy = true;
    actionError = null;
    try {
      await action();
      onHostsChanged();
    } catch (err) {
      actionError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function show(creds: HostCredentials, kind: "added" | "regenerated") {
    reveal = creds;
    revealListed = false;
    revealAction = kind;
    copyNote = null;
    endpointIndex = 0;
  }

  function add(ev: SubmitEvent) {
    ev.preventDefault();
    const name = newName.trim();
    if (!name) return;
    pending = null;
    run(async () => {
      show(await createHost(fetch, name), "added");
      newName = "";
    });
  }

  function confirmPending(h: Host) {
    const p = pending;
    if (!p || p.id !== h.id) return;
    pending = null;
    if (p.action === "rotate") run(async () => show(await regenerateHostToken(fetch, h.id), "regenerated"));
    else
      run(async () => {
        await removeHost(fetch, h.id);
        if (reveal?.host.id === h.id) dismiss();
      });
  }

  async function copy() {
    if (!reveal) return;
    const write = navigator.clipboard ? (t: string) => navigator.clipboard.writeText(t) : undefined;
    const r = await copyEnv(reveal, write, endpoint);
    // The reveal stays open either way; only Dismiss closes it.
    copyNote = r.ok ? { ok: true, text: "Copied." } : { ok: false, text: `Copy failed: ${r.error}. Select the text and copy it by hand.` };
  }

  function dismiss() {
    reveal = null;
    copyNote = null;
  }
</script>

<div class="stack">
  <section>
    <div class="section-head">
      <h2>Hosts</h2>
      <span class="muted xs">machines sending telemetry to this collector over Tailscale or your LAN</span>
    </div>

    {#if hostsError}
      <div class="panel crit"><p class="bad">Could not load hosts: {hostsError}</p></div>
    {:else if rows.length === 0}
      <p class="muted">Loading...</p>
    {/if}

    {#if rows.length}
      <div class="host-list">
        {#each rows as r (r.host.id)}
          <div class="host-row">
            <div class="row">
              <span class="host-dot" class:on={!r.waiting} title={r.waiting ? "No telemetry yet" : "Sending telemetry"}></span>
              <div class="truncate">
                <div class="host-name truncate">
                  {r.host.name}
                  {#if r.host.id === hostId}<span class="badge api">selected</span>{/if}
                </div>
                <div class="muted xs">{r.detail}</div>
              </div>
              {#if r.waiting}<span class="badge warn push">waiting</span>{/if}
              {#if !r.local}
                <span class="host-actions" class:push={!r.waiting}>
                  <button class="btn" disabled={busy} onclick={() => (pending = { id: r.host.id, action: "rotate" })}>Rotate token</button>
                  <button class="btn danger" disabled={busy} onclick={() => (pending = { id: r.host.id, action: "remove" })}>Remove</button>
                </span>
              {/if}
            </div>
            {#if pending && pending.id === r.host.id}
              <div class="confirm row xs" role="alert">
                <span>{confirmText(pending, r.host.name)}</span>
                <span class="push row">
                  <button class="btn" class:danger={pending.action === "remove"} disabled={busy} onclick={() => confirmPending(r.host)}>
                    {pending.action === "rotate" ? "Rotate" : "Remove"}
                  </button>
                  <button class="btn" onclick={() => (pending = null)}>Cancel</button>
                </span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {#if remoteCount === 0 && !hostsError}
        <p class="muted xs">No remote hosts yet. Add one below to get the settings for that machine.</p>
      {/if}
    {/if}
  </section>

  <section class="add-panel">
    <div class="add-head"><h2>Add a host</h2></div>
    <form class="add-form" onsubmit={add}>
      <label class="field">
        <span class="muted">Name</span>
        <input type="text" class="mono" placeholder="e.g. linux-box" maxlength="80" bind:value={newName} disabled={busy} />
      </label>
      <button class="btn primary" type="submit" disabled={busy || !newName.trim()}>Create token</button>
      <span class="muted xs">Adding a host never changes this Mac's Claude Code settings.</span>
    </form>

    {#if actionError}
      <p class="bad add-msg">{actionError}</p>
    {/if}

    {#if reveal}
      <div class="reveal" role="region" aria-label="New host settings">
        <div class="row baseline">
          <strong>{revealAction === "added" ? "Added" : "New token for"} {reveal.host.name}.</strong>
          <span class="push row">
            <button class="btn primary" onclick={copy}>Copy</button>
            <button class="btn" onclick={dismiss}>Dismiss</button>
          </span>
        </div>
        <p class="muted">
          Paste this into <code>~/.claude/settings.json</code> on that machine, merged with any existing <code>env</code>, then restart Claude Code there.
        </p>
        <p class="warn">The token is shown only this once. It cannot be shown again; rotate it if it is lost.</p>
        {#if reveal.endpoints.length === 0}
          <p class="warn">
            No Tailscale or LAN address was found on this Mac. Replace <code>&lt;THIS_MAC_IP&gt;</code> with an address the remote machine can reach, or connect
            this Mac to a network and rotate the token.
          </p>
        {:else}
          <label class="row xs">
            <span class="muted">Reach this Mac at</span>
            <select class="input" bind:value={endpointIndex}>
              {#each reveal.endpoints as e, i (e.url)}
                <option value={i}>{e.network === "tailscale" ? "Tailscale" : "LAN"} {e.address} ({e.interface})</option>
              {/each}
            </select>
          </label>
          {#if endpoint?.network === "lan"}
            <p class="warn">Over the LAN, telemetry and this token travel unencrypted. Use it only on a network you trust.</p>
          {/if}
        {/if}
        {#if revealAction === "added"}
          <p class="muted xs">The collector now listens beyond this Mac so remote hosts can reach it. macOS may ask once to allow incoming connections.</p>
        {/if}
        <pre>{envText(reveal, endpoint)}</pre>
        {#if copyNote}
          <span class={copyNote.ok ? "ok" : "bad"}>{copyNote.text}</span>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .host-list { border: 1px solid var(--hairline); border-radius: var(--r-lg); background: var(--surface); }
  .host-row { padding: 12px 16px; }
  .host-row + .host-row { border-top: 1px solid var(--hairline); }
  .host-row > .row { gap: 12px; }
  .host-name { font-weight: 500; display: flex; align-items: center; gap: 6px; }
  .host-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--faint); }
  .host-dot.on { background: var(--hooks); border-color: var(--hooks); }
  .host-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .confirm {
    margin-top: 10px; padding: 8px 10px; border-radius: var(--r-md);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .add-panel { border: 1px solid var(--hairline); border-radius: var(--r-lg); background: var(--surface); }
  .add-head { padding: 10px 16px; border-bottom: 1px solid var(--hairline); }
  .add-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; padding: 16px; font-size: 12px; }
  .field { display: grid; gap: 4px; }
  .field input { width: 224px; }
  .add-msg { margin: 0 16px 12px; }
  .reveal { margin: 0 16px 16px; padding: 12px; border: 1px dashed var(--hairline-strong); border-radius: var(--r-md); font-size: 12px; }
</style>
