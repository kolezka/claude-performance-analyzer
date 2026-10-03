import SwiftUI

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
