import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var model: Telemetry
    var screenHeightOverride: CGFloat?
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @AppStorage(Prefs.Key.panelWidth) private var panelWidth = Prefs.Defaults.panelWidth
    @AppStorage(Prefs.Key.showWaterfall) private var showWaterfall = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.enabledWindows) private var enabledWindowsRaw = Prefs.Defaults.enabledWindowsRaw
    @AppStorage(Prefs.Key.showKpis) private var showKpis = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLatencyChart) private var showLatencyChart = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showBreakdown) private var showBreakdown = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showSlowest) private var showSlowest = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showTotalTime) private var showTotalTime = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLiveFeed) private var showLiveFeed = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.panelTab) private var storedTab = PanelTab.overview
    @State private var contentHeight: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var tabBarHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    @State private var screenHeight: CGFloat?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(model: model, windows: Prefs.parseEnabledWindows(enabledWindowsRaw))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            if showsTabBar {
                tabBar.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tabBarHeight = $0 }
            }
            // A ScrollView has no height of its own here, so it gets the measured content height,
            // capped so the panel never runs past the bottom of the screen.
            ScrollView {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            // Ignore temporary overflow while fitting content animates to its new height.
            .scrollDisabled(contentHeight <= maxContentHeight)
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

    // Uses the screen the panel is on. Its visibleFrame already excludes the menu bar and the Dock.
    // The rest is padding, the stack gaps, the divider and a small margin under the panel.
    private var maxContentHeight: CGFloat {
        let available = screenHeightOverride ?? screenHeight ?? NSScreen.main?.visibleFrame.height ?? 800
        let tabs = showsTabBar ? tabBarHeight + 12 : 0
        return max(200, available - headerHeight - tabs - footerHeight - 28 - 36 - 1 - 16)
    }

    // Tabs whose sections are all switched off in Settings are left out.
    private var visibleTabs: [PanelTab] {
        PanelTab.allCases.filter { tab in
            switch tab {
            case .overview: showKpis || showLatencyChart || showBreakdown
            case .top: showSlowest || showTotalTime
            case .live: showLiveFeed
            case .turn: showWaterfall
            }
        }
    }

    private var showsTabBar: Bool {
        visibleTabs.count > 1 && model.status != nil && (model.summary?.eventCount ?? 0) > 0
    }

    private var tab: PanelTab {
        visibleTabs.contains(storedTab) ? storedTab : (visibleTabs.first ?? .overview)
    }

    private var tabBar: some View {
        Picker("Section", selection: Binding(get: { tab }, set: { new in
            withAnimation(panelAnimation()) { storedTab = new }
        })) {
            ForEach(visibleTabs) { t in
                Text(t.label).tag(t)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: .infinity)
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
                    Group {
                        if tab == .turn {
                            TurnSection(
                                model: model,
                                onSelectEvent: { id in openDetail(.event(id: id)) },
                                onOpenTurn: { promptId in openDetail(.turn(promptId: promptId)) }
                            )
                        } else {
                            SummaryView(
                                summary: s,
                                live: model.live,
                                running: model.runningHooks.entries,
                                now: model.clock,
                                tab: tab,
                                onSelectItem: { kind, name in openDetail(.item(kind: kind, name: name)) },
                                onSelectEvent: { id in openDetail(.event(id: id)) }
                            )
                        }
                    }
                    .id("summary-\(tab.rawValue)")
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
            Button("Settings…", systemImage: "gearshape", action: openSettingsWindow)
                .labelStyle(.iconOnly)
                .keyboardShortcut(",")
                .help("Settings… (⌘,)")
            Button("Quit", systemImage: "power") { NSApp.terminate(nil) }
                .labelStyle(.iconOnly)
                .keyboardShortcut("q")
                .help("Quit \(appDisplayName) (⌘Q)")
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }

    private func openSettingsWindow() {
        showSettingsWindow(using: openSettings)
    }
}
