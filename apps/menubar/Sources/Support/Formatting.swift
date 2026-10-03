import Foundation

func fmtMs(_ ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    if ms < 60_000 { return String(format: "%.1fs", ms / 1000) }
    return String(format: "%.1fm", ms / 60_000)
}

func date(_ ms: Double) -> Date {
    Date(timeIntervalSince1970: ms / 1000)
}

// Shortens a home-rooted path for display, the way Terminal and Finder do.
func abbreviateHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path.hasPrefix(home) { return "~" + path.dropFirst(home.count) }
    return path
}
