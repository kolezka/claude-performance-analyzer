import SwiftUI

struct MenuBarSettingsTab: View {
    @AppStorage(Prefs.Key.labelStyle) private var labelStyleRaw = Prefs.LabelStyle.iconAndValue.rawValue
    @AppStorage(Prefs.Key.labelValue) private var labelValueRaw = Prefs.LabelValue.apiP50.rawValue
    @AppStorage(Prefs.Key.offlineText) private var offlineTextRaw = Prefs.OfflineText.off.rawValue
    @AppStorage(Prefs.Key.bounceIconOnSlow) private var bounceOnSlow = Prefs.Defaults.bounceIconOnSlow

    var body: some View {
        Form {
            Picker("Label style", selection: $labelStyleRaw) {
                ForEach(Prefs.LabelStyle.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            Section {
                Picker("Value", selection: $labelValueRaw) {
                    ForEach(Prefs.LabelValue.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                }
            } footer: {
                Text("Measured over the last 15 minutes.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Picker("Offline text", selection: $offlineTextRaw) {
                ForEach(Prefs.OfflineText.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            Toggle("Bounce icon on slow state", isOn: $bounceOnSlow)
        }
        .formStyle(.grouped)
    }
}
