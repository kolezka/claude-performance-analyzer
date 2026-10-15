import Foundation
import ServiceManagement

// The collector binary bundled in the app, run by launchd as a LaunchAgent. It keeps recording
// while the app is closed, and the user needs neither Bun nor the repository.
@MainActor
enum CollectorAgent {
    static let service = SMAppService.agent(plistName: "pl.raqz.claude-telemetry.collector.plist")

    // Builds run straight from the repo have no collector. Checked on disk, since status
    // reports .notFound both for that and for an agent that was never registered.
    static var isBundled: Bool {
        FileManager.default.isExecutableFile(atPath: Bundle.main.bundlePath + "/Contents/MacOS/claude-telemetry-collector")
    }

    // Why the last register or unregister failed, for the panel's offline hint.
    static var lastError: String?

    static var isWanted: Bool {
        UserDefaults.standard.object(forKey: Prefs.Key.runCollector) as? Bool ?? Prefs.Defaults.runCollector
    }

    // launchd keeps running the binary it started, so a new build or a moved app must register
    // again. Otherwise an update would keep talking to the old collector until the next login.
    private static var registration: String {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return "\(build) \(Bundle.main.bundlePath)"
    }

    // Launch and the Settings toggle can overlap across an await, so changes run one at a time.
    private static var queue: Task<Void, Never>?

    private static func serialized(_ body: @escaping @MainActor () async throws -> Void) async throws {
        let previous = queue
        let current = Task { @MainActor in
            await previous?.value
            return try await body()
        }
        queue = Task { _ = await current.result }
        try await current.value
    }

    // Called at launch. Leaves the agent alone when the user turned it off, here or in System Settings.
    static func start() async throws {
        try await serialized(startNow)
    }

    private static func startNow() async throws {
        guard isWanted, isBundled else { return }
        do {
            let stored = UserDefaults.standard.string(forKey: Prefs.Key.collectorRegistration)
            if service.status == .enabled, stored != registration {
                try await service.unregister()
            }
            // A user who turned it off in System Settings gets .requiresApproval and stays off.
            if service.status == .notRegistered || service.status == .notFound {
                try service.register()
            }
            UserDefaults.standard.set(registration, forKey: Prefs.Key.collectorRegistration)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            throw error
        }
    }

    // launchd can keep a job that points at a background item macOS has since replaced (seen
    // after rebuilding the app in place). It then never spawns, so register it again once.
    static func repairIfSilent() async throws {
        guard isWanted, isBundled, service.status == .enabled else { return }
        let probe = URL(string: "api/live", relativeTo: Prefs.defaultCollectorURL)!
        // A short timeout keeps a port owner that never answers from stretching the 15 tries.
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1
        config.timeoutIntervalForResource = 1
        let session = URLSession(configuration: config)
        for _ in 0..<15 {
            if let (_, response) = try? await session.data(from: probe),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                return
            }
            try await Task.sleep(for: .seconds(1))
        }
        try await serialized {
            guard isWanted, service.status == .enabled else { return }
            do {
                try await service.unregister()
                try service.register()
            } catch {
                lastError = error.localizedDescription
                throw error
            }
        }
    }

    // The preference changes only once launchd did, so a failed switch never shows the wrong state.
    static func setWanted(_ wanted: Bool) async throws {
        try await serialized { try await setWantedNow(wanted) }
    }

    private static func setWantedNow(_ wanted: Bool) async throws {
        if wanted {
            UserDefaults.standard.set(true, forKey: Prefs.Key.runCollector)
            do {
                try await startNow()
            } catch {
                UserDefaults.standard.set(false, forKey: Prefs.Key.runCollector)
                throw error
            }
        } else {
            if service.status == .enabled || service.status == .requiresApproval {
                do {
                    try await service.unregister()
                } catch {
                    lastError = error.localizedDescription
                    throw error
                }
            }
            UserDefaults.standard.set(false, forKey: Prefs.Key.runCollector)
        }
    }

    // Shown in the panel when nothing answers at the collector URL.
    static var offlineHint: String {
        if !isBundled {
            return "Start it with `bun run start`."
        }
        if !isWanted {
            return "The bundled collector is off. Turn it on in Settings, or start your own."
        }
        if let lastError {
            return "The bundled collector did not start: \(lastError)"
        }
        switch service.status {
        case .requiresApproval:
            return "Allow ClaudeTelemetry in System Settings > General > Login Items."
        default:
            return "The bundled collector is starting. If this stays, check the URL in Settings."
        }
    }
}
