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
                if detail.spans.isEmpty {
                    Text("No spans recorded for this turn.").font(.callout).foregroundStyle(.secondary)
                } else {
                    WaterfallView(
                        spans: detail.spans,
                        startMs: detail.startMs,
                        endMs: detail.endMs,
                        gaps: detail.gaps ?? [],
                        onSelect: { id in onPush(.event(id: id)) }
                    )
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
            refreshBar
        }
        .task(id: promptId) { await load() }
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
            Text(d.sessionLabel ?? d.repo ?? "Unknown session")
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
            if let command = d.command {
                Text(command)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            HStack(spacing: 10) {
                if let repo = d.repo {
                    Label(repo, systemImage: "folder").lineLimit(1).truncationMode(.middle)
                }
                Text(fmtTurnDuration(activeMs: d.activeMs, idleMs: d.idleMs, wallMs: d.endMs - d.startMs))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchTurn(promptId: promptId)
            guard !Task.isCancelled else { return }
            detail = d
            notFound = d == nil
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}
