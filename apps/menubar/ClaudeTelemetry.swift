import AppKit
import Charts
import SwiftUI

// Dashboard and JSON endpoints served by the local collector.
private let collectorURL = URL(string: "http://127.0.0.1:4318/")!

// MARK: - Payloads (the fields of src/analytics.ts the panel shows)

struct Status: Decodable {
    let label: String
    let state: String
}

struct Stats: Decodable {
    let name: String
    let totalMs: Double
    let p95: Double
}

struct Summary: Decodable {
    struct Kpis: Decodable {
        let sessions: Int
        let apiP50: Double
        let apiP95: Double
        let ttftP50: Double?
        let turnP50: Double
        let costUsd: Double
        let cacheHitRatio: Double
    }
    struct Breakdown: Decodable {
        let api: Double
        let tools: Double
        let hooks: Double
    }
    struct Point: Decodable {
        let t: Double
        let p50: Double?
        let p95: Double?
        let count: Int
    }
    struct Series: Decodable {
        let points: [Point]
    }

    let eventCount: Int
    let kpis: Kpis
    let breakdown: Breakdown
    let apiSeries: Series
    let hooks: [Stats]
    let tools: [Stats]
    let subagents: [Stats]
}

struct LiveEvent: Decodable {
    let tsMs: Double
    let kind: String
    let label: String
    let ms: Double?
    let ok: Bool
    let sessionId: String?
    // Present only when the collector can resolve a detail record for this event.
    let id: Int?
}

// MARK: - Detail payloads (api/event and api/item)

struct EventDetail: Decodable {
    struct Detail: Decodable {
        let key: String
        let value: String
    }

    let id: Int
    let tsMs: Double
    let name: String
    let kind: String
    let label: String
    let ms: Double?
    let ok: Bool
    let sessionId: String?
    let promptId: String?
    let details: [Detail]
    let session: SessionInfo?
}

struct SessionInfo: Decodable {
    struct Repo: Decodable {
        let name: String
        let root: String
        let worktree: String?
    }

    let sessionId: String
    let repo: Repo?
    let pathsSeen: Int
    let otherRepos: [String]
    let branch: String?
    let terminal: String?
    let claudeVersion: String?
    let models: [String]
    let firstMs: Double
    let lastMs: Double
    let prompts: Int
    let costUsd: Double
}

struct ItemDetail: Decodable {
    struct Repo: Decodable {
        let name: String?
        let root: String?
        let count: Int
        let totalMs: Double
        let p95: Double
    }
    struct Recent: Decodable {
        let id: Int
        let tsMs: Double
        let ms: Double?
        let ok: Bool
        let sessionId: String?
        let repo: String?
        let detail: String?
    }

    let kind: String
    let name: String
    let count: Int
    let failures: Int
    let totalMs: Double
    let p50: Double
    let p95: Double
    let maxMs: Double
    let repos: [Repo]
    let recent: [Recent]
}

func fmtMs(_ ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    if ms < 60_000 { return String(format: "%.1fs", ms / 1000) }
    return String(format: "%.1fm", ms / 60_000)
}

func date(_ ms: Double) -> Date {
    Date(timeIntervalSince1970: ms / 1000)
}

// Shortens a home-rooted path for display, the way Terminal and Finder do.
func abbreviateHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path.hasPrefix(home) { return "~" + path.dropFirst(home.count) }
    return path
}

func copyToPasteboard(_ string: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
}

// One motion curve for the whole panel, or none when the user turned on Reduce Motion.
@MainActor
func panelAnimation() -> Animation? {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? nil : .smooth(duration: 0.35)
}

// A ForEach id for a key that may repeat. A struct, so no key can mimic another's suffix.
struct RowID: Hashable {
    let key: String
    let occurrence: Int
}

// Repeats are counted from the end (the oldest event in a newest-first list),
// so a new event at the top never shifts the ids of the rows below it.
func rowIds(_ keys: [String]) -> [RowID] {
    var seen: [String: Int] = [:]
    return keys.reversed().map { key in
        let n = seen[key, default: 0]
        seen[key] = n + 1
        return RowID(key: key, occurrence: n)
    }.reversed()
}

// MARK: - Model

// Polls the status label all the time, and the summary and live feed only while the panel is open.
@MainActor
@Observable
final class Telemetry {
    var status: Status?
    var summary: Summary?
    var summaryError: String?
    var live: [LiveEvent] = []
    var updatedAt: Date?
    var panelOpen = false {
        didSet { if panelOpen != oldValue { restartPanelPolling() } }
    }
    var minutes = UserDefaults.standard.object(forKey: "window") as? Int ?? 60 {
        didSet {
            UserDefaults.standard.set(minutes, forKey: "window")
            summary = nil
            summaryError = nil
            restartPanelPolling()
        }
    }

    @ObservationIgnored private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 5.0
        return URLSession(configuration: config)
    }()
    @ObservationIgnored private var panelTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?

    init() {
        restartStatusPolling()
    }

    // Skips the 2s wait after a failure.
    func retry() {
        restartStatusPolling()
        restartPanelPolling()
    }

    // Status runs on its own loop so slow summary requests never delay the label.
    // Restarting cancels the old loop, so its late response cannot undo a newer one.
    private func restartStatusPolling() {
        statusTask?.cancel()
        statusTask = Task {
            while !Task.isCancelled {
                await refreshStatus()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func refreshStatus() async {
        let newStatus: Status? = try? await get("api/status")
        guard !Task.isCancelled else { return }
        withAnimation(panelAnimation()) { status = newStatus }
    }

    // One panel loop at a time: closing the panel or switching window cancels the old one,
    // so a late response can never overwrite newer data.
    private func restartPanelPolling() {
        panelTask?.cancel()
        panelTask = nil
        guard panelOpen else { return }
        panelTask = Task {
            while !Task.isCancelled {
                await refreshPanel()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func refreshPanel() async {
        do {
            let newSummary: Summary = try await get("api/summary?minutes=\(minutes)")
            let newLive: [LiveEvent]? = try? await get("api/live")
            guard !Task.isCancelled else { return }
            // Animating here lets numbers roll, rows slide and charts morph on every refresh.
            withAnimation(panelAnimation()) {
                summary = newSummary
                summaryError = nil
                live = newLive ?? live
            }
            updatedAt = .now
        } catch {
            guard !Task.isCancelled else { return }
            withAnimation(panelAnimation()) { summaryError = error.localizedDescription }
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await session.data(from: URL(string: path, relativeTo: collectorURL)!)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func fetchEvent(id: Int) async throws -> EventDetail {
        try await get("api/event?id=\(id)")
    }

    func fetchItem(kind: StatsKind, name: String) async throws -> ItemDetail {
        var components = URLComponents()
        components.path = "api/item"
        components.queryItems = [
            URLQueryItem(name: "kind", value: kind.rawValue),
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "minutes", value: String(minutes)),
        ]
        return try await get(components.string!)
    }
}

// MARK: - Menu bar label

struct MenuBarLabel: View {
    let status: Status?

    var body: some View {
        // MenuBarExtra draws the label as a template, so "slow" swaps the symbol instead of tinting.
        let slow = status?.state == "slow"
        HStack(spacing: 3) {
            Image(systemName: slow ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.67percent")
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: slow)
            Text(status?.label ?? "off").monospacedDigit()
        }
        .accessibilityLabel("Claude Code telemetry")
    }
}

// MARK: - Panel

struct PanelView: View {
    @Bindable var model: Telemetry
    // Overlay navigation stack: empty closes it, one entry shows a detail, two lets "back" return
    // from a recent call's event detail to the aggregate that opened it.
    @State private var detailStack: [DetailRoute] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            content
            Divider()
            footer
        }
        .padding(14)
        // An overlay takes the panel's size, so the card gets a fixed height to scroll in.
        .overlay { DetailOverlay(model: model, stack: $detailStack) }
        .frame(width: 360)
        .onAppear { model.panelOpen = true }
        .onDisappear {
            model.panelOpen = false
            detailStack = []
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Claude Code").font(.headline)
                HStack(spacing: 5) {
                    // Pulses only while events are arriving, so a calm panel stays still.
                    Image(systemName: "circle.fill")
                        .font(.system(size: 7))
                        .foregroundStyle(stateColor)
                        .symbolEffect(.pulse, isActive: recentlyActive)
                    Text(stateText).contentTransition(.opacity)
                    if let updatedAt = model.updatedAt, model.status != nil {
                        Text("· updated \(Text(updatedAt, style: .relative)) ago")
                    }
                    // Keep the last numbers on a failed refresh, but say they are stale.
                    if model.summaryError != nil, model.summary != nil, model.status != nil {
                        Text("· refresh failed").foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Window", selection: $model.minutes) {
                Text("15m").tag(15)
                Text("1h").tag(60)
                Text("24h").tag(1440)
                Text("7d").tag(10080)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
    }

    // "ok" covers any API request in the last 15 minutes, which is too long to call live.
    private var recentlyActive: Bool {
        guard model.status != nil, let newest = model.live.first else { return false }
        return Date.now.timeIntervalSince1970 * 1000 - newest.tsMs < 60_000
    }

    private var stateColor: Color {
        switch model.status?.state {
        case nil: .red
        case "slow": .orange
        case "idle": .secondary
        default: .green
        }
    }

    private var stateText: String {
        switch model.status?.state {
        case nil: "Collector offline"
        case "slow": "Hooks slow"
        case "idle": "Idle"
        default: "OK"
        }
    }

    @ViewBuilder private var content: some View {
        Group {
            if model.status == nil {
                EmptyState(
                    title: "Collector not running",
                    symbol: "bolt.horizontal.circle",
                    message: "Start it with `bun run start`.",
                    retry: model.retry
                )
                .id("offline")
            } else if let s = model.summary {
                if s.eventCount == 0 {
                    EmptyState(
                        title: "No telemetry yet",
                        symbol: "antenna.radiowaves.left.and.right",
                        message: "Nothing in this window. Enable telemetry for Claude Code from the dashboard."
                    )
                    .id("empty")
                } else {
                    SummaryView(
                        summary: s,
                        live: model.live,
                        onSelectItem: { kind, name in
                            withAnimation(panelAnimation()) { detailStack = [.item(kind: kind, name: name)] }
                        },
                        onSelectEvent: { id in
                            withAnimation(panelAnimation()) { detailStack = [.event(id: id)] }
                        }
                    )
                    .id("summary")
                }
            } else if let error = model.summaryError {
                EmptyState(
                    title: "Couldn't load summary",
                    symbol: "exclamationmark.triangle",
                    message: "\(error) Retrying every 2s.",
                    retry: model.retry
                )
                .id("error")
            } else {
                SkeletonView().id("loading")
            }
        }
        .transition(.opacity)
    }

    private var footer: some View {
        HStack {
            Button("Open Dashboard", systemImage: "arrow.up.right.square") {
                NSWorkspace.shared.open(collectorURL)
            }
            .keyboardShortcut("d")
            .help("Open the dashboard in your browser (⌘D)")
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
    }
}

// ContentUnavailableView wraps itself in a ScrollView, which collapses to zero height in a
// self-sizing menu bar panel. A plain stack sizes to its content.
struct EmptyState: View {
    let title: String
    let symbol: String
    let message: LocalizedStringKey
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
                .symbolEffect(.bounce, value: title)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Retry Now", systemImage: "arrow.clockwise", action: retry)
                    .controlSize(.small)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

// Same layout as the loaded panel with placeholder bars, so the panel does not jump when data lands.
struct SkeletonView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        SummaryView(summary: .placeholder, live: LiveEvent.placeholders)
            .redacted(reason: .placeholder)
            .allowsHitTesting(false)
            .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.45]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in .easeInOut(duration: 0.8) }
            .accessibilityLabel("Loading summary")
    }
}

extension Summary {
    static let placeholder: Summary = {
        let rows = (1...3).map { Stats(name: "placeholder row \($0)", totalMs: 1, p95: 1) }
        let now = Date.now.timeIntervalSince1970 * 1000
        return Summary(
            eventCount: 1,
            kpis: Kpis(sessions: 0, apiP50: 0, apiP95: 0, ttftP50: 0, turnP50: 0, costUsd: 0, cacheHitRatio: 0),
            breakdown: Breakdown(api: 1, tools: 1, hooks: 1),
            // One bucket with no requests draws the "no requests" line, which redacts to a bar.
            apiSeries: Series(points: [Point(t: now, p50: nil, p95: nil, count: 0)]),
            hooks: rows,
            tools: rows,
            subagents: rows
        )
    }()
}

extension LiveEvent {
    static let placeholders = (0..<6).map { LiveEvent(tsMs: Double($0), kind: "", label: "placeholder event", ms: 1, ok: true, sessionId: nil, id: nil) }
}

// Soft highlight under the hovered row, the same feedback native lists give.
struct HoverRow: ViewModifier {
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary.opacity(hovering ? 1 : 0), in: .rect(cornerRadius: 5))
            .padding(.horizontal, -6)
            .contentShape(.rect)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverRow() -> some View { modifier(HoverRow()) }
}

struct SummaryView: View {
    let summary: Summary
    let live: [LiveEvent]
    var onSelectItem: (StatsKind, String) -> Void = { _, _ in }
    var onSelectEvent: (Int) -> Void = { _ in }

    var body: some View {
        let k = summary.kpis
        VStack(alignment: .leading, spacing: 14) {
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
            LatencyChart(points: summary.apiSeries.points)
            Breakdown(breakdown: summary.breakdown)
            KindStatsList(
                title: "Slowest",
                summary: summary,
                storageKey: "slowestKind",
                defaultKind: .hooks,
                metric: \.p95,
                value: { "p95 \(fmtMs($0.p95))" },
                // Same threshold the collector uses for the "slow" state, which only watches hooks.
                warn: { kind, row in kind == .hooks && row.p95 > 2000 },
                onSelect: onSelectItem
            )
            KindStatsList(
                title: "By total time",
                summary: summary,
                storageKey: "totalTimeKind",
                defaultKind: .tools,
                metric: \.totalMs,
                value: { fmtMs($0.totalMs) },
                onSelect: onSelectItem
            )
            LiveFeed(events: live.filter { $0.kind != "hook_start" }, onSelect: onSelectEvent)
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

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    }
}

struct Swatch: View {
    let color: Color
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
}

// One plotted value. `segment` changes at every empty bucket so the line breaks there,
// like the dashboard's connectNulls: false.
struct LatencySample: Identifiable {
    // Keyed by series and bucket time so a refresh morphs each point instead of reshuffling them.
    var id: String { "\(series)-\(time.timeIntervalSince1970)" }
    let time: Date
    let ms: Double
    let series: String
    let segment: String

    static func from(_ points: [Summary.Point]) -> [LatencySample] {
        var samples: [LatencySample] = []
        for (series, value) in [("p50", \Summary.Point.p50), ("p95", \Summary.Point.p95)] {
            var segment = 0
            var inGap = false
            for p in points {
                guard let ms = p[keyPath: value] else {
                    if !inGap { segment += 1 }
                    inGap = true
                    continue
                }
                inGap = false
                samples.append(LatencySample(time: date(p.t), ms: ms, series: series, segment: "\(series)-\(segment)"))
            }
        }
        return samples
    }
}

struct LatencyChart: View {
    let points: [Summary.Point]
    @State private var hoverTime: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionTitle("API latency")
                Spacer()
                Swatch(color: .blue, text: "p50")
                Swatch(color: .blue.opacity(0.35), text: "p95")
            }
            if points.contains(where: { $0.count > 0 }) {
                chart
            } else {
                Text("No API requests in this window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90)
            }
        }
    }

    // The bucket with requests nearest the pointer, so the callout never shows an empty gap.
    private var hovered: Summary.Point? {
        guard let hoverTime else { return nil }
        let ms = hoverTime.timeIntervalSince1970 * 1000
        return points.filter { $0.count > 0 }.min { abs($0.t - ms) < abs($1.t - ms) }
    }

    private var chart: some View {
        Chart {
            ForEach(LatencySample.from(points)) { s in
                LineMark(x: .value("Time", s.time), y: .value("Latency", s.ms), series: .value("Segment", s.segment))
                    .foregroundStyle(by: .value("Series", s.series))
                    .lineStyle(s.series == "p95" ? StrokeStyle(lineWidth: 2, dash: [4, 3]) : StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.monotone)
                // Points keep a lone bucket visible, since a one-point line draws nothing.
                PointMark(x: .value("Time", s.time), y: .value("Latency", s.ms))
                    .foregroundStyle(by: .value("Series", s.series))
                    .symbolSize(10)
            }
            if let p = hovered {
                RuleMark(x: .value("Time", date(p.t)))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        HoverCallout(point: p)
                    }
            }
        }
        .chartXSelection(value: $hoverTime)
        // Span the whole window, not just the buckets that have requests.
        .chartXScale(domain: date(points.first?.t ?? 0)...date(points.last?.t ?? 0))
        .chartYScale(domain: .automatic(includesZero: true))
        .chartForegroundStyleScale(["p50": Color.blue, "p95": Color.blue.opacity(0.35)])
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { v in
                AxisGridLine()
                AxisValueLabel { if let ms = v.as(Double.self) { Text(fmtMs(ms)) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel(format: .dateTime.hour().minute(), collisionResolution: .greedy(minimumSpacing: 6))
            }
        }
        .frame(height: 90)
    }
}

struct HoverCallout: View {
    let point: Summary.Point

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(date(point.t), format: .dateTime.hour().minute()).foregroundStyle(.secondary)
            if let p50 = point.p50 { Text("p50 \(fmtMs(p50))") }
            if let p95 = point.p95 { Text("p95 \(fmtMs(p95))") }
            Text("\(point.count) req").foregroundStyle(.secondary)
        }
        .font(.caption2)
        .monospacedDigit()
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
    }
}

struct Breakdown: View {
    let breakdown: Summary.Breakdown
    // Charts ignore redaction, so the skeleton greys the bar out by hand.
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let colors = redaction.isEmpty ? [Color.blue, .purple, .orange] : [Color.secondary.opacity(0.3), .secondary.opacity(0.2), .secondary.opacity(0.1)]
        let parts = [("API", breakdown.api, colors[0]), ("Tools", breakdown.tools, colors[1]), ("Hooks", breakdown.hooks, colors[2])]
        let total = parts.reduce(0) { $0 + $1.1 }
        if total > 0 {
            VStack(alignment: .leading, spacing: 5) {
                SectionTitle("Where turn time goes")
                Chart(parts, id: \.0) { name, ms, _ in
                    BarMark(x: .value("Time", ms), stacking: .normalized)
                        .foregroundStyle(by: .value("Part", name))
                }
                .chartForegroundStyleScale(domain: parts.map(\.0), range: parts.map(\.2))
                .chartXAxis(.hidden)
                .chartLegend(.hidden)
                .clipShape(.capsule)
                .frame(height: 8)
                HStack(spacing: 12) {
                    ForEach(parts, id: \.0) { name, ms, color in
                        Swatch(color: color, text: "\(name) \((ms / total).formatted(.percent.precision(.fractionLength(0))))")
                    }
                }
            }
        }
    }
}

enum StatsKind: String, CaseIterable {
    case all, tools, hooks, agents

    var label: String { rawValue.capitalized }

    var symbol: String {
        switch self {
        case .all: "circle"
        case .tools: LiveFeed.symbol("tool")
        case .hooks: LiveFeed.symbol("hook")
        case .agents: LiveFeed.symbol("agent")
        }
    }
}

// Top 3 hooks, tools or agents by one metric, with a picker for which kind to show.
struct KindStatsList: View {
    let title: String
    let summary: Summary
    let metric: (Stats) -> Double
    let value: (Stats) -> String
    let warn: (StatsKind, Stats) -> Bool
    let onSelect: (StatsKind, String) -> Void
    @AppStorage private var kind: StatsKind

    init(
        title: String,
        summary: Summary,
        storageKey: String,
        defaultKind: StatsKind,
        metric: @escaping (Stats) -> Double,
        value: @escaping (Stats) -> String,
        warn: @escaping (StatsKind, Stats) -> Bool = { _, _ in false },
        onSelect: @escaping (StatsKind, String) -> Void = { _, _ in }
    ) {
        self.title = title
        self.summary = summary
        self.metric = metric
        self.value = value
        self.warn = warn
        self.onSelect = onSelect
        _kind = AppStorage(wrappedValue: defaultKind, storageKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionTitle(title)
                Spacer()
                Picker("Kind", selection: $kind) {
                    ForEach(StatsKind.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.mini)
                .fixedSize()
            }
            VStack(alignment: .leading, spacing: 4) {
                if rows.isEmpty {
                    Text("Nothing in this window.").font(.callout).foregroundStyle(.secondary)
                }
                // A hook and a tool can share a name, so the kind is part of the key.
                let ids = rowIds(rows.map { "\($0.0.rawValue)/\($0.1.name)" })
                ForEach(Array(zip(ids, rows)), id: \.0) { _, item in
                    let (rowKind, row) = item
                    Button { onSelect(rowKind, row.name) } label: {
                        HStack(spacing: 6) {
                            // Shown for every kind, so rows keep their alignment when the picker changes.
                            Image(systemName: rowKind.symbol).foregroundStyle(.secondary).frame(width: 16)
                            Text(row.name).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 8)
                            if warn(rowKind, row) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                                    .transition(.scale.combined(with: .opacity))
                            }
                            Text(value(row))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .contentTransition(.numericText())
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .font(.callout)
                    .hoverRow()
                    .help(row.name)
                    .transition(.opacity)
                }
            }
            .animation(panelAnimation(), value: kind)
        }
    }

    private var rows: [(StatsKind, Stats)] {
        let hooks = summary.hooks.map { (StatsKind.hooks, $0) }
        let tools = summary.tools.map { (StatsKind.tools, $0) }
        let agents = summary.subagents.map { (StatsKind.agents, $0) }
        let picked: [(StatsKind, Stats)] = switch kind {
        case .all: hooks + tools + agents
        case .tools: tools
        case .hooks: hooks
        case .agents: agents
        }
        return Array(picked.sorted { metric($0.1) > metric($1.1) }.prefix(3))
    }
}

struct LiveFeed: View {
    // The whole feed, newest first. Ids are counted over all of it, then only the top rows show.
    let events: [LiveEvent]
    var onSelect: (Int) -> Void = { _ in }

    var body: some View {
        if !events.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle("Live")
                let ids = rowIds(events.map { "\($0.tsMs)/\($0.sessionId ?? "")/\($0.kind)/\($0.label)" })
                ForEach(Array(zip(ids, events).prefix(6)), id: \.0) { _, e in
                    row(e)
                }
            }
            .clipped()
        }
    }

    @ViewBuilder
    private func row(_ e: LiveEvent) -> some View {
        let label = HStack(spacing: 6) {
            Text(date(e.tsMs), format: .dateTime.hour().minute().second())
                .foregroundStyle(.tertiary)
            Image(systemName: Self.symbol(e.kind))
                .foregroundStyle(e.ok ? Color.secondary : Color.red)
                .frame(width: 16)
            Text(e.label).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if let ms = e.ms {
                Text(fmtMs(ms)).foregroundStyle(.secondary)
            }
            if e.id != nil {
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .font(.callout)
        .monospacedDigit()

        Group {
            if let id = e.id {
                Button { onSelect(id) } label: { label.contentShape(.rect) }
                    .buttonStyle(.plain)
            } else {
                label
            }
        }
        .hoverRow()
        .help(e.label)
        // New events push in from the top; the oldest fades out at the bottom.
        .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "prompt": "text.bubble"
        case "api": "cloud"
        case "tool": "wrench.and.screwdriver"
        case "hook": "bolt"
        case "agent": "person.2"
        case "skill": "sparkles"
        case "mcp": "server.rack"
        case "error": "xmark.octagon"
        case "compaction": "arrow.down.right.and.arrow.up.left"
        default: "circle"
        }
    }
}

// MARK: - Detail overlay

// Where the overlay is pointed: a single event, or an aggregate row for one kind+name.
enum DetailRoute {
    case event(id: Int)
    case item(kind: StatsKind, name: String)
}

// Dimmed backdrop plus a card, replacing the panel content in place. Not a .sheet or NSWindow:
// either of those closes or misbehaves inside a MenuBarExtra panel.
struct DetailOverlay: View {
    @Bindable var model: Telemetry
    @Binding var stack: [DetailRoute]

    var body: some View {
        if let route = stack.last {
            ZStack {
                Rectangle()
                    .fill(.black.opacity(0.35))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onTapGesture(perform: close)

                DetailCard(model: model, route: route, canGoBack: stack.count > 1, onBack: back, onClose: close, onPush: push)
                    .padding(14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .transition(.opacity)
            .onExitCommand(perform: close)
        }
    }

    private func close() { withAnimation(panelAnimation()) { stack = [] } }
    private func back() { withAnimation(panelAnimation()) { if !stack.isEmpty { stack.removeLast() } } }
    private func push(_ route: DetailRoute) { withAnimation(panelAnimation()) { stack.append(route) } }
}

struct DetailCard: View {
    @Bindable var model: Telemetry
    let route: DetailRoute
    let canGoBack: Bool
    let onBack: () -> Void
    let onClose: () -> Void
    let onPush: (DetailRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            toolbar
            ScrollView {
                routeContent.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
    }

    private var toolbar: some View {
        HStack {
            if canGoBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .help("Back")
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close (Esc)")
        }
    }

    @ViewBuilder private var routeContent: some View {
        switch route {
        case .event(let id):
            EventDetailView(model: model, id: id)
        case .item(let kind, let name):
            ItemDetailView(model: model, kind: kind, name: name, onPush: onPush)
        }
    }
}

// Ok/failed pill, shared by both detail views.
struct OkBadge: View {
    let ok: Bool

    var body: some View {
        Text(ok ? "OK" : "Failed")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ok ? Color.green.opacity(0.15) : Color.red.opacity(0.15), in: .capsule)
            .foregroundStyle(ok ? Color.green : Color.red)
    }
}

struct StatCell: View {
    let title: String
    let value: String
    var warn = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.callout.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(warn ? Color.orange : Color.primary)
        }
    }
}

struct DetailSkeleton: View {
    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}

struct EventDetailView: View {
    @Bindable var model: Telemetry
    let id: Int

    @State private var detail: EventDetail?
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let detail {
                header(detail)
                repositorySection(detail.session)
                if !detail.details.isEmpty { detailsSection(detail.details) }
                if let session = detail.session { sessionSection(session) }
            } else if let loadError {
                EmptyState(
                    title: "Couldn't load event",
                    symbol: "exclamationmark.triangle",
                    message: "\(loadError)",
                    retry: { Task { await load() } }
                )
            } else {
                DetailSkeleton()
            }
            refreshBar
        }
        .task(id: id) { await load() }
    }

    private var refreshBar: some View {
        HStack {
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                .controlSize(.small)
                .disabled(isLoading)
        }
    }

    private func header(_ d: EventDetail) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: LiveFeed.symbol(d.kind))
                .foregroundStyle(d.ok ? Color.secondary : Color.red)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(d.label).font(.headline)
                HStack(spacing: 4) {
                    Text(date(d.tsMs), format: .dateTime.month().day().hour().minute().second())
                    if let ms = d.ms { Text("· \(fmtMs(ms))") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            }
            Spacer()
            OkBadge(ok: d.ok)
        }
    }

    private func repositorySection(_ session: SessionInfo?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Repository")
            if let repo = session?.repo {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(repo.name).font(.callout.weight(.medium))
                    }
                    let path = repo.worktree ?? repo.root
                    Text(abbreviateHome(path))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .help(path)
                    if let branch = session?.branch {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let session {
                        Text("Inferred from \(session.pathsSeen) path\(session.pathsSeen == 1 ? "" : "s").")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if !session.otherRepos.isEmpty {
                            Text("Also seen: \(session.otherRepos.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            } else {
                Text("Unknown repository").font(.callout.weight(.medium))
                Text("No file paths seen in this session yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func detailsSection(_ details: [EventDetail.Detail]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle("Details")
            ForEach(details, id: \.key) { d in
                VStack(alignment: .leading, spacing: 1) {
                    Text(d.key).font(.caption).foregroundStyle(.secondary)
                    Text(d.value)
                        .font(.callout)
                        .textSelection(.enabled)
                        .lineLimit(4)
                        .help(d.value)
                }
            }
        }
    }

    private func sessionSection(_ session: SessionInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Session")
            HStack(spacing: 6) {
                Text(String(session.sessionId.prefix(8)))
                    .font(.callout)
                    .monospaced()
                    .help(session.sessionId)
                Button { copyToPasteboard(session.sessionId) } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Copy session id")
            }
            if let terminal = session.terminal {
                Label(terminal, systemImage: "terminal").font(.caption).foregroundStyle(.secondary)
            }
            if let version = session.claudeVersion {
                Text("Claude Code \(version)").font(.caption).foregroundStyle(.secondary)
            }
            if !session.models.isEmpty {
                Text(session.models.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
            }
            Text("\(session.prompts) prompts · \(session.costUsd, format: .currency(code: "USD"))")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text("\(date(session.firstMs), format: .dateTime.hour().minute()) to \(date(session.lastMs), format: .dateTime.hour().minute())")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchEvent(id: id)
            guard !Task.isCancelled else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}

struct ItemDetailView: View {
    @Bindable var model: Telemetry
    let kind: StatsKind
    let name: String
    let onPush: (DetailRoute) -> Void

    @State private var detail: ItemDetail?
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let detail {
                statGrid(detail)
                repoSection(detail)
                recentSection(detail)
            } else if let loadError {
                EmptyState(
                    title: "Couldn't load",
                    symbol: "exclamationmark.triangle",
                    message: "\(loadError)",
                    retry: { Task { await load() } }
                )
            } else {
                DetailSkeleton()
            }
            refreshBar
        }
        .task(id: "\(kind.rawValue)/\(name)") { await load() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: kind.symbol).foregroundStyle(.secondary).frame(width: 18)
            Text(name).font(.headline).lineLimit(1).truncationMode(.middle)
            Spacer()
            Text(kind.label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var refreshBar: some View {
        HStack {
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                .controlSize(.small)
                .disabled(isLoading)
        }
    }

    private func statGrid(_ d: ItemDetail) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3)
        return LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            StatCell(title: "Count", value: "\(d.count)")
            StatCell(title: "Failures", value: "\(d.failures)", warn: d.failures > 0)
            StatCell(title: "Total", value: fmtMs(d.totalMs))
            StatCell(title: "p50", value: fmtMs(d.p50))
            StatCell(title: "p95", value: fmtMs(d.p95))
            StatCell(title: "Max", value: fmtMs(d.maxMs))
        }
    }

    private func repoSection(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("By repository")
            if d.repos.isEmpty {
                Text("No repository data.").font(.callout).foregroundStyle(.secondary)
            } else {
                let maxTotal = max(d.repos.map(\.totalMs).max() ?? 1, 1)
                ForEach(Array(d.repos.enumerated()), id: \.offset) { _, repo in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(repo.name ?? "Unknown").lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 8)
                            Text("\(repo.count) · \(fmtMs(repo.totalMs)) · p95 \(fmtMs(repo.p95))")
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                        .monospacedDigit()
                        GeometryReader { geo in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.blue.opacity(0.5))
                                .frame(width: geo.size.width * (repo.totalMs / maxTotal))
                        }
                        .frame(height: 4)
                    }
                    .help(repo.root ?? "Unknown repository")
                }
            }
        }
    }

    private func recentSection(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Recent calls")
            if d.recent.isEmpty {
                Text("No recent calls.").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(d.recent, id: \.id) { call in
                    Button { onPush(.event(id: call.id)) } label: {
                        HStack(spacing: 6) {
                            Text(date(call.tsMs), format: .dateTime.hour().minute().second())
                                .foregroundStyle(.tertiary)
                            if !call.ok {
                                Image(systemName: "xmark.octagon").foregroundStyle(.red)
                            }
                            Text(call.repo ?? "unknown").foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 8)
                            if let detail = call.detail {
                                Text(detail).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                            }
                            if let ms = call.ms {
                                Text(fmtMs(ms)).foregroundStyle(.secondary)
                            }
                        }
                        .font(.callout)
                        .monospacedDigit()
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .hoverRow()
                    .help(call.detail ?? "")
                }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchItem(kind: kind, name: name)
            guard !Task.isCancelled else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}

// MARK: - App

@main
struct ClaudeTelemetryApp: App {
    @State private var model = Telemetry()

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
        } label: {
            MenuBarLabel(status: model.status)
        }
        .menuBarExtraStyle(.window)
    }
}
