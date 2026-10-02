// Pure ECharts option builders and the palette reader. No chart-instance lifecycle here,
// see Chart.svelte for that; these functions only build plain option objects.
import * as echarts from "echarts/core";
import type { LatencyStats, PromptBreakdown, Summary, TurnSpan, TurnTimeline } from "@cpa/analytics";
import { fmtMs } from "@cpa/analytics";
import { clock, pct, usd } from "./format";

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export type Option = Record<string, any>;

export interface Palette {
  api: string;
  apiSoft: string;
  tools: string;
  hooks: string;
  critical: string;
  muted: string;
  ink: string;
  ink2: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
}

// [css var, palette key, label] for the three turn-time components, shared by the breakdown
// bar, the waterfall legend and the recent-prompts chart.
export const PARTS: [string, keyof Palette, string][] = [
  ["--api", "api", "Model (API)"],
  ["--tools", "tools", "Tools"],
  ["--hooks", "hooks", "Hooks"],
];

// Read live CSS custom properties so charts follow light/dark mode without a reload.
export function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    api: v("--api"),
    apiSoft: v("--api-soft"),
    tools: v("--tools"),
    hooks: v("--hooks"),
    critical: v("--critical"),
    muted: v("--muted"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    grid: v("--grid"),
    axis: v("--axis"),
    surface: v("--surface"),
    border: v("--border"),
  };
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function statTip(r: LatencyStats, extraLines: string[] = []) {
  return [r.name, `${r.count} runs, total ${fmtMs(r.totalMs)}`, `p50 ${fmtMs(r.p50)}  p95 ${fmtMs(r.p95)}  max ${fmtMs(r.maxMs)}`, ...extraLines]
    .concat(r.failures ? [`${r.failures} failed`] : [])
    .join("\n");
}

// Hook/tool/model names and prompt commands come from telemetry and are untrusted. Tooltip
// formatters return HTML, so every line goes through esc() before joining with <br/>.
export function tooltipHtml(text: string): string {
  return text.split("\n").map(esc).join("<br/>");
}

// Frosted tooltip to match the glass cards.
export const TIP_CSS = "border-radius:12px;-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:0 10px 30px rgba(0,0,0,.18);";

export function breakdownOption(pal: Palette, b: Summary["breakdown"]): Option {
  const vals = [b.api, b.tools, b.hooks];
  const total = vals.reduce((a, v) => a + v, 0) || 1;
  const pcts = vals.map((v) => (v / total) * 100);
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: 2, right: 2, top: 2, bottom: 2 },
    xAxis: { type: "value", max: 100, show: false },
    yAxis: { type: "category", data: [""], show: false },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      extraCssText: TIP_CSS,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(`${PARTS[p.seriesIndex as number]![2]}: ${fmtMs(vals[p.seriesIndex as number]!)} (${pct(vals[p.seriesIndex as number]! / total)})`),
    },
    series: PARTS.map(([, colorKey, name], i) => ({
      name,
      type: "bar",
      stack: "total",
      barWidth: "68%",
      data: [pcts[i]],
      itemStyle: { color: pal[colorKey] },
      label: {
        show: pcts[i]! > 8,
        formatter: `${name} ${pcts[i]!.toFixed(0)}%`,
        color: "#ffffff",
        fontWeight: 600,
        textBorderWidth: 0,
        fontSize: 11,
        fontFamily: FONT,
      },
    })),
  };
}

export function latencyOption(pal: Palette, pts: Summary["apiSeries"]["points"]): Option {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    legend: {
      data: ["p50", "p95"],
      top: 0,
      right: 4,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: pal.ink2, fontSize: 11, fontFamily: FONT },
    },
    grid: { left: 44, right: 10, top: 28, bottom: 26 },
    xAxis: {
      type: "time",
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => clock(v) },
      axisLine: { lineStyle: { color: pal.axis } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => fmtMs(v) },
      splitLine: { lineStyle: { color: pal.grid } },
      axisLine: { show: false },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: pal.surface,
      extraCssText: TIP_CSS,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (params: any[]) => {
        if (!params.length) return "";
        const t = Number(params[0].value[0]);
        const byName: Record<string, number | null> = {};
        for (const p of params) byName[p.seriesName as string] = p.value[1];
        const bucket = pts.find((pt) => pt.t === t);
        const lines = [clock(t)];
        if (bucket?.count) lines.push(`p50 ${fmtMs(byName.p50 ?? 0)}`, `p95 ${fmtMs(byName.p95 ?? 0)}`, `${bucket.count} requests`);
        else lines.push("no requests");
        return tooltipHtml(lines.join("\n"));
      },
    },
    // "inside" dataZoom only: scroll to zoom, drag to pan.
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      {
        name: "p50",
        type: "line",
        data: pts.map((p) => [p.t, p.p50]),
        // Small symbols so an isolated bucket (no line to connect to) still shows as a point.
        symbol: "circle",
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { color: pal.api, width: 2 },
        itemStyle: { color: pal.api },
      },
      {
        name: "p95",
        type: "line",
        data: pts.map((p) => [p.t, p.p95]),
        symbol: "circle",
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { color: pal.apiSoft, width: 2, type: "dashed" },
        itemStyle: { color: pal.apiSoft },
      },
    ],
  };
}

export function leftMarginFor(names: string[]): number {
  const longest = Math.min(30, names.reduce((m, n) => Math.max(m, n.length), 1));
  return Math.min(190, Math.max(60, longest * 6 + 16));
}

// Shared layout for "Hooks by total time" and "Tools, skills, MCP by total time":
// horizontal bars sorted by total (callers pass already-sorted rows), value label at bar end.
export function statBarOption(pal: Palette, rows: LatencyStats[], colorKey: "hooks" | "tools", extraTip: (r: LatencyStats) => string[]): Option {
  const names = rows.map((r) => r.name);
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(names), right: 64, top: 2, bottom: 2 },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: names,
      inverse: true,
      axisLabel: { color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (v: string) => (v.length > 30 ? `${v.slice(0, 29)}…` : v) },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      extraCssText: TIP_CSS,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(p.data.tipText as string),
    },
    series: [
      {
        type: "bar",
        barWidth: "62%",
        itemStyle: { color: pal[colorKey], borderRadius: 3 },
        data: rows.map((r) => ({
          value: r.totalMs,
          tipText: statTip(r, extraTip(r)),
          labelNote: `${fmtMs(r.totalMs)} · ${r.count}×`,
        })),
        label: {
          show: true,
          position: "right",
          color: pal.ink2,
          fontSize: 11,
          fontFamily: FONT,
          formatter: (p: any) => p.data.labelNote as string,
        },
      },
    ],
  };
}

export function promptsOption(pal: Palette, prompts: PromptBreakdown[]): Option {
  const names = prompts.map((p) => `${clock(p.startMs)} ${p.command ?? ""}`.trim());
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(names), right: 56, top: 2, bottom: 2 },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: names,
      inverse: true,
      axisLabel: { color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v) },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      extraCssText: TIP_CSS,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => tooltipHtml(p.data.tipText as string),
    },
    series: PARTS.map(([, colorKey, label], seriesIdx) => ({
      name: label,
      type: "bar",
      stack: "total",
      barWidth: "60%",
      itemStyle: { color: pal[colorKey] },
      data: prompts.map((p, i) => {
        const vals = [p.apiMs, p.toolMs, p.hookMs];
        const sum = vals.reduce((a, v) => a + v, 0);
        return {
          value: vals[seriesIdx],
          sum,
          tipText: `${names[i]}\n${label}: ${fmtMs(vals[seriesIdx]!)}\nAPI calls ${p.apiCalls}, tool calls ${p.toolCalls}\nWall clock ~${fmtMs(p.wallMs)}, cost ${usd(p.costUsd)}`,
        };
      }),
      // Only the last stacked series sits at the bar's far end, so the running total goes there.
      label:
        seriesIdx === PARTS.length - 1
          ? { show: true, position: "right", color: pal.ink2, fontSize: 11, fontFamily: FONT, formatter: (p: any) => fmtMs(p.data.sum as number) }
          : undefined,
    })),
  };
}

// Agent and compaction spans share the muted color; the legend groups them as one entry.
export function kindColor(pal: Palette, kind: TurnSpan["kind"]): string {
  if (kind === "api") return pal.api;
  if (kind === "tool") return pal.tools;
  if (kind === "hook") return pal.hooks;
  return pal.muted;
}

export const WF_ROW_H = 14;
export const WF_VISIBLE_ROWS = 15;

export function waterfallOption(pal: Palette, turn: TurnTimeline): Option {
  const rows = turn.spans.map((sp) => ({ ...sp, startOffset: sp.startMs - turn.startMs, endOffset: sp.endMs - turn.startMs }));
  const categories = rows.map((r) => {
    const label = r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label;
    return `+${fmtMs(r.startOffset)}  ${label}`;
  });
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT },
    grid: { left: leftMarginFor(categories), right: rows.length > WF_VISIBLE_ROWS ? 28 : 20, top: 8, bottom: 26 },
    // Long turns scroll rows inside the chart, so the time axis stays in view.
    dataZoom:
      rows.length > WF_VISIBLE_ROWS
        ? [
            { type: "inside", yAxisIndex: 0, startValue: 0, endValue: WF_VISIBLE_ROWS - 1, zoomLock: true, moveOnMouseWheel: true, zoomOnMouseWheel: false },
            { type: "slider", yAxisIndex: 0, startValue: 0, endValue: WF_VISIBLE_ROWS - 1, zoomLock: true, width: 8, right: 6, brushSelect: false, showDetail: false, borderColor: "transparent", fillerColor: pal.axis, handleSize: 0 },
          ]
        : [],
    xAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: pal.muted, fontSize: 11, fontFamily: FONT, formatter: (v: number) => fmtMs(v) },
      splitLine: { lineStyle: { color: pal.grid } },
      axisLine: { lineStyle: { color: pal.axis } },
    },
    yAxis: {
      type: "category",
      data: categories,
      inverse: true,
      // Show every row label; echarts hides some by default when rows are tight.
      axisLabel: { color: pal.ink2, fontSize: 10, fontFamily: FONT, interval: 0 },
      axisLine: { lineStyle: { color: pal.axis } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "item",
      backgroundColor: pal.surface,
      extraCssText: TIP_CSS,
      borderColor: pal.border,
      textStyle: { color: pal.ink, fontSize: 12, fontFamily: FONT },
      formatter: (p: any) => {
        const r = rows[p.dataIndex as number]!;
        const lines = [r.label, r.kind, `start +${fmtMs(r.startOffset)}`, `duration ${fmtMs(r.endOffset - r.startOffset)}`];
        if (!r.ok) lines.push("failed");
        return tooltipHtml(lines.join("\n"));
      },
    },
    series: [
      {
        type: "custom",
        encode: { x: [1, 2], y: 0 },
        // Standard echarts Gantt pattern: position a rect in pixel space via api.coord/api.size.
        renderItem: (params: any, api: any) => {
          const categoryIndex = api.value(0);
          const start = api.coord([api.value(1), categoryIndex]);
          const end = api.coord([api.value(2), categoryIndex]);
          const height = (api.size([0, 1]) as number[])[1]! * 0.7;
          const shape = (echarts as any).graphic.clipRectByRect(
            { x: start[0], y: start[1] - height / 2, width: Math.max(1, end[0] - start[0]), height },
            { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
          );
          return shape && { type: "rect", shape, style: api.style() };
        },
        data: rows.map((r, i) => ({
          value: [i, r.startOffset, r.endOffset],
          itemStyle: { color: kindColor(pal, r.kind), borderColor: r.ok ? "transparent" : pal.critical, borderWidth: r.ok ? 0 : 1.5 },
        })),
      },
    ],
  };
}

export function waterfallTitle(turn: TurnTimeline): string {
  const parts = [clock(turn.startMs)];
  if (turn.command) parts.push(turn.command);
  parts.push(`${fmtMs(turn.endMs - turn.startMs)} total`);
  return parts.join(" · ");
}
