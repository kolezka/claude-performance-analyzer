<script lang="ts">
  // Card that offers to add the telemetry env vars to Claude Code settings.
  import type { EnvPlan } from "@cpa/claude-settings";

  type Note = { kind: "ok"; added: string[]; backup: string | null } | { kind: "bad"; message: string } | null;

  let plan = $state<EnvPlan | null>(null);
  let note = $state<Note>(null);
  let applying = $state(false);

  $effect(() => {
    (async () => {
      try {
        plan = (await (await fetch("/api/setup")).json()) as EnvPlan;
      } catch {
        // stays hidden, same as the original fetch-failure no-op
      }
    })();
  });

  let visible = $derived(!!plan && !!(plan.error || plan.missing.length || plan.conflicts.length || note));

  async function apply() {
    if (!plan) return;
    applying = true;
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      plan = out.plan;
      note = { kind: "ok", added: out.added, backup: out.backup ?? null };
    } catch (err) {
      note = { kind: "bad", message: (err as Error).message };
    } finally {
      applying = false;
    }
  }
</script>

<section id="setup" class="card" hidden={!visible}>
  {#if plan}
    <h2>Send Claude Code telemetry here</h2>
    {#if plan.error}
      <p class="bad">Cannot update settings: {plan.error}</p>
    {:else if plan.missing.length}
      <p>Missing in <code>{plan.path}</code> env: {#each plan.missing as k, i}{i > 0 ? " " : ""}<code class="key">{k}</code>{/each}</p>
      <button id="setup-apply" class="primary" disabled={applying} onclick={apply}>
        {applying ? "Updating..." : `Add ${plan.missing.length} missing setting${plan.missing.length > 1 ? "s" : ""}`}
      </button>
      <span class="muted">Existing values are never changed. A backup is written first.</span>
    {/if}
    {#if plan.conflicts.length}
      <p class="muted">
        Left unchanged, already set to another value: {#each plan.conflicts as k, i}{i > 0 ? " " : ""}<code class="key">{k}</code>{/each}. Data may not reach
        this dashboard until you change them by hand.
      </p>
    {/if}
    {#if note?.kind === "ok"}
      <p class="ok">
        Added {#each note.added as k, i}{i > 0 ? " " : ""}<code class="key">{k}</code>{/each}.{#if note.backup}
          Backup: <code>{note.backup}</code>.{/if} Restart Claude Code sessions to start sending data.
      </p>
    {:else if note?.kind === "bad"}
      <p class="bad">Update failed: {note.message}</p>
    {/if}
  {/if}
</section>
