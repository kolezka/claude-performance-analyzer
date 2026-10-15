import SwiftUI

struct ItemDetailView: View {
    @Bindable var model: Telemetry
    let kind: StatsKind
    let name: String
    let onPush: (DetailRoute) -> Void

    @State private var detail: ItemDetail?
    @State private var loadError: String?
    @State private var isLoading = false
    @State private var expandedDefinition: Int?
    @AppStorage(Prefs.Key.hideHeadlessSessions) private var hideHeadlessSessions = Prefs.Defaults.hideHeadlessSessions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let detail {
                statGrid(detail)
                headlessToggle(detail)
                repoSection(detail)
                if kind == .hooks { hooksSection(detail) }
                if let failed = detail.failed, !failed.isEmpty { failedSection(failed) }
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
        .task(id: "\(kind.rawValue)/\(name)/\(model.minutes)/\(hideHeadlessSessions)") { await load() }
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

    private func headlessToggle(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle("Hide headless SDK sessions", isOn: $hideHeadlessSessions)
                .toggleStyle(.checkbox)
                .font(.caption)
            if let headlessCount = d.headlessCount, headlessCount > 0 {
                Text(
                    hideHeadlessSessions
                        ? "\(headlessCount) calls from headless sessions hidden."
                        : "Includes \(headlessCount) calls from headless SDK sessions."
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
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
                            Text(repo.label ?? repo.name ?? "Unknown").lineLimit(1).truncationMode(.middle)
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

    private func hooksSection(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Hooks in this group")
            let definitions = d.definitions ?? []
            if definitions.isEmpty {
                Text("No registered hooks found for this event in these sessions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(definitions.enumerated()), id: \.offset) { index, def in
                    definitionRow(index, def)
                }
            }
            Text("Telemetry reports time per group, not per script. Failures count hooks that returned a non-blocking error; the failing script is not reported.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func definitionRow(_ index: Int, _ def: ItemDetail.Definition) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(panelAnimation()) {
                    expandedDefinition = expandedDefinition == index ? nil : index
                }
            } label: {
                HStack(spacing: 6) {
                    sourceBadge(def.source)
                    if let plugin = def.plugin {
                        Text(plugin).font(.caption).foregroundStyle(.secondary)
                    }
                    if let matcher = def.matcher {
                        Text(matcher).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(def.summary).font(.callout).monospaced().lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text("in \(def.sessions) session\(def.sessions == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Image(systemName: expandedDefinition == index ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .hoverRow()

            if expandedDefinition == index {
                VStack(alignment: .leading, spacing: 4) {
                    if let command = def.command {
                        HStack(alignment: .top) {
                            Text(command)
                                .font(.caption)
                                .monospaced()
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Button { copyToPasteboard(command) } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .help("Copy command")
                        }
                        .padding(6)
                        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 5))
                    } else {
                        Text("No command recorded.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let configPath = def.configPath {
                        Text(abbreviateHome(configPath))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                }
                .padding(.leading, 4)
            }
        }
    }

    private func sourceBadge(_ source: String) -> some View {
        Text(source.capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(.secondary.opacity(0.15), in: .capsule)
            .foregroundStyle(.secondary)
    }

    private func failedSection(_ failed: [ItemDetail.Recent]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Failed calls")
            callRows(failed)
        }
    }

    private func recentSection(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Recent calls")
            if d.recent.isEmpty {
                Text("No recent calls.").font(.callout).foregroundStyle(.secondary)
            } else {
                callRows(d.recent)
            }
        }
    }

    private func callRows(_ calls: [ItemDetail.Recent]) -> some View {
        ForEach(calls, id: \.id) { call in
            Button { openCall(call) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(date(call.tsMs), format: .dateTime.hour().minute().second())
                            .foregroundStyle(.tertiary)
                        if !call.ok {
                            Image(systemName: "xmark.octagon").foregroundStyle(.red)
                        }
                        Text(call.sessionLabel ?? call.repo ?? "unknown").foregroundStyle(.secondary).lineLimit(1)
                        if let branch = call.branch {
                            Label(branch, systemImage: "arrow.triangle.branch")
                                .labelStyle(.titleOnly)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
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
                    if let hooks = call.hooks {
                        Text("\(hooks.count) hook\(hooks.count == 1 ? "" : "s") · \(hooks.errors) error\(hooks.errors == 1 ? "" : "s") · \(hooks.stdoutChars / 1000)k stdout")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .hoverRow()
            .help(call.detail ?? "")
        }
    }

    private func openCall(_ call: ItemDetail.Recent) {
        if let promptId = call.promptId {
            onPush(.turn(promptId: promptId))
        } else {
            onPush(.event(id: call.id))
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchItem(kind: kind, name: name, excludeHeadless: hideHeadlessSessions)
            guard !Task.isCancelled else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}
