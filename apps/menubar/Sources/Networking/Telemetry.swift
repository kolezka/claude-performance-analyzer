import SwiftUI

// Polls the status label all the time, and the summary and live feed only while the panel is open.
@MainActor
@Observable
final class Telemetry {
    var status: Status?
    var summary: Summary?
    var summaryError: String?
    var live: [LiveEvent] = []
    var updatedAt: Date?
    var panelOpen = false {
        didSet { if panelOpen != oldValue { restartPanelPolling() } }
    }
    var minutes = UserDefaults.standard.object(forKey: Prefs.Key.window) as? Int ?? Prefs.Defaults.minutes {
        didSet {
            UserDefaults.standard.set(minutes, forKey: Prefs.Key.window)
            summary = nil
            summaryError = nil
            restartPanelPolling()
        }
    }

    // Connection settings. Each setter persists, then rebuilds whatever it affects, so a change
    // made in Settings takes effect immediately instead of waiting for the next poll.
    var collectorURL: URL = Prefs.loadCollectorURL() {
        didSet {
            guard collectorURL != oldValue else { return }
            UserDefaults.standard.set(collectorURL.absoluteString, forKey: Prefs.Key.collectorURL)
            // Drop the old collector's numbers so a slow new host cannot pass them off as its own.
            status = nil
            summary = nil
            summaryError = nil
            live = []
            updatedAt = nil
            restartStatusPolling()
            restartPanelPolling()
        }
    }
    var statusPollIntervalSec = Prefs.loadInterval(Prefs.Key.statusPollIntervalSec, default: Prefs.Defaults.statusPollIntervalSec) {
        didSet {
            guard statusPollIntervalSec != oldValue else { return }
            UserDefaults.standard.set(statusPollIntervalSec, forKey: Prefs.Key.statusPollIntervalSec)
            restartStatusPolling()
        }
    }
    var panelPollIntervalSec = Prefs.loadInterval(Prefs.Key.panelPollIntervalSec, default: Prefs.Defaults.panelPollIntervalSec) {
        didSet {
            guard panelPollIntervalSec != oldValue else { return }
            UserDefaults.standard.set(panelPollIntervalSec, forKey: Prefs.Key.panelPollIntervalSec)
            restartPanelPolling()
        }
    }
    var requestTimeoutSec = Prefs.loadRequestTimeout() {
        didSet {
            guard requestTimeoutSec != oldValue else { return }
            UserDefaults.standard.set(requestTimeoutSec, forKey: Prefs.Key.requestTimeoutSec)
            rebuildSession()
            restartStatusPolling()
            restartPanelPolling()
        }
    }
    var retryDelaySec = Prefs.loadInterval(Prefs.Key.retryDelaySec, default: Prefs.Defaults.retryDelaySec) {
        didSet {
            guard retryDelaySec != oldValue else { return }
            UserDefaults.standard.set(retryDelaySec, forKey: Prefs.Key.retryDelaySec)
        }
    }

    @ObservationIgnored private var session: URLSession = Telemetry.makeSession(requestTimeout: Prefs.loadRequestTimeout())
    @ObservationIgnored private var panelTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?

    init() {
        restartStatusPolling()
    }

    // Skips the retry-delay wait after a failure.
    func retry() {
        restartStatusPolling()
        restartPanelPolling()
    }

    func resetAllSettings() {
        for key in Prefs.Key.allManaged { UserDefaults.standard.removeObject(forKey: key) }
        collectorURL = Prefs.defaultCollectorURL
        statusPollIntervalSec = Prefs.Defaults.statusPollIntervalSec
        panelPollIntervalSec = Prefs.Defaults.panelPollIntervalSec
        requestTimeoutSec = Prefs.Defaults.requestTimeoutSec
        retryDelaySec = Prefs.Defaults.retryDelaySec
        minutes = Prefs.Defaults.minutes
    }

    private static func makeSession(requestTimeout: Double) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = Prefs.resourceTimeout(forRequestTimeout: requestTimeout)
        return URLSession(configuration: config)
    }

    private func rebuildSession() {
        session = Telemetry.makeSession(requestTimeout: requestTimeoutSec)
    }

    // Status runs on its own loop so slow summary requests never delay the label.
    // Restarting cancels the old loop, so its late response cannot undo a newer one.
    private func restartStatusPolling() {
        statusTask?.cancel()
        statusTask = Task {
            while !Task.isCancelled {
                let ok = await refreshStatus()
                try? await Task.sleep(for: .seconds(Prefs.clamp(ok ? statusPollIntervalSec : retryDelaySec, 1...60)))
            }
        }
    }

    private func refreshStatus() async -> Bool {
        do {
            let newStatus: Status = try await get("api/status")
            guard !Task.isCancelled else { return true }
            withAnimation(panelAnimation()) { status = newStatus }
            return true
        } catch {
            guard !Task.isCancelled else { return true }
            withAnimation(panelAnimation()) { status = nil }
            return false
        }
    }

    // One panel loop at a time: closing the panel or switching window cancels the old one,
    // so a late response can never overwrite newer data.
    private func restartPanelPolling() {
        panelTask?.cancel()
        panelTask = nil
        guard panelOpen else { return }
        panelTask = Task {
            while !Task.isCancelled {
                let ok = await refreshPanel()
                try? await Task.sleep(for: .seconds(Prefs.clamp(ok ? panelPollIntervalSec : retryDelaySec, 1...60)))
            }
        }
    }

    private func refreshPanel() async -> Bool {
        do {
            let newSummary: Summary = try await get("api/summary?minutes=\(minutes)")
            let newLive: [LiveEvent]? = try? await get("api/live")
            guard !Task.isCancelled else { return true }
            // Animating here lets numbers roll, rows slide and charts morph on every refresh.
            withAnimation(panelAnimation()) {
                summary = newSummary
                summaryError = nil
                live = newLive ?? live
            }
            updatedAt = .now
            return true
        } catch {
            guard !Task.isCancelled else { return true }
            withAnimation(panelAnimation()) { summaryError = error.localizedDescription }
            return false
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await session.data(from: URL(string: path, relativeTo: collectorURL)!)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func fetchEvent(id: Int) async throws -> EventDetail {
        try await get("api/event?id=\(id)")
    }

    func fetchItem(kind: StatsKind, name: String) async throws -> ItemDetail {
        var components = URLComponents()
        components.path = "api/item"
        components.queryItems = [
            URLQueryItem(name: "kind", value: kind.rawValue),
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "minutes", value: String(minutes)),
        ]
        return try await get(components.string!)
    }

    // Tests an arbitrary URL (the Settings draft), not necessarily the one currently applied.
    // Decodes Status like the real poll, so any other server answering 200 does not pass.
    func testConnection(url: URL) async -> Result<Void, Error> {
        do {
            let (data, response) = try await session.data(from: URL(string: "api/status", relativeTo: url)!)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw URLError(.badServerResponse)
            }
            _ = try JSONDecoder().decode(Status.self, from: data)
            return .success(())
        } catch {
            return .failure(error)
        }
    }
}
