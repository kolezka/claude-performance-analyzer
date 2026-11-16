import SwiftUI

struct TurnDetailView: View {
    @Bindable var model: Telemetry
    let promptId: String
    let onPush: (DetailRoute) -> Void

    @State private var detail: TurnDetail?
    @State private var notFound = false
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let detail {
                header(detail)
                if let breakdown = detail.breakdown {
                    Card(padding: 12) {
                        Breakdown(breakdown: Summary.Breakdown(api: breakdown.apiMs, tools: breakdown.toolMs, hooks: breakdown.hookMs))
                    }
                }
                DetailSection("Timeline", symbol: "chart.bar.doc.horizontal") {
                    waterfall(detail)
                }
            } else if notFound {
                EmptyState(
                    title: "Turn not found",
                    symbol: "clock.badge.questionmark",
                    message: "No events are recorded for this prompt anymore."
                )
            } else if let loadError {
                EmptyState(
                    title: "Couldn't load turn",
                    symbol: "exclamationmark.triangle",
                    message: "\(loadError)",
                    retry: { Task { await load() } }
                )
            } else {
                DetailSkeleton()
            }
        }
        .toolbar { RefreshToolbar(isLoading: isLoading) { Task { await load() } } }
        .task(id: "\(model.selectionGeneration)/\(promptId)") { await load() }
    }

    private func header(_ d: TurnDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeader(
                symbol: "text.bubble",
                tint: .blue,
                title: d.folder.map { displayPath($0, hostId: model.selectedHostId) } ?? d.sessionLabel ?? d.repo ?? "Unknown session",
                subtitle: d.folder != nil ? d.sessionLabel : nil,
                monospacedTitle: d.folder != nil
            ) {
                if let branch = d.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .help(d.folder ?? "")
            Card(padding: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        MetricTile(title: "Wall", value: fmtMs(d.endMs - d.startMs))
                        if let active = d.activeMs { MetricTile(title: "Active", value: fmtMs(active)) }
                        if let idle = d.idleMs { MetricTile(title: "Idle", value: fmtMs(idle)) }
                        MetricTile(title: "Started", value: date(d.startMs).formatted(.dateTime.hour().minute().second()))
                    }
                    if let command = d.command {
                        Divider()
                        Text(command)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    // Lane-grouped rendering needs both lanes and a non-empty row list; an older collector,
    // or a turn with no recorded rows, falls back to the flat span waterfall.
    @ViewBuilder
    private func waterfall(_ d: TurnDetail) -> some View {
        if let lanes = d.lanes, let rows = d.rows, !rows.isEmpty {
            LaneWaterfallView(
                lanes: lanes,
                rows: rows,
                startMs: d.startMs,
                endMs: d.endMs,
                gaps: d.gaps ?? [],
                onSelect: { id in onPush(.event(id: id)) }
            )
        } else if !d.spans.isEmpty {
            WaterfallView(
                spans: d.spans,
                startMs: d.startMs,
                endMs: d.endMs,
                gaps: d.gaps ?? [],
                onSelect: { id in onPush(.event(id: id)) }
            )
        } else {
            Text("No spans recorded for this turn.").font(.callout).foregroundStyle(.secondary)
        }
    }

    // Also runs from Refresh, outside .task, so it checks the generation itself.
    private func load() async {
        let generation = model.selectionGeneration
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchTurn(promptId: promptId)
            guard !Task.isCancelled, generation == model.selectionGeneration else { return }
            detail = d
            notFound = d == nil
            loadError = nil
        } catch {
            guard !Task.isCancelled, !Telemetry.isStale(error), generation == model.selectionGeneration else { return }
            loadError = error.localizedDescription
        }
    }
}
