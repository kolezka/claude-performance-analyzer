import Foundation

func fmtMs(_ ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    if ms < 60_000 { return String(format: "%.1fs", ms / 1000) }
    if ms < 3_600_000 { return String(format: "%.1fm", ms / 60_000) }
    return String(format: "%.1fh", ms / 3_600_000)
}

func date(_ ms: Double) -> Date {
    Date(timeIntervalSince1970: ms / 1000)
}

// A turn's duration for display: active time if the collector reports it, idle time called
// out separately so a long wait doesn't read as part of the turn's own work.
func fmtTurnDuration(activeMs: Double?, idleMs: Double?, wallMs: Double) -> String {
    var text = fmtMs(activeMs ?? wallMs)
    if let idleMs, idleMs > 0 {
        text += " +\(fmtMs(idleMs)) idle"
    }
    return text
}

// Shortens a home-rooted path for display, the way Terminal and Finder do.
func abbreviateHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path.hasPrefix(home) { return "~" + path.dropFirst(home.count) }
    return path
}
