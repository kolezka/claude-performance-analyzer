import AppKit
import SwiftUI

// MenuBarExtra has no right-click hook, so catch right clicks aimed at our status bar window
// and pop a small menu under the icon instead of opening the panel.
@MainActor
final class StatusItemMenu: NSObject {
    static let shared = StatusItemMenu()

    private var monitor: Any?
    private var openSettings: OpenSettingsAction?

    func install(openSettings: OpenSettingsAction) {
        self.openSettings = openSettings
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
            guard let self, let window = event.window, window.className == "NSStatusBarWindow" else { return event }
            self.show(below: window)
            return nil
        }
    }

    private func show(below window: NSWindow) {
        let menu = NSMenu()
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettingsItem), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        // Screen coordinates: the menu's top-left corner goes at the bottom-left of the icon.
        menu.popUp(positioning: nil, at: NSPoint(x: window.frame.minX, y: window.frame.minY), in: nil)
    }

    @objc private func openSettingsItem() {
        guard let openSettings else { return }
        showSettingsWindow(using: openSettings)
    }
}

// openSettings() creates its window asynchronously, and this LSUIElement app has no Dock icon
// to click for focus, so raise the window by hand a beat after asking for it.
@MainActor
func showSettingsWindow(using openSettings: OpenSettingsAction) {
    openSettings()
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        NSApp.activate(ignoringOtherApps: true)
        // Match by identifier: the title follows the selected tab, and a fallback could raise the panel.
        let settingsWindow = NSApp.windows.first { $0.identifier?.rawValue.contains("Settings") == true }
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
}

// Same reasoning as showSettingsWindow: openWindow(id:) creates the window asynchronously,
// and this LSUIElement app has no Dock icon to click for focus.
@MainActor
func showDetailsWindow(using openWindow: OpenWindowAction) {
    openWindow(id: "details")
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        NSApp.activate(ignoringOtherApps: true)
        let detailsWindow = NSApp.windows.first { $0.identifier?.rawValue.contains("details") == true }
        detailsWindow?.makeKeyAndOrderFront(nil)
    }
}
