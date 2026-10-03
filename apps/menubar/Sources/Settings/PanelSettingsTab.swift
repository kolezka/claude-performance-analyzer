import SwiftUI

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
                Stepper(value: $rowsPerList, in: 3...8) {
                    Text("Rows per list: \(rowsPerList)")
                }
                Stepper(value: $liveFeedLength, in: 5...15) {
                    Text("Live feed length: \(liveFeedLength)")
                }
                Toggle("Hide hook-start events", isOn: $hideHookStartEvents)
            }
            Section("Highlighting") {
                Stepper(value: $hookWarnThresholdMs, in: 500...10000, step: 100) {
                    Text("Hook warn threshold: \(Int(Prefs.clamp(hookWarnThresholdMs, 500...10000)))ms")
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
