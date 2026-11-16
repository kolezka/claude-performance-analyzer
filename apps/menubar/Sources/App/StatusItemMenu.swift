import AppKit
import SwiftUI

// Short app name for menu items and the About window. The bundle name has no space, and the HIG
// asks for the same short name (16 characters or fewer) in About, Hide and Quit.
let appDisplayName = "Claude Telemetry"

// MenuBarExtra has no right-click hook, so catch right clicks aimed at our status bar window
// and pop a small menu under the icon instead of opening the panel.
@MainActor
final class StatusItemMenu: NSObject {
    static let shared = StatusItemMenu()

    private var monitor: Any?
    private var openSettings: OpenSettingsAction?
    // Follows the host the panel shows, so the menu opens the same dashboard as the panel button.
    var dashboardURL: URL?

    func install(openSettings: OpenSettingsAction) {
        self.openSettings = openSettings
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
            guard let self, let window = event.window, window.className == "NSStatusBarWindow" else { return event }
            self.show(below: window)
            return nil
        }
    }

    // Same items and order as a standard App menu: About alone in the first group, then app actions,
    // then Quit with the app name.
    func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(item("About \(appDisplayName)", #selector(showAbout)))
        menu.addItem(.separator())
        let dashboard = item("Open Dashboard", #selector(openDashboard), key: "d")
        // Kept in place but dimmed until the URL is known, so the menu never changes shape.
        dashboard.isEnabled = dashboardURL != nil
        menu.addItem(dashboard)
        menu.addItem(item("Settings…", #selector(openSettingsItem), key: ","))
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit \(appDisplayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        // Items with a target are validated against isEnabled instead of the responder chain.
        menu.autoenablesItems = false
        return menu
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func show(below window: NSWindow) {
        // Screen coordinates: the menu's top-left corner goes at the bottom-left of the icon.
        makeMenu().popUp(positioning: nil, at: NSPoint(x: window.frame.minX, y: window.frame.minY), in: nil)
    }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: appDisplayName])
    }

    @objc private func openDashboard() {
        guard let dashboardURL else { return }
        NSWorkspace.shared.open(dashboardURL)
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
