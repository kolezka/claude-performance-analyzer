import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var model: Telemetry
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @AppStorage(Prefs.Key.panelWidth) private var panelWidth = Prefs.Defaults.panelWidth
    @AppStorage(Prefs.Key.showWaterfall) private var showWaterfall = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.enabledWindows) private var enabledWindowsRaw = Prefs.Defaults.enabledWindowsRaw
    @State private var contentHeight: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    @State private var screenHeight: CGFloat?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            // A ScrollView has no height of its own here, so it gets the measured content height,
            // capped so the panel never runs past the bottom of the screen.
            ScrollView {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(contentHeight, maxContentHeight))
            Divider()
            footer.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
        }
        .padding(14)
        .background(ScreenHeightReader { screenHeight = $0 })
        .frame(width: CGFloat(panelWidth))
        .onAppear { model.panelOpen = true }
        .onDisappear { model.panelOpen = false }
    }

    // Opens or refocuses the Details window on the given route, the same way the status-item
    // menu raises Settings: the window is created async, so it gets activated a beat later too.
    private func openDetail(_ route: DetailRoute) {
        model.navigator.open(route)
        showDetailsWindow(using: openWindow)
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("Claude Code").font(.headline)
                    if showHostPicker { hostPicker }
                }
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
        .fixedSize()
        .help(model.hostsError.map { "Host list unavailable: \($0)" } ?? "Which machine's telemetry to show")
    }

    // Uses the screen the panel is on. Its visibleFrame already excludes the menu bar and the Dock.
    // The rest is padding, the three stack gaps, the divider and a small margin under the panel.
    private var maxContentHeight: CGFloat {
        let available = screenHeight ?? NSScreen.main?.visibleFrame.height ?? 800
        return max(200, available - headerHeight - footerHeight - 28 - 42 - 1 - 16)
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
                    message: LocalizedStringKey(CollectorAgent.offlineHint),
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
                    VStack(alignment: .leading, spacing: 14) {
                        SummaryView(
                            summary: s,
                            live: model.live,
                            onSelectItem: { kind, name in openDetail(.item(kind: kind, name: name)) },
                            onSelectEvent: { id in openDetail(.event(id: id)) }
                        )
                        if showWaterfall {
                            TurnSection(
                                model: model,
                                onSelectEvent: { id in openDetail(.event(id: id)) },
                                onOpenTurn: { promptId in openDetail(.turn(promptId: promptId)) }
                            )
                        }
                    }
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
                NSWorkspace.shared.open(model.dashboardURL)
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

    private func openSettingsWindow() {
        showSettingsWindow(using: openSettings)
    }
}
