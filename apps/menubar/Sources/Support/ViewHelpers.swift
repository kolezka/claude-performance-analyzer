import AppKit
import SwiftUI

func copyToPasteboard(_ string: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
}

// One motion curve for the whole panel. Respects the Animations setting: on, off, or following
// Reduce Motion, which is the original behavior and stays the default.
@MainActor
func panelAnimation() -> Animation? {
    switch Prefs.animationsMode() {
    case .on: .smooth(duration: 0.35)
    case .off: nil
    case .followSystem: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? nil : .smooth(duration: 0.35)
    }
}

// A ForEach id for a key that may repeat. A struct, so no key can mimic another's suffix.
struct RowID: Hashable {
    let key: String
    let occurrence: Int
}

// Repeats are counted from the end (the oldest event in a newest-first list),
// so a new event at the top never shifts the ids of the rows below it.
func rowIds(_ keys: [String]) -> [RowID] {
    var seen: [String: Int] = [:]
    return keys.reversed().map { key in
        let n = seen[key, default: 0]
        seen[key] = n + 1
        return RowID(key: key, occurrence: n)
    }.reversed()
}

// Soft highlight under the hovered row, the same feedback native lists give.
struct HoverRow: ViewModifier {
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary.opacity(hovering ? 1 : 0), in: .rect(cornerRadius: 5))
            .padding(.horizontal, -6)
            .contentShape(.rect)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverRow() -> some View { modifier(HoverRow()) }
}
