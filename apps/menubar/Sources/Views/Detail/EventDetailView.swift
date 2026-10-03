import SwiftUI

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
