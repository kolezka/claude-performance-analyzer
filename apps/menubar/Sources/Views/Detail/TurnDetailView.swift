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
        VStack(alignment: .leading, spacing: 12) {
            if let detail {
                header(detail)
                if let breakdown = detail.breakdown {
                    Breakdown(breakdown: Summary.Breakdown(api: breakdown.apiMs, tools: breakdown.toolMs, hooks: breakdown.hookMs))
                }
                waterfall(detail)
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
            refreshBar
        }
        .task(id: "\(model.selectionGeneration)/\(promptId)") { await load() }
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

    private func header(_ d: TurnDetail) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let folder = d.folder {
                HStack(spacing: 8) {
                    Text(displayPath(folder, hostId: model.selectedHostId))
                        .font(.headline)
                        .monospaced()
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let branch = d.branch {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .help(folder)
                if let sessionLabel = d.sessionLabel {
                    Text(sessionLabel).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            } else {
                Text(d.sessionLabel ?? d.repo ?? "Unknown session")
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let command = d.command {
                Text(command)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Text(fmtTurnDuration(activeMs: d.activeMs, idleMs: d.idleMs, wallMs: d.endMs - d.startMs))
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
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
