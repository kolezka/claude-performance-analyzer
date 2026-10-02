<script lang="ts">
  let { headers, rows, numericFrom = 1 }: { headers: string[]; rows: (string | number)[][]; numericFrom?: number } = $props();
</script>

{#if !rows.length}
  <p class="empty">No data in this window.</p>
{:else}
  <table>
    <tbody>
      <tr>
        {#each headers as h, i}
          <th class={i >= numericFrom ? "num" : ""}>{h}</th>
        {/each}
      </tr>
      {#each rows as r}
        <tr>
          {#each r as c, i}
            <td class={i >= numericFrom ? "num" : "name"} title={String(c)}>{c}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
