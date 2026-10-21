import SwiftUI

struct ItemDetailView: View {
    enum CallList: Hashable { case slowest, errors, recent }

    @Bindable var model: Telemetry
    let kind: StatsKind
    let name: String
    let onPush: (DetailRoute) -> Void

    @State private var detail: ItemDetail?
    @State private var loadError: String?
    @State private var isLoading = false
    @State private var expandedDefinition: Int?
    @State private var selectedPattern: String?
    @State private var callList: CallList?
    @AppStorage(Prefs.Key.hideHeadlessSessions) private var hideHeadlessSessions = Prefs.Defaults.hideHeadlessSessions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let detail, kind == .hooks {
                statGrid(detail)
                if let finding = detail.finding { findingCallout(finding) }
                headlessToggle(detail)
                if let patterns = detail.patterns, !patterns.isEmpty { patternsSection(patterns) }
                hookCallsSection(detail)
                hooksSection(detail)
                DisclosureGroup {
                    repoSection(detail, title: nil)
                } label: {
                    SectionTitle("By repository")
                }
            } else if let detail {
                statGrid(detail)
                headlessToggle(detail)
                repoSection(detail, title: "By repository")
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
        .task(id: "\(kind.rawValue)/\(name)/\(model.minutes)/\(hideHeadlessSessions)/\(selectedPattern ?? "")") { await load() }
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
            if let hidden = d.hiddenByHeadless {
                Text("Hiding \(hidden.calls) call\(hidden.calls == 1 ? "" : "s") (\(hidden.errors) error\(hidden.errors == 1 ? "" : "s")) from headless sessions.")
                    .font(.caption2)
                    .foregroundStyle(hidden.errors > 0 ? Color.orange : Color.secondary)
            } else if let headlessCount = d.headlessCount, headlessCount > 0 {
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

    private func repoSection(_ d: ItemDetail, title: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title { SectionTitle(title) }
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

    private func findingCallout(_ finding: String) -> some View {
        Label(finding, systemImage: "exclamationmark.triangle")
            .font(.callout)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }

    private func patternsSection(_ patterns: [ItemDetail.Pattern]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Patterns")
            ForEach(patterns, id: \.key) { pattern in
                let selected = selectedPattern == pattern.key
                Button {
                    selectedPattern = selected ? nil : pattern.key
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: selected ? "line.3.horizontal.decrease.circle.fill" : "circle")
                            .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                            .font(.caption)
                        Text(pattern.label).foregroundStyle(pattern.errors > 0 ? Color.orange : Color.primary)
                        Spacer(minLength: 8)
                        Text("\(pattern.count) · p95 \(fmtMs(pattern.p95))").foregroundStyle(.secondary)
                    }
                    .font(.callout)
                    .monospacedDigit()
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .hoverRow()
                .help(selected ? "Show all calls" : "Show only calls with this pattern")
            }
        }
    }

    private func hookCallsSection(_ d: ItemDetail) -> some View {
        let hasSlowest = d.slowest != nil
        let current = callList ?? (hasSlowest ? .slowest : .recent)
        let calls: [ItemDetail.Recent] =
            switch current {
            case .slowest: d.slowest ?? []
            case .errors: d.failed ?? []
            case .recent: d.recent
            }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionTitle("Calls")
                Spacer()
                Picker("Calls", selection: Binding(get: { current }, set: { callList = $0 })) {
                    if hasSlowest { Text("Slowest").tag(CallList.slowest) }
                    Text("Errors").tag(CallList.errors)
                    Text("Recent").tag(CallList.recent)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.mini)
                .fixedSize()
            }
            if calls.isEmpty {
                Text(current == .errors ? "No calls with errors." : "No calls.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                hookCallRows(calls)
            }
        }
    }

    private func hookCallRows(_ calls: [ItemDetail.Recent]) -> some View {
        ForEach(calls, id: \.id) { call in
            Button { openCall(call) } label: {
                HStack(spacing: 6) {
                    Text(date(call.tsMs), format: .dateTime.hour().minute().second())
                        .foregroundStyle(.tertiary)
                    Text(call.ms.map(fmtMs) ?? "Not captured")
                        .foregroundStyle(call.ms == nil ? .tertiary : .primary)
                    if let pattern = call.pattern {
                        Text(pattern).foregroundStyle(call.ok ? Color.secondary : Color.red).lineLimit(1)
                    }
                    if let sessionKind = call.sessionKind {
                        Text(sessionKind.capitalized)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.secondary.opacity(0.15), in: .capsule)
                            .foregroundStyle(.secondary)
                            .help(call.launcher.map { "Launched by \($0)" } ?? (call.sessionLabel ?? ""))
                    }
                    Spacer(minLength: 8)
                    Text(call.folder.map(abbreviateHome) ?? "Folder not recorded")
                        .monospaced()
                        .foregroundStyle(call.folder == nil ? .tertiary : .secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(call.folder ?? "Folder not recorded")
                }
                .font(.callout)
                .monospacedDigit()
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .hoverRow()
        }
    }

    private func hooksSection(_ d: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                SectionTitle("Hooks in this group")
                Text("Current configuration").font(.caption2).foregroundStyle(.tertiary)
            }
            let definitions = d.definitions ?? []
            if definitions.isEmpty {
                Text("No registered hooks found for this event in these sessions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                // An older collector sends no patterns and no timeouts, so it gets no timeout line
                // rather than a "No timeout set" it never reported.
                let knowsTimeouts = d.patterns != nil
                ForEach(Array(definitions.enumerated()), id: \.offset) { index, def in
                    definitionRow(index, def, showTimeout: knowsTimeouts)
                }
            }
        }
    }

    private func definitionRow(_ index: Int, _ def: ItemDetail.Definition, showTimeout: Bool) -> some View {
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
                    if showTimeout {
                        Text(def.timeoutSec.map { "Timeout: \(fmtSeconds($0))" } ?? "No timeout set")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
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
                        Text(call.folder.map(abbreviateHome) ?? "folder unknown")
                            .monospaced()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(call.folder ?? "folder unknown")
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
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .hoverRow()
            .help(call.detail ?? "")
        }
    }

    private func openCall(_ call: ItemDetail.Recent) {
        if kind == .hooks {
            onPush(.hookCall(id: call.id))
        } else if let promptId = call.promptId {
            onPush(.turn(promptId: promptId))
        } else {
            onPush(.event(id: call.id))
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchItem(
                kind: kind, name: name, excludeHeadless: hideHeadlessSessions, pattern: kind == .hooks ? selectedPattern : nil)
            guard !Task.isCancelled else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}
