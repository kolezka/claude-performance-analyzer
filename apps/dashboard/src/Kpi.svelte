<script lang="ts">
  let { label, value, sub = "", flag = false, tip = "" }: { label: string; value: string; sub?: string; flag?: boolean; tip?: string } = $props();
</script>

<div class="kpi" class:flag data-tip={tip || undefined}>
  <div class="label">{label}</div><div class="value">{value}</div><div class="sub">{sub}</div>
</div>
