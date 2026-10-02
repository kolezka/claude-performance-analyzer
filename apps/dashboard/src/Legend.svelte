<script lang="ts">
  let { items }: { items: [string, string][] } = $props();
</script>

<div class="legend">
  {#each items as [c, l]}
    <span><i style="background:var({c})"></i>{l}</span>
  {/each}
</div>
