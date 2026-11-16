import SwiftUI

// Shared building blocks for the panel and the Details window, so both read as one app:
// grouped content sits on a soft rounded card, every section has the same header, and each
// kind of event keeps one color everywhere (api blue, tools purple, hooks orange, agents teal).

enum Kind {
    static func tint(_ kind: String) -> Color {
        switch kind {
        case "api": .blue
        case "tool", "tools": .purple
        case "hook", "hooks", "hook_start": .orange
        case "agent", "agents": .teal
        case "skill": .pink
        case "mcp": .indigo
        case "error": .red
        default: .secondary
        }
    }
}

extension StatsKind {
    var tint: Color { Kind.tint(rawValue) }
}

// A rounded group with a faint fill, the way System Settings and Control Center group content.
struct Card<Content: View>: View {
    var padding: CGFloat = 10
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator.opacity(0.6), lineWidth: 0.5))
    }
}

// Section header: a title on the left and optional controls on the right.
struct SectionHeader<Trailing: View>: View {
    let title: String
    var symbol: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol).foregroundStyle(.secondary).imageScale(.small)
            }
            Text(title).font(.subheadline.weight(.semibold))
            Spacer(minLength: 8)
            trailing
        }
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String, symbol: String? = nil) {
        self.init(title: title, symbol: symbol) { EmptyView() }
    }
}

// A titled card: the standard section in the Details window.
struct DetailSection<Content: View, Trailing: View>: View {
    let title: String
    var symbol: String?
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: title, symbol: symbol) { trailing }
                .padding(.horizontal, 2)
            Card(padding: 12) {
                VStack(alignment: .leading, spacing: 8) { content }
            }
        }
    }
}

extension DetailSection where Trailing == EmptyView {
    init(_ title: String, symbol: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, symbol: symbol, trailing: { EmptyView() }, content: content)
    }
}

// The icon tile that leads every Details header.
struct KindIcon: View {
    let symbol: String
    let tint: Color
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.45, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.15), in: .rect(cornerRadius: size * 0.26))
    }
}

// Title block at the top of each Details page.
struct DetailHeader<Accessory: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    var subtitle: String?
    var monospacedTitle = false
    @ViewBuilder let accessory: Accessory

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            KindIcon(symbol: symbol, tint: tint, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(monospacedTitle ? .title3.weight(.semibold).monospaced() : .title2.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            accessory
        }
    }
}

// A big number with a small label above it.
struct MetricTile: View {
    let title: String
    let value: String
    var warn = false
    var size: Font = .title3

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(size.weight(.semibold))
                .fontDesign(.rounded)
                .monospacedDigit()
                .foregroundStyle(warn ? Color.orange : Color.primary)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// Label and value on one line, labels in a fixed column. Use inside a Grid.
struct InfoRow<Value: View>: View {
    let title: String
    @ViewBuilder let value: Value

    var body: some View {
        GridRow(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.trailing)
            value
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.callout)
    }
}

extension InfoRow where Value == InfoText {
    init(_ title: String, _ text: String, missing: Bool = false, mono: Bool = false) {
        self.init(title: title) { InfoText(text: text, missing: missing, mono: mono) }
    }
}

struct InfoText: View {
    let text: String
    var missing = false
    var mono = false

    var body: some View {
        Text(text)
            .monospaced(mono)
            .foregroundStyle(missing ? .tertiary : .primary)
            .lineLimit(2)
            .truncationMode(.middle)
            .textSelection(.enabled)
            .help(text)
    }
}

// Small rounded tag, for sources, session kinds and similar labels.
struct Tag: View {
    let text: String
    var tint: Color = .secondary

    init(_ text: String, tint: Color = .secondary) {
        self.text = text
        self.tint = tint
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: .capsule)
            .foregroundStyle(tint)
            .lineLimit(1)
    }
}

// The Refresh button every Details page puts in the window toolbar (⌘R).
struct RefreshToolbar: ToolbarContent {
    let isLoading: Bool
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            if isLoading {
                ProgressView().controlSize(.small)
            } else {
                Button("Refresh", systemImage: "arrow.clockwise", action: action)
                    .keyboardShortcut("r")
                    .help("Refresh (⌘R)")
            }
        }
    }
}

// Copy button shown next to ids and commands.
struct CopyButton: View {
    let value: String
    var help = "Copy"

    var body: some View {
        Button { copyToPasteboard(value) } label: {
            Image(systemName: "doc.on.doc")
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .help(help)
    }
}
