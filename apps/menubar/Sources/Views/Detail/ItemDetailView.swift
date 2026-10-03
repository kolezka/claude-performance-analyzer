import SwiftUI

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
