<script lang="ts">
  import { sparkPath } from "./spark";

  let {
    label,
    value,
    sub = "",
    flag = false,
    tip = "",
    na = false,
    spark = null,
    sparkClass = "api-text",
  }: { label: string; value: string; sub?: string; flag?: boolean; tip?: string; na?: boolean; spark?: (number | null)[] | null; sparkClass?: string } = $props();

  let path = $derived(spark ? sparkPath(spark, 80, 24) : "");
</script>

<div class="kpi" class:flag data-tip={tip || undefined}>
  <div class="label">{label}</div>
  <div class="value-row">
    <span class="value" class:na>{value}</span>
    {#if path}
      <svg class="spark {sparkClass}" viewBox="0 0 80 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d={path} /></svg>
    {/if}
  </div>
  {#if sub}<div class="sub">{sub}</div>{/if}
</div>
