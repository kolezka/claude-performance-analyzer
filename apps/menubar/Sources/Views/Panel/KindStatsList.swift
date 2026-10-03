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
            if let footnote {
                Text(footnote).font(.caption2).foregroundStyle(.tertiary)
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
