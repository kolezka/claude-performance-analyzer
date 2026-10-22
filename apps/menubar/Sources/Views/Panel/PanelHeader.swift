import SwiftUI

// The panel's title, collector state, host picker and time window picker.
struct PanelHeader: View {
    @Bindable var model: Telemetry
    let windows: [Prefs.WindowOption]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Title and window picker share a row when they fit. With many windows enabled in a
            // narrow panel the picker drops under the title instead of pushing the panel wider.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center) {
                    titleAndState
                    Spacer(minLength: 8)
                    windowPicker
                }
                VStack(alignment: .leading, spacing: 6) {
                    titleAndState
                    windowPicker
                }
            }
            // On its own row so a long host name truncates instead of clipping the panel.
            if showHostPicker { hostPicker }
        }
    }

    private var titleAndState: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Claude Code").font(.headline).lineLimit(1)
            HStack(spacing: 5) {
                // Pulses only while events are arriving, so a calm panel stays still.
                Image(systemName: "circle.fill")
                    .font(.system(size: 7))
                    .foregroundStyle(stateColor)
                    .symbolEffect(.pulse, isActive: recentlyActive)
                Text(stateText).contentTransition(.opacity)
                if let updatedAt = model.updatedAt, model.status != nil {
                    Text("· updated \(Text(updatedAt, style: .relative)) ago")
                }
                // Keep the last numbers on a failed refresh, but say they are stale.
                if model.summaryError != nil, model.summary != nil, model.status != nil {
                    Text("· refresh failed").foregroundStyle(.orange)
                }
            }
            .lineLimit(1)
            .font(.caption)
            .foregroundStyle(.secondary)
            // No ideal width, so the ticking "updated" text never decides which row layout is used.
            .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
        }
    }

    private var windowPicker: some View {
        Picker("Window", selection: $model.minutes) {
            ForEach(windows) { option in
                Text(option.label).tag(option.rawValue)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }

    // Someone who never added a host sees the header exactly as before.
    private var showHostPicker: Bool {
        model.isRemoteSelected || model.hosts.contains { !$0.isLocal }
    }

    private var hostPicker: some View {
        Picker("Host", selection: $model.selectedHostId) {
            ForEach(model.hosts) { host in
                Text(host.name).tag(host.id)
            }
            // A saved host the collector has not confirmed yet still needs a row to show as selected.
            if !model.hosts.contains(where: { $0.id == model.selectedHostId }) {
                Text(model.selectedHostName).tag(model.selectedHostId)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(model.hostsError.map { "Host list unavailable: \($0)" } ?? "Which machine's telemetry to show")
    }

    // "ok" covers any API request in the last 15 minutes, which is too long to call live.
    private var recentlyActive: Bool {
        guard model.status != nil, let newest = model.live.first else { return false }
        return Date.now.timeIntervalSince1970 * 1000 - newest.tsMs < 60_000
    }

    private var stateColor: Color {
        switch model.status?.state {
        case nil: .red
        case "slow": .orange
        case "idle": .secondary
        default: .green
        }
    }

    private var stateText: String {
        switch model.status?.state {
        case nil: "Collector offline"
        case "slow": "Hooks slow"
        case "idle": "Idle"
        default: "OK"
        }
    }
}
