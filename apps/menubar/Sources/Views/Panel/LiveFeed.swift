import SwiftUI

struct LiveFeed: View {
    // The whole feed, newest first. Ids are counted over all of it, then only the top rows show.
    let events: [LiveEvent]
    // Hooks still running, shown above the rows with an elapsed time read against `now`.
    let running: [RunningHook]
    let now: Date
    var onSelect: (Int) -> Void = { _ in }
    @AppStorage(Prefs.Key.liveFeedLength) private var liveFeedLength = Prefs.Defaults.liveFeedLength

    var body: some View {
        if !events.isEmpty || !running.isEmpty {
            Card(padding: 6) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(running) { hook in runningRow(hook) }
                    let ids = rowIds(events.map(\.liveKey))
                    ForEach(Array(zip(ids, events).prefix(Prefs.clamp(liveFeedLength, 5...15))), id: \.0) { _, e in
                        row(e)
                    }
                }
                .clipped()
            }
        } else {
            Card {
                Label("Waiting for events…", systemImage: "dot.radiowaves.left.and.right")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
        }
    }

    // The counter is information, not decoration, so it updates even with animations off.
    private func runningRow(_ hook: RunningHook) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.mini).frame(width: 52, alignment: .leading)
            KindIcon(symbol: Self.symbol("hook"), tint: Kind.tint("hook"), size: 20)
            Text(hook.label).lineLimit(1).truncationMode(.middle)
            Tag("Running", tint: .orange)
            Spacer(minLength: 8)
            Text(fmtMs(max(0, now.timeIntervalSince1970 * 1000 - hook.startedMs))).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
        .font(.callout)
        .monospacedDigit()
        .help("\(hook.label) started and has not finished yet")
    }

    @ViewBuilder
    private func row(_ e: LiveEvent) -> some View {
        let label = HStack(spacing: 8) {
            Text(date(e.tsMs), format: .dateTime.hour().minute().second())
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(width: 52, alignment: .leading)
            KindIcon(symbol: e.ok ? Self.symbol(e.kind) : "xmark", tint: e.ok ? Kind.tint(e.kind) : .red, size: 20)
            Text(e.label).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if let ms = e.ms {
                Text(fmtMs(ms)).foregroundStyle(.secondary)
            }
            if e.id != nil {
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
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
