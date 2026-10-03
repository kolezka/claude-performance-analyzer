import SwiftUI

@main
struct ClaudeTelemetryApp: App {
    @State private var model = Telemetry()

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
        } label: {
            MenuBarLabel(status: model.status)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}
