import SwiftUI

struct SummaryView: View {
    let summary: Summary
    let live: [LiveEvent]
    var onSelectItem: (StatsKind, String) -> Void = { _, _ in }
    var onSelectEvent: (Int) -> Void = { _ in }

    @AppStorage(Prefs.Key.showKpis) private var showKpis = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLatencyChart) private var showLatencyChart = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showBreakdown) private var showBreakdown = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showSlowest) private var showSlowest = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showTotalTime) private var showTotalTime = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLiveFeed) private var showLiveFeed = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.hideHookStartEvents) private var hideHookStartEvents = Prefs.Defaults.hideHookStartEvents
    @AppStorage(Prefs.Key.hookWarnThresholdMs) private var hookWarnThresholdMs = Prefs.Defaults.hookWarnThresholdMs

    var body: some View {
        let k = summary.kpis
        VStack(alignment: .leading, spacing: 14) {
            if showKpis {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Kpi(title: "API p50", value: fmtMs(k.apiP50))
                        Kpi(title: "API p95", value: fmtMs(k.apiP95))
                        Kpi(title: "TTFT", value: k.ttftP50.map(fmtMs) ?? "–")
                        Kpi(title: "Turn", value: fmtMs(k.turnP50))
                    }
                    Text("\(k.costUsd, format: .currency(code: "USD")) · cache \(k.cacheHitRatio, format: .percent.precision(.fractionLength(0))) · \(k.sessions) sessions")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
            }
            if showLatencyChart {
                LatencyChart(points: summary.apiSeries.points)
            }
            if showBreakdown {
                Breakdown(breakdown: summary.breakdown)
            }
            if showSlowest {
                KindStatsList(
                    title: "Slowest",
                    summary: summary,
                    storageKey: "slowestKind",
                    defaultKind: .hooks,
                    metric: \.p95,
                    value: { "p95 \(fmtMs($0.p95))" },
                    // The collector's own "slow" state always uses a fixed 2000ms hook p95; this
                    // threshold only controls the highlight in this list.
                    warn: { kind, row in kind == .hooks && row.p95 > hookWarnThresholdMs },
                    onSelect: onSelectItem,
                    footnote: "Only affects this highlight. The collector's slow state uses a fixed rule."
                )
            }
            if showTotalTime {
                KindStatsList(
                    title: "By total time",
                    summary: summary,
                    storageKey: "totalTimeKind",
                    defaultKind: .tools,
                    metric: \.totalMs,
                    value: { fmtMs($0.totalMs) },
                    onSelect: onSelectItem
                )
            }
            if showLiveFeed {
                LiveFeed(events: hideHookStartEvents ? live.filter { $0.kind != "hook_start" } : live, onSelect: onSelectEvent)
            }
        }
    }
}

struct Kpi: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
