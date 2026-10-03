import AppKit
import ServiceManagement
import SwiftUI

// MARK: - Preferences namespace

// Key strings and defaults for every setting this app persists, in one place so the Settings UI,
// Telemetry and "Reset All Settings" never drift from each other.
enum Prefs {
    enum Key {
        static let window = "window" // pre-existing key, kept as is so there is no migration
        static let collectorURL = "collectorURL"
        static let statusPollIntervalSec = "statusPollIntervalSec"
        static let panelPollIntervalSec = "panelPollIntervalSec"
        static let requestTimeoutSec = "requestTimeoutSec"
        static let retryDelaySec = "retryDelaySec"
        static let enabledWindows = "enabledWindows"
        static let keepDetailOpen = "keepDetailOpen"
        static let labelStyle = "labelStyle"
        static let offlineText = "offlineText"
        static let bounceIconOnSlow = "bounceIconOnSlow"
        static let panelWidth = "panelWidth"
        static let showKpis = "showKpis"
        static let showLatencyChart = "showLatencyChart"
        static let showBreakdown = "showBreakdown"
        static let showSlowest = "showSlowest"
        static let showTotalTime = "showTotalTime"
        static let showLiveFeed = "showLiveFeed"
        static let rowsPerList = "rowsPerList"
        static let liveFeedLength = "liveFeedLength"
        static let hideHookStartEvents = "hideHookStartEvents"
        static let hookWarnThresholdMs = "hookWarnThresholdMs"
        static let animationsMode = "animationsMode"

        // Everything "Reset All Settings" clears. "window" is included since it is the General
        // tab's default time window, just under its original pre-Settings name.
        static let allManaged = [
            window, collectorURL, statusPollIntervalSec, panelPollIntervalSec, requestTimeoutSec,
            retryDelaySec, enabledWindows, keepDetailOpen, labelStyle, offlineText, bounceIconOnSlow,
            panelWidth, showKpis, showLatencyChart, showBreakdown, showSlowest, showTotalTime,
            showLiveFeed, rowsPerList, liveFeedLength, hideHookStartEvents, hookWarnThresholdMs,
            animationsMode,
        ]
    }

    enum Defaults {
        static let collectorURLString = "http://127.0.0.1:4318/"
        static let minutes = 60
        static let statusPollIntervalSec = 2.0
        static let panelPollIntervalSec = 2.0
        static let requestTimeoutSec = 2.0
        static let retryDelaySec = 2.0
        static let enabledWindowsRaw = "15,60,1440,10080"
        static let keepDetailOpen = false
        static let bounceIconOnSlow = true
        static let panelWidth = 360
        static let showSection = true
        static let rowsPerList = 3
        static let liveFeedLength = 6
        static let hideHookStartEvents = true
        static let hookWarnThresholdMs = 2000.0
    }

    static func clamp<T: Comparable>(_ value: T, _ range: ClosedRange<T>) -> T {
        min(max(value, range.lowerBound), range.upperBound)
    }

    static var defaultCollectorURL: URL { URL(string: Defaults.collectorURLString)! }

    // A typed-in or stored collector URL is only ever applied once it is actually http(s) with a host.
    static func validCollectorURL(_ raw: String) -> URL? {
        guard let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              let url = components.url
        else { return nil }
        return url
    }

    static func loadCollectorURL() -> URL {
        let raw = UserDefaults.standard.string(forKey: Key.collectorURL) ?? Defaults.collectorURLString
        return validCollectorURL(raw) ?? defaultCollectorURL
    }

    // Shared by the three 1...60s settings (status/panel poll interval, retry delay).
    static func loadInterval(_ key: String, default def: Double) -> Double {
        let stored = UserDefaults.standard.object(forKey: key) as? Double ?? def
        return clamp(stored, 1...60)
    }

    static func loadRequestTimeout() -> Double {
        let stored = UserDefaults.standard.object(forKey: Key.requestTimeoutSec) as? Double ?? Defaults.requestTimeoutSec
        return clamp(stored, 1...30)
    }

    static func resourceTimeout(forRequestTimeout request: Double) -> Double {
        max(request * 2.5, request + 1)
    }

    enum WindowOption: Int, CaseIterable, Identifiable {
        case m15 = 15, h1 = 60, h6 = 360, h24 = 1440, d3 = 4320, d7 = 10080
        var id: Int { rawValue }
        var label: String {
            switch self {
            case .m15: "15m"
            case .h1: "1h"
            case .h6: "6h"
            case .h24: "24h"
            case .d3: "3d"
            case .d7: "7d"
            }
        }
    }

    // Falls back to the shipped default set if storage is empty or unparseable, so the header
    // picker and the default-window picker can never end up with zero choices.
    static func parseEnabledWindows(_ raw: String) -> [WindowOption] {
        let options = raw.split(separator: ",").compactMap { Int($0) }.compactMap(WindowOption.init(rawValue:))
        if options.isEmpty {
            return Defaults.enabledWindowsRaw.split(separator: ",").compactMap { Int($0) }.compactMap(WindowOption.init(rawValue:))
        }
        return options.sorted { $0.rawValue < $1.rawValue }
    }

    enum LabelStyle: String, CaseIterable {
        case iconAndValue, iconOnly, valueOnly
        var title: String {
            switch self {
            case .iconAndValue: "Icon and Value"
            case .iconOnly: "Icon Only"
            case .valueOnly: "Value Only"
            }
        }
    }

    enum OfflineText: String, CaseIterable {
        case off, dash, hidden
        var title: String {
            switch self {
            case .off: "\"off\""
            case .dash: "Dash (–)"
            case .hidden: "Hidden"
            }
        }
        // The text shown in place of the server's label while the collector is offline.
        var display: String? {
            switch self {
            case .off: "off"
            case .dash: "–"
            case .hidden: nil
            }
        }
    }

    enum AnimationsMode: String, CaseIterable {
        case on, off, followSystem
        var title: String {
            switch self {
            case .on: "On"
            case .off: "Off"
            case .followSystem: "Follow System"
            }
        }
    }

    static func animationsMode() -> AnimationsMode {
        let raw = UserDefaults.standard.string(forKey: Key.animationsMode) ?? AnimationsMode.followSystem.rawValue
        return AnimationsMode(rawValue: raw) ?? .followSystem
    }
}

// MARK: - Settings window

struct SettingsView: View {
    @Bindable var model: Telemetry

    var body: some View {
        TabView {
            GeneralSettingsTab(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }
            ConnectionSettingsTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
            MenuBarSettingsTab()
                .tabItem { Label("Menu Bar", systemImage: "menubar.rectangle") }
            PanelSettingsTab()
                .tabItem { Label("Panel", systemImage: "rectangle.on.rectangle") }
            AdvancedSettingsTab(model: model)
                .tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
        }
        .frame(width: 480)
        .scenePadding()
    }
}

struct GeneralSettingsTab: View {
    @Bindable var model: Telemetry
    @AppStorage(Prefs.Key.enabledWindows) private var enabledWindowsRaw = Prefs.Defaults.enabledWindowsRaw
    @AppStorage(Prefs.Key.keepDetailOpen) private var keepDetailOpen = Prefs.Defaults.keepDetailOpen
    @State private var loginItemEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Launch at login", isOn: loginItemBinding)
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.red)
                }
            }
            Section("Default Time Window") {
                Picker("Default window", selection: $model.minutes) {
                    ForEach(Prefs.parseEnabledWindows(enabledWindowsRaw)) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                }
            }
            Section("Windows Shown in Panel Header") {
                ForEach(Prefs.WindowOption.allCases) { option in
                    Toggle(option.label, isOn: windowBinding(option))
                }
            }
            Section("Detail Card") {
                Toggle("Keep detail card open when panel closes", isOn: $keepDetailOpen)
            }
        }
        .formStyle(.grouped)
    }

    private var loginItemBinding: Binding<Bool> {
        Binding(
            get: { loginItemEnabled },
            set: { wantsEnabled in
                do {
                    if wantsEnabled {
                        try SMAppService.mainApp.register()
                    } else {
                        try SMAppService.mainApp.unregister()
                    }
                    loginItemError = nil
                } catch {
                    loginItemError = error.localizedDescription
                }
                loginItemEnabled = SMAppService.mainApp.status == .enabled
            }
        )
    }

    private func windowBinding(_ option: Prefs.WindowOption) -> Binding<Bool> {
        Binding(
            get: { Prefs.parseEnabledWindows(enabledWindowsRaw).contains(option) },
            set: { isOn in
                var enabled = Set(Prefs.parseEnabledWindows(enabledWindowsRaw))
                if isOn {
                    enabled.insert(option)
                } else {
                    // At least one window must stay enabled, so the header picker is never empty.
                    guard enabled.count > 1 else { return }
                    enabled.remove(option)
                }
                let sorted = enabled.sorted { $0.rawValue < $1.rawValue }
                enabledWindowsRaw = sorted.map { String($0.rawValue) }.joined(separator: ",")
                if !sorted.contains(where: { $0.rawValue == model.minutes }) {
                    model.minutes = sorted.first?.rawValue ?? Prefs.WindowOption.h1.rawValue
                }
            }
        )
    }
}

struct ConnectionSettingsTab: View {
    @Bindable var model: Telemetry
    @State private var urlDraft = ""
    @State private var urlError: String?
    @State private var testResult: TestResult?
    @State private var isTesting = false

    private enum TestResult {
        case ok
        case failure(String)
    }

    var body: some View {
        Form {
            Section("Collector") {
                TextField("Collector URL", text: $urlDraft)
                    .onSubmit(applyURL)
                if let urlError {
                    Text(urlError).font(.caption).foregroundStyle(.red)
                }
                HStack(spacing: 8) {
                    Button("Test Connection") { Task { await testConnection() } }
                        .disabled(isTesting)
                    if isTesting {
                        ProgressView().controlSize(.small)
                    } else if let testResult {
                        switch testResult {
                        case .ok:
                            Label("Reachable", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        case .failure(let message):
                            Label(message, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                        }
                    }
                }
            }
            Section("Polling") {
                Stepper(value: $model.statusPollIntervalSec, in: 1...60) {
                    Text("Status poll interval: \(Int(model.statusPollIntervalSec))s")
                }
                Stepper(value: $model.panelPollIntervalSec, in: 1...60) {
                    Text("Panel poll interval: \(Int(model.panelPollIntervalSec))s")
                }
                Stepper(value: $model.requestTimeoutSec, in: 1...30) {
                    Text("Request timeout: \(Int(model.requestTimeoutSec))s")
                }
                Stepper(value: $model.retryDelaySec, in: 1...60) {
                    Text("Retry delay after failure: \(Int(model.retryDelaySec))s")
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { urlDraft = model.collectorURL.absoluteString }
    }

    private func applyURL() {
        guard let url = Prefs.validCollectorURL(urlDraft) else {
            urlError = "Enter a valid http or https URL with a host."
            return
        }
        urlError = nil
        model.collectorURL = url
    }

    private func testConnection() async {
        guard let url = Prefs.validCollectorURL(urlDraft) else {
            urlError = "Enter a valid http or https URL with a host."
            return
        }
        urlError = nil
        isTesting = true
        defer { isTesting = false }
        switch await model.testConnection(url: url) {
        case .success: testResult = .ok
        case .failure(let error): testResult = .failure(error.localizedDescription)
        }
    }
}

struct MenuBarSettingsTab: View {
    @AppStorage(Prefs.Key.labelStyle) private var labelStyleRaw = Prefs.LabelStyle.iconAndValue.rawValue
    @AppStorage(Prefs.Key.offlineText) private var offlineTextRaw = Prefs.OfflineText.off.rawValue
    @AppStorage(Prefs.Key.bounceIconOnSlow) private var bounceOnSlow = Prefs.Defaults.bounceIconOnSlow

    var body: some View {
        Form {
            Picker("Label style", selection: $labelStyleRaw) {
                ForEach(Prefs.LabelStyle.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            Picker("Offline text", selection: $offlineTextRaw) {
                ForEach(Prefs.OfflineText.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            Toggle("Bounce icon on slow state", isOn: $bounceOnSlow)
        }
        .formStyle(.grouped)
    }
}

struct PanelSettingsTab: View {
    @AppStorage(Prefs.Key.panelWidth) private var panelWidth = Prefs.Defaults.panelWidth
    @AppStorage(Prefs.Key.showKpis) private var showKpis = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLatencyChart) private var showLatencyChart = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showBreakdown) private var showBreakdown = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showSlowest) private var showSlowest = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showTotalTime) private var showTotalTime = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.showLiveFeed) private var showLiveFeed = Prefs.Defaults.showSection
    @AppStorage(Prefs.Key.rowsPerList) private var rowsPerList = Prefs.Defaults.rowsPerList
    @AppStorage(Prefs.Key.liveFeedLength) private var liveFeedLength = Prefs.Defaults.liveFeedLength
    @AppStorage(Prefs.Key.hideHookStartEvents) private var hideHookStartEvents = Prefs.Defaults.hideHookStartEvents
    @AppStorage(Prefs.Key.hookWarnThresholdMs) private var hookWarnThresholdMs = Prefs.Defaults.hookWarnThresholdMs
    @AppStorage(Prefs.Key.animationsMode) private var animationsModeRaw = Prefs.AnimationsMode.followSystem.rawValue

    var body: some View {
        Form {
            Section("Layout") {
                Picker("Panel width", selection: $panelWidth) {
                    Text("360").tag(360)
                    Text("420").tag(420)
                    Text("480").tag(480)
                }
            }
            Section("Sections") {
                Toggle("KPIs", isOn: $showKpis)
                Toggle("Latency chart", isOn: $showLatencyChart)
                Toggle("Breakdown", isOn: $showBreakdown)
                Toggle("Slowest", isOn: $showSlowest)
                Toggle("By total time", isOn: $showTotalTime)
                Toggle("Live feed", isOn: $showLiveFeed)
            }
            Section("Lists") {
                Stepper(value: $rowsPerList, in: 3...15) {
                    Text("Rows per list: \(rowsPerList)")
                }
                Stepper(value: $liveFeedLength, in: 5...50) {
                    Text("Live feed length: \(liveFeedLength)")
                }
                Toggle("Hide hook-start events", isOn: $hideHookStartEvents)
            }
            Section("Highlighting") {
                Stepper(value: $hookWarnThresholdMs, in: 500...10000, step: 100) {
                    Text("Hook warn threshold: \(Int(hookWarnThresholdMs))ms")
                }
                Text("Only affects this panel's Slowest highlight. The collector's own slow state always uses a fixed rule.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Animations") {
                Picker("Animations", selection: $animationsModeRaw) {
                    ForEach(Prefs.AnimationsMode.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct AdvancedSettingsTab: View {
    @Bindable var model: Telemetry
    @State private var showResetConfirm = false

    var body: some View {
        Form {
            Section("Reset") {
                Button("Reset All Settings…", role: .destructive) { showResetConfirm = true }
            }
            Section("Files") {
                Button("Reveal Preferences File") { revealPreferencesFile() }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Reset all settings to their defaults?", isPresented: $showResetConfirm, titleVisibility: .visible) {
            Button("Reset", role: .destructive) { model.resetAllSettings() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func revealPreferencesFile() {
        guard let bundleId = Bundle.main.bundleIdentifier else { return }
        let path = NSHomeDirectory() + "/Library/Preferences/\(bundleId).plist"
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
