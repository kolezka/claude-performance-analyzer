import AppKit
import ServiceManagement
import SwiftUI

struct AdvancedSettingsTab: View {
    @Bindable var model: Telemetry
    @State private var showResetConfirm = false
    @State private var resetError: String?

    var body: some View {
        Form {
            Section("Reset") {
                Button("Reset All Settings…", role: .destructive) { showResetConfirm = true }
                if let resetError {
                    Text(resetError).font(.caption).foregroundStyle(.red)
                }
            }
            Section("Files") {
                Button("Reveal Preferences File") { revealPreferencesFile() }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Reset all settings to their defaults?", isPresented: $showResetConfirm, titleVisibility: .visible) {
            Button("Reset", role: .destructive, action: resetAll)
            Button("Cancel", role: .cancel) {}
        }
    }

    // Launch at login is off by default, so a full reset also removes the login item.
    private func resetAll() {
        model.resetAllSettings()
        resetError = nil
        guard SMAppService.mainApp.status == .enabled else { return }
        do {
            try SMAppService.mainApp.unregister()
        } catch {
            resetError = "Settings reset, but launch at login is still on: \(error.localizedDescription)"
        }
    }

    private func revealPreferencesFile() {
        guard let bundleId = Bundle.main.bundleIdentifier else { return }
        let path = NSHomeDirectory() + "/Library/Preferences/\(bundleId).plist"
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
