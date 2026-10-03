import SwiftUI

struct LiveFeed: View {
    // The whole feed, newest first. Ids are counted over all of it, then only the top rows show.
    let events: [LiveEvent]
    var onSelect: (Int) -> Void = { _ in }
    @AppStorage(Prefs.Key.liveFeedLength) private var liveFeedLength = Prefs.Defaults.liveFeedLength

    var body: some View {
        if !events.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle("Live")
                let ids = rowIds(events.map { "\($0.tsMs)/\($0.sessionId ?? "")/\($0.kind)/\($0.label)" })
                ForEach(Array(zip(ids, events).prefix(Prefs.clamp(liveFeedLength, 5...15))), id: \.0) { _, e in
                    row(e)
                }
            }
            .clipped()
        }
    }

    @ViewBuilder
    private func row(_ e: LiveEvent) -> some View {
        let label = HStack(spacing: 6) {
            Text(date(e.tsMs), format: .dateTime.hour().minute().second())
                .foregroundStyle(.tertiary)
            Image(systemName: Self.symbol(e.kind))
                .foregroundStyle(e.ok ? Color.secondary : Color.red)
                .frame(width: 16)
            Text(e.label).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if let ms = e.ms {
                Text(fmtMs(ms)).foregroundStyle(.secondary)
            }
            if e.id != nil {
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .font(.callout)
        .monospacedDigit()

        Group {
            if let id = e.id {
                Button { onSelect(id) } label: { label.contentShape(.rect) }
                    .buttonStyle(.plain)
            } else {
                label
            }
        }
        .hoverRow()
        .help(e.label)
        // New events push in from the top; the oldest fades out at the bottom.
        .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "prompt": "text.bubble"
        case "api": "cloud"
        case "tool": "wrench.and.screwdriver"
        case "hook": "bolt"
        case "agent": "person.2"
        case "skill": "sparkles"
        case "mcp": "server.rack"
        case "error": "xmark.octagon"
        case "compaction": "arrow.down.right.and.arrow.up.left"
        default: "circle"
        }
    }
}
