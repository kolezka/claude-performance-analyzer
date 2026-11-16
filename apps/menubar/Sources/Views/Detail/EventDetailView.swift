import SwiftUI

struct EventDetailView: View {
    @Bindable var model: Telemetry
    let id: Int

    @State private var detail: EventDetail?
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let detail {
                header(detail)
                if !detail.details.isEmpty { detailsSection(detail.details) }
                repositorySection(detail.session)
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
        }
        .toolbar { RefreshToolbar(isLoading: isLoading) { Task { await load() } } }
        .task(id: "\(model.selectionGeneration)/\(id)") { await load() }
    }

    private func header(_ d: EventDetail) -> some View {
        DetailHeader(
            symbol: d.ok ? LiveFeed.symbol(d.kind) : "xmark.octagon",
            tint: d.ok ? Kind.tint(d.kind) : .red,
            title: d.label,
            subtitle: subtitle(d)
        ) {
            OkBadge(ok: d.ok)
        }
    }

    private func subtitle(_ d: EventDetail) -> String {
        let time = date(d.tsMs).formatted(.dateTime.month().day().hour().minute().second())
        return [time, d.ms.map(fmtMs)].compactMap { $0 }.joined(separator: " · ")
    }

    private func repositorySection(_ session: SessionInfo?) -> some View {
        DetailSection("Repository", symbol: "folder") {
            if let repo = session?.repo {
                let path = repo.worktree ?? repo.root
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    InfoRow("Name", repo.name)
                    InfoRow("Path", displayPath(path, hostId: model.selectedHostId), mono: true)
                    if let branch = session?.branch { InfoRow("Branch", branch, mono: true) }
                }
                if let session {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Inferred from \(session.pathsSeen) path\(session.pathsSeen == 1 ? "" : "s").")
                        if !session.otherRepos.isEmpty {
                            Text("Also seen: \(session.otherRepos.joined(separator: ", "))")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.tertiary)
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
        DetailSection("Details", symbol: "info.circle") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                ForEach(details, id: \.key) { d in
                    InfoRow(title: d.key) {
                        Text(d.value)
                            .textSelection(.enabled)
                            .lineLimit(4)
                            .help(d.value)
                    }
                }
            }
        }
    }

    private func sessionSection(_ session: SessionInfo) -> some View {
        DetailSection("Session", symbol: "terminal") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                InfoRow(title: "ID") {
                    HStack(spacing: 6) {
                        Text(String(session.sessionId.prefix(8)))
                            .monospaced()
                            .help(session.sessionId)
                        CopyButton(value: session.sessionId, help: "Copy session id")
                    }
                }
                if let kindLabel = session.kindLabel { InfoRow("Kind", kindLabel) }
                if let terminal = session.terminal { InfoRow("Terminal", terminal) }
                if let version = session.claudeVersion { InfoRow("Claude Code", version) }
                if !session.models.isEmpty { InfoRow("Models", session.models.joined(separator: ", ")) }
                InfoRow(title: "Usage") {
                    Text("\(session.prompts) prompts · \(session.costUsd, format: .currency(code: "USD"))").monospacedDigit()
                }
                InfoRow(title: "Active") {
                    Text("\(date(session.firstMs), format: .dateTime.hour().minute()) to \(date(session.lastMs), format: .dateTime.hour().minute())")
                        .monospacedDigit()
                }
            }
        }
    }

    // Also runs from Refresh, outside .task, so it checks the generation itself.
    private func load() async {
        let generation = model.selectionGeneration
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchEvent(id: id)
            guard !Task.isCancelled, generation == model.selectionGeneration else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled, !Telemetry.isStale(error), generation == model.selectionGeneration else { return }
            loadError = error.localizedDescription
        }
    }
}
