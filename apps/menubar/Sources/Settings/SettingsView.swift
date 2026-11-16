import SwiftUI

struct SettingsView: View {
    @Bindable var model: Telemetry
    // HIG: reopen Settings on the pane people used last.
    @AppStorage(Prefs.Key.settingsPane) private var pane = "general"

    var body: some View {
        TabView(selection: $pane) {
            GeneralSettingsTab(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag("general")
            ConnectionSettingsTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
                .tag("connection")
            HostsSettingsTab(model: model)
                .tabItem { Label("Hosts", systemImage: "desktopcomputer") }
                .tag("hosts")
            MenuBarSettingsTab()
                .tabItem { Label("Menu Bar", systemImage: "menubar.rectangle") }
                .tag("menuBar")
            PanelSettingsTab()
                .tabItem { Label("Panel", systemImage: "rectangle.on.rectangle") }
                .tag("panel")
            AdvancedSettingsTab(model: model)
                .tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
                .tag("advanced")
        }
        .frame(width: 480)
        .scenePadding()
    }
}
