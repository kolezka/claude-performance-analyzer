import SwiftUI

// The panel's tabs. Each groups sections that used to sit in one long column.
enum PanelTab: String, CaseIterable, Identifiable {
    case overview, top, live, turn

    var id: String { rawValue }

    var label: String {
        switch self {
        case .overview: "Overview"
        case .top: "Top"
        case .live: "Live"
        case .turn: "Turn"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "gauge.with.dots.needle.33percent"
        case .top: "list.number"
        case .live: "dot.radiowaves.left.and.right"
        case .turn: "chart.bar.doc.horizontal"
        }
    }
}

struct SummaryView: View {
    let summary: Summary
    let live: [LiveEvent]
    let running: [RunningHook]
    let now: Date
    var tab: PanelTab = .overview
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
        VStack(alignment: .leading, spacing: 10) {
            switch tab {
            case .overview: overview
            case .top: top
            case .live, .turn: liveFeed
            }
        }
    }

    @ViewBuilder private var overview: some View {
        let k = summary.kpis
        if showKpis {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 8) {
                        MetricTile(title: "API p50", value: fmtMs(k.apiP50))
                        MetricTile(title: "API p95", value: fmtMs(k.apiP95))
                        MetricTile(title: "TTFT", value: k.ttftP50.map(fmtMs) ?? "–")
                        MetricTile(title: "Turn", value: fmtMs(k.turnP50))
                    }
                    Divider()
                    HStack(spacing: 14) {
                        Label {
                            Text(k.costUsd, format: .currency(code: "USD"))
                        } icon: {
                            Image(systemName: "dollarsign.circle")
                        }
                        Label {
                            Text("cache \(k.cacheHitRatio, format: .percent.precision(.fractionLength(0)))")
                        } icon: {
                            Image(systemName: "memorychip")
                        }
                        Label("\(k.sessions) sessions", systemImage: "terminal")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .contentTransition(.numericText())
                }
            }
        }
        if showLatencyChart {
            Card { LatencyChart(points: summary.apiSeries.points) }
        }
        if showBreakdown {
            Card { Breakdown(breakdown: summary.breakdown) }
        }
    }

    @ViewBuilder private var top: some View {
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
                footnote: "The warning only marks this list. The collector's slow state uses a fixed rule."
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
    }

    @ViewBuilder private var liveFeed: some View {
        if showLiveFeed {
            LiveFeed(
                events: hideHookStartEvents ? live.filter { $0.kind != "hook_start" } : live,
                running: running, now: now, onSelect: onSelectEvent
            )
        }
    }
}
