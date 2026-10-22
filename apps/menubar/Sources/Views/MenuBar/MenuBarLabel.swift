import AppKit
import SwiftUI

// The app icon's three-span trace waterfall, redrawn on a point grid so it stays crisp at menu bar size.
// Template, so the menu bar tints it for light, dark and highlighted states.
let waterfallIcon: NSImage = {
    let spans: [NSRect] = [
        NSRect(x: 0, y: 0, width: 9.5, height: 3),
        NSRect(x: 4.5, y: 5, width: 7.5, height: 3),
        NSRect(x: 7.5, y: 10, width: 8.5, height: 3),
    ]
    let image = NSImage(size: NSSize(width: 16, height: 13), flipped: true) { _ in
        NSColor.black.setFill()
        for span in spans {
            NSBezierPath(roundedRect: span, xRadius: 0.8, yRadius: 0.8).fill()
        }
        return true
    }
    image.isTemplate = true
    return image
}()

// What the label shows, worked out apart from the view so the rules can be tested.
// hostName is nil for This Mac, which keeps the label exactly as it was before hosts existed.
struct MenuBarLabelContent {
    let showIcon: Bool
    let text: String?
    let accessibility: String

    init(status: Status?, style: Prefs.LabelStyle, labelValue: String, offline: Prefs.OfflineText, hostName: String?) {
        let valueText = status.map { Self.labelText($0, labelValue: labelValue) } ?? offline.display
        // Value-only would otherwise draw nothing while offline with text hidden; keep the icon
        // so the label is never empty.
        showIcon = style != .valueOnly || valueText == nil
        if style != .iconOnly, let valueText {
            text = hostName.map { "\(valueText) · \($0)" } ?? valueText
        } else {
            text = nil
        }
        accessibility = hostName.map { "Claude Code telemetry, \($0)" } ?? "Claude Code telemetry"
    }

    // Idle and older collectors only have the server label. A value with no data yet (TTFT before
    // any trace spans) shows a dash, not some other metric under the chosen name.
    private static func labelText(_ status: Status, labelValue: String) -> String {
        guard status.state != "idle", let values = status.values else { return status.label }
        return values[labelValue] ?? "–"
    }
}

struct MenuBarLabel: View {
    let status: Status?
    // nil for This Mac.
    var hostName: String?
    @AppStorage(Prefs.Key.labelStyle) private var labelStyleRaw = Prefs.LabelStyle.iconAndValue.rawValue
    @AppStorage(Prefs.Key.labelValue) private var labelValueRaw = Prefs.LabelValue.apiP50.rawValue
    @AppStorage(Prefs.Key.offlineText) private var offlineTextRaw = Prefs.OfflineText.off.rawValue
    @AppStorage(Prefs.Key.bounceIconOnSlow) private var bounceOnSlow = Prefs.Defaults.bounceIconOnSlow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        // MenuBarExtra draws the label as a template, so "slow" swaps the symbol instead of tinting.
        let slow = status?.state == "slow"
        let content = MenuBarLabelContent(
            status: status,
            style: Prefs.LabelStyle(rawValue: labelStyleRaw) ?? .iconAndValue,
            labelValue: labelValueRaw,
            offline: Prefs.OfflineText(rawValue: offlineTextRaw) ?? .off,
            hostName: hostName
        )
        HStack(spacing: 3) {
            if content.showIcon {
                (slow ? Image(systemName: "exclamationmark.triangle.fill") : Image(nsImage: waterfallIcon))
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: bounceOnSlow ? slow : false)
            }
            if let text = content.text {
                Text(text).monospacedDigit()
            }
        }
        .accessibilityLabel(content.accessibility)
        // The label exists from launch, unlike the panel, so it hands the menu its settings opener.
        .onAppear { StatusItemMenu.shared.install(openSettings: openSettings) }
    }
}
