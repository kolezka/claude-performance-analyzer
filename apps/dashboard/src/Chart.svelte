<script lang="ts" module>
  import * as echarts from "echarts/core";
  import { BarChart, CustomChart, LineChart } from "echarts/charts";
  import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
  import { SVGRenderer } from "echarts/renderers";

  echarts.use([BarChart, LineChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, SVGRenderer]);
</script>

<script lang="ts">
  import type { Option } from "./charts";

  let {
    id,
    option,
    height,
    empty = "No data in this window.",
    notMerge = false,
    onInit,
  }: {
    id: string;
    option: Option | null;
    height?: string;
    empty?: string;
    notMerge?: boolean;
    onInit?: (chart: echarts.EChartsType) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let chart: echarts.EChartsType | null = null;

  // Reused across refreshes via setOption instead of dispose+recreate (keeps dataZoom/legend
  // selection state). Only disposed when option goes empty, or the component is destroyed.
  $effect(() => {
    if (option && container) {
      if (!chart) {
        chart = echarts.init(container, null, { renderer: "svg" });
        onInit?.(chart);
      }
      chart.resize();
      chart.setOption(option, notMerge);
    } else if (chart) {
      chart.dispose();
      chart = null;
    }
  });

  $effect(() => {
    const onResize = () => chart?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  $effect(() => () => {
    chart?.dispose();
    chart = null;
  });
</script>

{#if option}
  <div {id} bind:this={container} style={height ? `height:${height}` : undefined}></div>
{:else}
  <div {id} style={height ? `height:${height}` : undefined}><p class="empty">{empty}</p></div>
{/if}
