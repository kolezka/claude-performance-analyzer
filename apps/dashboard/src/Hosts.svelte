<script lang="ts">
  // Remote machines that send telemetry here over Tailscale. Tokens live only in the reveal below.
  import { LOCAL_HOST_ID, copyEnv, createHost, envText, lastSeenText, regenerateHostToken, removeHost, type Host, type HostCredentials } from "./hosts";

  let { hosts, listError, onChanged }: { hosts: Host[]; listError: string | null; onChanged: () => void } = $props();

  let newName = $state("");
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let reveal = $state<HostCredentials | null>(null);
  let revealAction = $state<"added" | "regenerated">("added");
  let copyNote = $state<{ ok: boolean; text: string } | null>(null);
  let now = $state(Date.now());
  // Collapsed by default so the dashboard looks as before until someone opens it.
  let open = $state(false);

  let remotes = $derived(hosts.filter((h) => h.id !== LOCAL_HOST_ID));

  // Close a reveal whose host was removed elsewhere. It must have been listed once first,
  // because the list refresh after Add lands after the reveal opens.
  let revealListed = false;
  $effect(() => {
    if (!reveal) return;
    open = true;
    const id = reveal.host.id;
    if (hosts.some((h) => h.id === id)) revealListed = true;
    else if (revealListed) dismiss();
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
      onChanged();
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
  }

  function add(ev: SubmitEvent) {
    ev.preventDefault();
    const name = newName.trim();
    if (!name) return;
    run(async () => {
      show(await createHost(fetch, name), "added");
      newName = "";
    });
  }

  function regenerate(h: Host) {
    if (!confirm(`Regenerate the token for "${h.name}"? The current token stops working at once.`)) return;
    run(async () => show(await regenerateHostToken(fetch, h.id), "regenerated"));
  }

  function remove(h: Host) {
    if (!confirm(`Remove "${h.name}"? Its token stops working and all telemetry saved from this host is deleted.`)) return;
    run(async () => {
      await removeHost(fetch, h.id);
      if (reveal?.host.id === h.id) reveal = null;
    });
  }

  async function copy() {
    if (!reveal) return;
    const write = navigator.clipboard ? (t: string) => navigator.clipboard.writeText(t) : undefined;
    const r = await copyEnv(reveal, write);
    // The reveal stays open either way; only Dismiss closes it.
    copyNote = r.ok ? { ok: true, text: "Copied." } : { ok: false, text: `Copy failed: ${r.error}. Select the text and copy it by hand.` };
  }

  function dismiss() {
    reveal = null;
    copyNote = null;
  }
</script>

<details id="hosts" class="card" bind:open>
  <summary><h2>Remote hosts{remotes.length ? ` (${remotes.length})` : ""}</h2></summary>
  <p class="muted">Machines that send telemetry to this Mac over Tailscale. Adding a host never changes this Mac's Claude Code settings.</p>

  {#if listError}
    <p class="bad">Could not load hosts: {listError}</p>
  {/if}

  {#if remotes.length}
    <ul class="host-list">
      {#each remotes as h (h.id)}
        <li>
          <span class="host-name">{h.name}</span>
          <span class="muted">{lastSeenText(h, now)}</span>
          <span class="host-actions">
            <button disabled={busy} onclick={() => regenerate(h)}>Regenerate token</button>
            <button class="danger" disabled={busy} onclick={() => remove(h)}>Remove</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <form class="host-add" onsubmit={add}>
    <input type="text" placeholder="Host name, e.g. linux-box" maxlength="80" bind:value={newName} disabled={busy} />
    <button class="primary" type="submit" disabled={busy || !newName.trim()}>Add host</button>
  </form>

  {#if actionError}
    <p class="bad">{actionError}</p>
  {/if}

  {#if reveal}
    <div class="reveal" role="region" aria-label="New host settings">
      <p>
        <strong>{revealAction === "added" ? "Added" : "New token for"} {reveal.host.name}.</strong>
        Paste this into <code>~/.claude/settings.json</code> on that machine, merged with any existing <code>env</code>, then restart Claude Code there.
      </p>
      <p class="warn">The token is shown only this once. It cannot be shown again; regenerate it if it is lost.</p>
      {#if !reveal.tailscaleAddress}
        <p class="warn">
          No Tailscale address was found on this Mac. Replace <code>&lt;THIS_MAC_TAILSCALE_IP&gt;</code> with this Mac's Tailscale IP, or start Tailscale and
          regenerate the token.
        </p>
      {/if}
      {#if revealAction === "added"}
        <p class="muted">The collector now listens beyond this Mac so remote hosts can reach it. macOS may ask once to allow incoming connections.</p>
      {/if}
      <pre>{envText(reveal)}</pre>
      <button class="primary" onclick={copy}>Copy</button>
      <button onclick={dismiss}>Dismiss</button>
      {#if copyNote}
        <span class={copyNote.ok ? "ok" : "bad"}>{copyNote.text}</span>
      {/if}
    </div>
  {/if}
</details>
