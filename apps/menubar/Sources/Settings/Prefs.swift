import Foundation

// Key strings and defaults for every setting this app persists, in one place so the Settings UI,
// Telemetry and "Reset All Settings" never drift from each other.
enum Prefs {
    enum Key {
        static let window = "window" // pre-existing key, kept as is so there is no migration
        static let collectorURL = "collectorURL"
        static let statusPollIntervalSec = "statusPollIntervalSec"
        static let panelPollIntervalSec = "panelPollIntervalSec"
        static let requestTimeoutSec = "requestTimeoutSec"
        static let retryDelaySec = "retryDelaySec"
        static let enabledWindows = "enabledWindows"
        static let keepDetailOpen = "keepDetailOpen"
        static let labelStyle = "labelStyle"
        static let labelValue = "labelValue"
        static let offlineText = "offlineText"
        static let bounceIconOnSlow = "bounceIconOnSlow"
        static let panelWidth = "panelWidth"
        static let showKpis = "showKpis"
        static let showLatencyChart = "showLatencyChart"
        static let showBreakdown = "showBreakdown"
        static let showSlowest = "showSlowest"
        static let showTotalTime = "showTotalTime"
        static let showLiveFeed = "showLiveFeed"
        static let rowsPerList = "rowsPerList"
        static let liveFeedLength = "liveFeedLength"
        static let hideHookStartEvents = "hideHookStartEvents"
        static let hookWarnThresholdMs = "hookWarnThresholdMs"
        static let animationsMode = "animationsMode"

        // Everything "Reset All Settings" clears. "window" is included since it is the General
        // tab's default time window, just under its original pre-Settings name.
        static let allManaged = [
            window, collectorURL, statusPollIntervalSec, panelPollIntervalSec, requestTimeoutSec,
            retryDelaySec, enabledWindows, keepDetailOpen, labelStyle, labelValue, offlineText, bounceIconOnSlow,
            panelWidth, showKpis, showLatencyChart, showBreakdown, showSlowest, showTotalTime,
            showLiveFeed, rowsPerList, liveFeedLength, hideHookStartEvents, hookWarnThresholdMs,
            animationsMode,
            // Kind pickers inside the panel's two lists, persisted since before Settings existed.
            "slowestKind", "totalTimeKind",
        ]
    }

    enum Defaults {
        static let collectorURLString = "http://127.0.0.1:4318/"
        static let minutes = 60
        static let statusPollIntervalSec = 2.0
        static let panelPollIntervalSec = 2.0
        static let requestTimeoutSec = 2.0
        static let retryDelaySec = 2.0
        static let enabledWindowsRaw = "15,60,1440,10080"
        static let keepDetailOpen = false
        static let bounceIconOnSlow = true
        static let panelWidth = 360
        static let showSection = true
        static let rowsPerList = 3
        static let liveFeedLength = 6
        static let hideHookStartEvents = true
        static let hookWarnThresholdMs = 2000.0
    }

    static func clamp<T: Comparable>(_ value: T, _ range: ClosedRange<T>) -> T {
        min(max(value, range.lowerBound), range.upperBound)
    }

    // min/max pass NaN straight through, and a NaN interval or Int(NaN) would trap.
    static func clamp(_ value: Double, _ range: ClosedRange<Double>) -> Double {
        value.isNaN ? range.lowerBound : min(max(value, range.lowerBound), range.upperBound)
    }

    static var defaultCollectorURL: URL { URL(string: Defaults.collectorURLString)! }

    // A typed-in or stored collector URL is only ever applied once it is actually http(s) with a host.
    // The path gets a trailing slash, since "api/status" resolved against "/collector" would drop it.
    static func validCollectorURL(_ raw: String) -> URL? {
        guard var components = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.query == nil, components.fragment == nil
        else { return nil }
        if !components.path.hasSuffix("/") { components.path += "/" }
        return components.url
    }

    static func loadCollectorURL() -> URL {
        let raw = UserDefaults.standard.string(forKey: Key.collectorURL) ?? Defaults.collectorURLString
        return validCollectorURL(raw) ?? defaultCollectorURL
    }

    // Shared by the three 1...60s settings (status/panel poll interval, retry delay).
    static func loadInterval(_ key: String, default def: Double) -> Double {
        let stored = UserDefaults.standard.object(forKey: key) as? Double ?? def
        return clamp(stored, 1...60)
    }

    static func loadRequestTimeout() -> Double {
        let stored = UserDefaults.standard.object(forKey: Key.requestTimeoutSec) as? Double ?? Defaults.requestTimeoutSec
        return clamp(stored, 1...30)
    }

    static func resourceTimeout(forRequestTimeout request: Double) -> Double {
        max(request * 2.5, request + 1)
    }

    enum WindowOption: Int, CaseIterable, Identifiable {
        case m15 = 15, h1 = 60, h6 = 360, h24 = 1440, d3 = 4320, d7 = 10080
        var id: Int { rawValue }
        var label: String {
            switch self {
            case .m15: "15m"
            case .h1: "1h"
            case .h6: "6h"
            case .h24: "24h"
            case .d3: "3d"
            case .d7: "7d"
            }
        }
    }

    // Falls back to the shipped default set if storage is empty or unparseable, so the header
    // picker and the default-window picker can never end up with zero choices.
    static func parseEnabledWindows(_ raw: String) -> [WindowOption] {
        let options = raw.split(separator: ",").compactMap { Int($0) }.compactMap(WindowOption.init(rawValue:))
        if options.isEmpty {
            return Defaults.enabledWindowsRaw.split(separator: ",").compactMap { Int($0) }.compactMap(WindowOption.init(rawValue:))
        }
        return options.sorted { $0.rawValue < $1.rawValue }
    }

    enum LabelStyle: String, CaseIterable {
        case iconAndValue, iconOnly, valueOnly
        var title: String {
            switch self {
            case .iconAndValue: "Icon and Value"
            case .iconOnly: "Icon Only"
            case .valueOnly: "Value Only"
            }
        }
    }

    // Raw values match the keys of the collector's api/status "values" object.
    enum LabelValue: String, CaseIterable {
        case apiP50, apiP95, ttftP50, turnP50, cost, cacheHit, requests
        var title: String {
            switch self {
            case .apiP50: "API latency p50"
            case .apiP95: "API latency p95"
            case .ttftP50: "Time to first token p50"
            case .turnP50: "Turn time p50"
            case .cost: "Cost"
            case .cacheHit: "Cache hit ratio"
            case .requests: "API requests"
            }
        }
    }

    enum OfflineText: String, CaseIterable {
        case off, dash, hidden
        var title: String {
            switch self {
            case .off: "\"off\""
            case .dash: "Dash (–)"
            case .hidden: "Hidden"
            }
        }
        // The text shown in place of the server's label while the collector is offline.
        var display: String? {
            switch self {
            case .off: "off"
            case .dash: "–"
            case .hidden: nil
            }
        }
    }

    enum AnimationsMode: String, CaseIterable {
        case on, off, followSystem
        var title: String {
            switch self {
            case .on: "On"
            case .off: "Off"
            case .followSystem: "Follow System"
            }
        }
    }

    static func animationsMode() -> AnimationsMode {
        let raw = UserDefaults.standard.string(forKey: Key.animationsMode) ?? AnimationsMode.followSystem.rawValue
        return AnimationsMode(rawValue: raw) ?? .followSystem
    }
}
