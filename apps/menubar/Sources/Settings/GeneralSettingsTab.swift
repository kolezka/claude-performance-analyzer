import ServiceManagement
import SwiftUI

struct GeneralSettingsTab: View {
    @Bindable var model: Telemetry
    @AppStorage(Prefs.Key.enabledWindows) private var enabledWindowsRaw = Prefs.Defaults.enabledWindowsRaw
    @AppStorage(Prefs.Key.keepDetailOpen) private var keepDetailOpen = Prefs.Defaults.keepDetailOpen
    @State private var loginItemEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?
    @State private var runCollector = CollectorAgent.isWanted
    @State private var collectorStatus = CollectorAgent.service.status
    @State private var collectorError: String?

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Launch at login", isOn: loginItemBinding)
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.red)
                }
            }
            Section("Collector") {
                Toggle("Run bundled collector in the background", isOn: collectorBinding)
                if collectorStatus == .requiresApproval {
                    HStack {
                        Text("Turned off in System Settings.").font(.caption).foregroundStyle(.secondary)
                        Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
                            .controlSize(.small)
                    }
                }
                if let collectorError {
                    Text(collectorError).font(.caption).foregroundStyle(.red)
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
        // The login item can change outside this tab (Reset, System Settings), so re-read it.
        .onAppear {
            loginItemEnabled = SMAppService.mainApp.status == .enabled
            runCollector = CollectorAgent.isWanted
            collectorStatus = CollectorAgent.service.status
        }
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

    private var collectorBinding: Binding<Bool> {
        Binding(
            get: { runCollector },
            set: { wanted in
                runCollector = wanted
                Task {
                    do {
                        try await CollectorAgent.setWanted(wanted)
                        collectorError = nil
                    } catch {
                        collectorError = error.localizedDescription
                    }
                    runCollector = CollectorAgent.isWanted
                    collectorStatus = CollectorAgent.service.status
                }
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
