import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var model: Telemetry
    // Overlay navigation stack: empty closes it, one entry shows a detail, two lets "back" return
    // from a recent call's event detail to the aggregate that opened it.
    @State private var detailStack: [DetailRoute] = []
    @Environment(\.openSettings) private var openSettings
    @AppStorage(Prefs.Key.panelWidth) private var panelWidth = Prefs.Defaults.panelWidth
    @AppStorage(Prefs.Key.keepDetailOpen) private var keepDetailOpen = Prefs.Defaults.keepDetailOpen
    @AppStorage(Prefs.Key.enabledWindows) private var enabledWindowsRaw = Prefs.Defaults.enabledWindowsRaw

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            content
            Divider()
            footer
        }
        .padding(14)
        // An overlay takes the panel's size, so the card gets a fixed height to scroll in.
        .overlay { DetailOverlay(model: model, stack: $detailStack) }
        .frame(width: CGFloat(panelWidth))
        .onAppear { model.panelOpen = true }
        .onDisappear {
            model.panelOpen = false
            if !keepDetailOpen { detailStack = [] }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Claude Code").font(.headline)
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
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Window", selection: $model.minutes) {
                ForEach(Prefs.parseEnabledWindows(enabledWindowsRaw)) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
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

    @ViewBuilder private var content: some View {
        Group {
            if model.status == nil {
                EmptyState(
                    title: "Collector not running",
                    symbol: "bolt.horizontal.circle",
                    message: "Start it with `bun run start`.",
                    retry: model.retry
                )
                .id("offline")
            } else if let s = model.summary {
                if s.eventCount == 0 {
                    EmptyState(
                        title: "No telemetry yet",
                        symbol: "antenna.radiowaves.left.and.right",
                        message: "Nothing in this window. Enable telemetry for Claude Code from the dashboard."
                    )
                    .id("empty")
                } else {
                    SummaryView(
                        summary: s,
                        live: model.live,
                        onSelectItem: { kind, name in
                            withAnimation(panelAnimation()) { detailStack = [.item(kind: kind, name: name)] }
                        },
                        onSelectEvent: { id in
                            withAnimation(panelAnimation()) { detailStack = [.event(id: id)] }
                        }
                    )
                    .id("summary")
                }
            } else if let error = model.summaryError {
                EmptyState(
                    title: "Couldn't load summary",
                    symbol: "exclamationmark.triangle",
                    message: "\(error) Retrying every \(Int(model.retryDelaySec))s.",
                    retry: model.retry
                )
                .id("error")
            } else {
                SkeletonView().id("loading")
            }
        }
        .transition(.opacity)
    }

    private var footer: some View {
        HStack {
            Button("Open Dashboard", systemImage: "arrow.up.right.square") {
                NSWorkspace.shared.open(model.collectorURL)
            }
            .keyboardShortcut("d")
            .help("Open the dashboard in your browser (⌘D)")
            Spacer()
            Button("Settings", systemImage: "gearshape", action: openSettingsWindow)
                .keyboardShortcut(",")
                .help("Open Settings (⌘,)")
            Button("Quit") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
    }

    // openSettings() creates its window asynchronously, and this LSUIElement app has no Dock icon
    // to click for focus, so raise the window by hand a beat after asking for it.
    private func openSettingsWindow() {
        openSettings()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            NSApp.activate(ignoringOtherApps: true)
            // Match by identifier: the title follows the selected tab, and a fallback could raise the panel.
            let settingsWindow = NSApp.windows.first { $0.identifier?.rawValue.contains("Settings") == true }
            settingsWindow?.makeKeyAndOrderFront(nil)
        }
    }
}
