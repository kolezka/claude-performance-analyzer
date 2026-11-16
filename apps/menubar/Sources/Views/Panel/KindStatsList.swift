import SwiftUI

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
    let footnote: String?
    @AppStorage private var kind: StatsKind
    @AppStorage(Prefs.Key.rowsPerList) private var rowsPerList = Prefs.Defaults.rowsPerList

    init(
        title: String,
        summary: Summary,
        storageKey: String,
        defaultKind: StatsKind,
        metric: @escaping (Stats) -> Double,
        value: @escaping (Stats) -> String,
        warn: @escaping (StatsKind, Stats) -> Bool = { _, _ in false },
        onSelect: @escaping (StatsKind, String) -> Void = { _, _ in },
        footnote: String? = nil
    ) {
        self.title = title
        self.summary = summary
        self.metric = metric
        self.value = value
        self.warn = warn
        self.onSelect = onSelect
        self.footnote = footnote
        _kind = AppStorage(wrappedValue: defaultKind, storageKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: title) {
                Picker("Kind", selection: $kind) {
                    ForEach(StatsKind.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
            }
            .padding(.horizontal, 2)
            Card(padding: 6) {
                VStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty {
                        Text("Nothing in this window.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(6)
                    }
                    // A hook and a tool can share a name, so the kind is part of the key.
                    let ids = rowIds(rows.map { "\($0.0.rawValue)/\($0.1.name)" })
                    let maxValue = max(rows.map { metric($0.1) }.max() ?? 1, 1)
                    ForEach(Array(zip(ids, rows).enumerated()), id: \.element.0) { index, pair in
                        let (rowKind, row) = pair.1
                        if index > 0 { Divider().padding(.leading, 34) }
                        Button { onSelect(rowKind, row.name) } label: {
                            HStack(spacing: 8) {
                                // Shown for every kind, so rows keep their alignment when the picker changes.
                                KindIcon(symbol: rowKind.symbol, tint: rowKind.tint, size: 22)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
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
                                    }
                                    // Share of the top row, so the list reads at a glance.
                                    Capsule()
                                        .fill(rowKind.tint.opacity(0.55))
                                        .frame(height: 3)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .scaleEffect(x: max(0.02, metric(row) / maxValue), anchor: .leading)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 4)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .font(.callout)
                        .hoverRow()
                        .help(row.name)
                        .transition(.opacity)
                    }
                }
            }
            .animation(panelAnimation(), value: kind)
            if let footnote {
                Text(footnote).font(.caption2).foregroundStyle(.tertiary).padding(.horizontal, 2)
            }
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
        return Array(picked.sorted { metric($0.1) > metric($1.1) }.prefix(Prefs.clamp(rowsPerList, 3...8)))
    }
}
