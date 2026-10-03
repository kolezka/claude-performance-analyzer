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

struct MenuBarLabel: View {
    let status: Status?
    @AppStorage(Prefs.Key.labelStyle) private var labelStyleRaw = Prefs.LabelStyle.iconAndValue.rawValue
    @AppStorage(Prefs.Key.labelValue) private var labelValueRaw = Prefs.LabelValue.apiP50.rawValue
    @AppStorage(Prefs.Key.offlineText) private var offlineTextRaw = Prefs.OfflineText.off.rawValue
    @AppStorage(Prefs.Key.bounceIconOnSlow) private var bounceOnSlow = Prefs.Defaults.bounceIconOnSlow

    var body: some View {
        // MenuBarExtra draws the label as a template, so "slow" swaps the symbol instead of tinting.
        let slow = status?.state == "slow"
        let style = Prefs.LabelStyle(rawValue: labelStyleRaw) ?? .iconAndValue
        let offlineText = Prefs.OfflineText(rawValue: offlineTextRaw) ?? .off
        let valueText = status.map { labelText($0) } ?? offlineText.display
        // Value-only would otherwise draw nothing while offline with text hidden; keep the icon
        // so the label is never empty.
        let showIcon = style != .valueOnly || valueText == nil
        let showValue = style != .iconOnly && valueText != nil
        HStack(spacing: 3) {
            if showIcon {
                (slow ? Image(systemName: "exclamationmark.triangle.fill") : Image(nsImage: waterfallIcon))
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: bounceOnSlow ? slow : false)
            }
            if showValue, let valueText {
                Text(valueText).monospacedDigit()
            }
        }
        .accessibilityLabel("Claude Code telemetry")
    }

    // Idle and older collectors only have the server label. A value with no data yet (TTFT before
    // any trace spans) shows a dash, not some other metric under the chosen name.
    private func labelText(_ status: Status) -> String {
        guard status.state != "idle", let values = status.values else { return status.label }
        return values[labelValueRaw] ?? "–"
    }
}
