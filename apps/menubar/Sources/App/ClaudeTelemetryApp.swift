import SwiftUI

@main
struct ClaudeTelemetryApp: App {
    @State private var model = Telemetry()

    init() {
        Task {
            do {
                try await CollectorAgent.start()
                try await CollectorAgent.repairIfSilent()
            } catch {
                NSLog("Could not start the bundled collector: %@", error.localizedDescription)
            }
        }
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
        } label: {
            MenuBarLabel(status: model.status, hostName: model.isRemoteSelected ? model.selectedHostName : nil)
        }
        .menuBarExtraStyle(.window)

        Window("Details", id: "details") {
            DetailWindowView(model: model)
        }
        .defaultSize(width: 620, height: 760)
        .windowResizability(.contentMinSize)

        Settings {
            SettingsView(model: model)
        }
    }
}
