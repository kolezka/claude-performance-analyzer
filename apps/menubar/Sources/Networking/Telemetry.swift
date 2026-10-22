import SwiftUI

// Polls the status label and the host list all the time, and the summary and live feed only
// while the panel is open. Every telemetry request is scoped to the selected host.
@MainActor
@Observable
final class Telemetry {
    enum TurnsSort: String { case recent, slowest }

    // Which collector, host and selection a request was made for. A result whose context is no
    // longer current is dropped, so a slow answer can never show under another host's name.
    struct RequestContext: Equatable {
        let collectorURL: URL
        let hostId: String
        let generation: Int
    }

    // Thrown in place of a result or error that belongs to a superseded context.
    struct StaleResult: Error {}

    static func isStale(_ error: Error) -> Bool {
        error is StaleResult || error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    static let hostsPollIntervalSec = 10.0

    var status: Status?
    var summary: Summary?
    var summaryError: String?
    var live: [LiveEvent] = []
    var updatedAt: Date?
    // Navigation for the Details window. Owned here, not the window, so a panel click can
    // set a route before the window even exists yet.
    var navigator = DetailNavigator()
    var panelOpen = false {
        didSet { if panelOpen != oldValue { restartPanelPolling() } }
    }

    // Panel "Turn" section state. selectedPromptId nil means "follow the newest turn";
    // once the user steps back it pins to that turn's id so a new arrival doesn't bump it.
    var turnsSort = TurnsSort.recent {
        didSet {
            guard turnsSort != oldValue else { return }
            selectedPromptId = nil
            refreshTurns()
        }
    }
    var turns: [TurnSummary] = []
    var turnsError: String?
    var selectedPromptId: String? {
        didSet {
            guard selectedPromptId != oldValue else { return }
            refreshSelectedTurn()
        }
    }
    var turnDetail: TurnDetail?
    var turnDetailError: String?
    var minutes: Int {
        didSet {
            defaults.set(minutes, forKey: Prefs.Key.window)
            summary = nil
            summaryError = nil
            restartPanelPolling()
        }
    }

    // Connection settings. Each setter persists, then rebuilds whatever it affects, so a change
    // made in Settings takes effect immediately instead of waiting for the next poll.
    var collectorURL: URL {
        didSet {
            guard collectorURL != oldValue else { return }
            defaults.set(collectorURL.absoluteString, forKey: Prefs.Key.collectorURL)
            // Host ids belong to a collector. Drop the old list and every in-flight answer, keep
            // the selected id, and let the new collector's list confirm it or fall back to local.
            hosts = []
            hostsError = nil
            invalidateTelemetry()
            restartHostsPolling()
        }
    }
    var statusPollIntervalSec: Double {
        didSet {
            guard statusPollIntervalSec != oldValue else { return }
            defaults.set(statusPollIntervalSec, forKey: Prefs.Key.statusPollIntervalSec)
            restartStatusPolling()
        }
    }
    var panelPollIntervalSec: Double {
        didSet {
            guard panelPollIntervalSec != oldValue else { return }
            defaults.set(panelPollIntervalSec, forKey: Prefs.Key.panelPollIntervalSec)
            restartPanelPolling()
        }
    }
    var requestTimeoutSec: Double {
        didSet {
            guard requestTimeoutSec != oldValue else { return }
            defaults.set(requestTimeoutSec, forKey: Prefs.Key.requestTimeoutSec)
            rebuildSession()
            restartStatusPolling()
            restartPanelPolling()
        }
    }
    var retryDelaySec: Double {
        didSet {
            guard retryDelaySec != oldValue else { return }
            defaults.set(retryDelaySec, forKey: Prefs.Key.retryDelaySec)
        }
    }

    // Hosts known to the current collector, local first. Empty until the first list arrives.
    var hosts: [TelemetryHost] = []
    var hostsError: String?
    // Persisted by id only. Changing it re-scopes every request and remounts the Details window.
    var selectedHostId: String {
        didSet {
            guard selectedHostId != oldValue else { return }
            defaults.set(selectedHostId, forKey: Prefs.Key.selectedHostId)
            invalidateTelemetry()
        }
    }
    // Bumped whenever answers already in flight stop being valid: a host switch or a new collector.
    private(set) var selectionGeneration = 0

    // A saved remote id the collector has not confirmed yet is not called "This Mac".
    var selectedHostName: String {
        if selectedHostId == TelemetryHost.localId { return TelemetryHost.localName }
        return hosts.first { $0.id == selectedHostId }?.name ?? "Remote host"
    }

    var isRemoteSelected: Bool { selectedHostId != TelemetryHost.localId }

    // Opens the dashboard on the same host the panel shows.
    var dashboardURL: URL {
        guard isRemoteSelected else { return collectorURL }
        return Self.url(base: collectorURL, path: "", query: [URLQueryItem(name: "host", value: selectedHostId)])
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeSession: (Double) -> URLSession
    @ObservationIgnored private var session: URLSession
    @ObservationIgnored private var pollingEnabled = false
    @ObservationIgnored private var panelTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var turnsTask: Task<Void, Never>?
    @ObservationIgnored private var turnTask: Task<Void, Never>?
    @ObservationIgnored private var hostsTask: Task<Void, Never>?
    // Only the newest host-list request may apply, so an add's refresh is not undone by an older poll.
    @ObservationIgnored private var hostsRequestSerial = 0

    // Tests inject an isolated defaults suite and a mock session, and may hold polling off.
    init(
        defaults: UserDefaults = .standard,
        makeSession: @escaping (Double) -> URLSession = Telemetry.makeSession(requestTimeout:),
        startPolling: Bool = true
    ) {
        self.defaults = defaults
        self.makeSession = makeSession
        minutes = defaults.object(forKey: Prefs.Key.window) as? Int ?? Prefs.Defaults.minutes
        collectorURL = Prefs.loadCollectorURL(defaults)
        statusPollIntervalSec = Prefs.loadInterval(Prefs.Key.statusPollIntervalSec, default: Prefs.Defaults.statusPollIntervalSec, defaults)
        panelPollIntervalSec = Prefs.loadInterval(Prefs.Key.panelPollIntervalSec, default: Prefs.Defaults.panelPollIntervalSec, defaults)
        let timeout = Prefs.loadRequestTimeout(defaults)
        requestTimeoutSec = timeout
        retryDelaySec = Prefs.loadInterval(Prefs.Key.retryDelaySec, default: Prefs.Defaults.retryDelaySec, defaults)
        selectedHostId = Prefs.loadSelectedHostId(defaults)
        session = makeSession(timeout)
        if startPolling { self.startPolling() }
    }

    func startPolling() {
        pollingEnabled = true
        restartStatusPolling()
        restartHostsPolling()
        restartPanelPolling()
    }

    func stopPolling() {
        pollingEnabled = false
        for task in [statusTask, hostsTask, panelTask, turnsTask, turnTask] { task?.cancel() }
        statusTask = nil
        hostsTask = nil
        panelTask = nil
        turnsTask = nil
        turnTask = nil
    }

    // Skips the retry-delay wait after a failure.
    func retry() {
        restartStatusPolling()
        restartPanelPolling()
    }

    func resetAllSettings() {
        for key in Prefs.Key.allManaged { defaults.removeObject(forKey: key) }
        collectorURL = Prefs.defaultCollectorURL
        statusPollIntervalSec = Prefs.Defaults.statusPollIntervalSec
        panelPollIntervalSec = Prefs.Defaults.panelPollIntervalSec
        requestTimeoutSec = Prefs.Defaults.requestTimeoutSec
        retryDelaySec = Prefs.Defaults.retryDelaySec
        minutes = Prefs.Defaults.minutes
        selectedHostId = TelemetryHost.localId
    }

    nonisolated static func makeSession(requestTimeout: Double) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = Prefs.resourceTimeout(forRequestTimeout: requestTimeout)
        return URLSession(configuration: config)
    }

    private func rebuildSession() {
        session = makeSession(requestTimeoutSec)
    }

    private var currentContext: RequestContext {
        RequestContext(collectorURL: collectorURL, hostId: selectedHostId, generation: selectionGeneration)
    }

    // Everything shown belongs to the old host or collector: cancel the four telemetry tasks,
    // clear their state and the Details stack, then start over for the new context.
    private func invalidateTelemetry() {
        selectionGeneration += 1
        for task in [statusTask, panelTask, turnsTask, turnTask] { task?.cancel() }
        statusTask = nil
        panelTask = nil
        turnsTask = nil
        turnTask = nil
        status = nil
        summary = nil
        summaryError = nil
        live = []
        updatedAt = nil
        turns = []
        turnsError = nil
        selectedPromptId = nil
        turnDetail = nil
        turnDetailError = nil
        navigator.stack = []
        restartStatusPolling()
        restartPanelPolling()
    }

    // Runs even while the panel is closed, so a host removed elsewhere is noticed and the
    // label falls back to This Mac instead of polling a host that no longer exists.
    private func restartHostsPolling() {
        hostsTask?.cancel()
        hostsTask = nil
        guard pollingEnabled else { return }
        hostsTask = Task {
            while !Task.isCancelled {
                let ok = await refreshHosts()
                try? await Task.sleep(for: .seconds(ok ? Self.hostsPollIntervalSec : Prefs.clamp(retryDelaySec, 1...60)))
            }
        }
    }

    // Falls back to local only on a list the collector actually returned. A failed request
    // keeps the selection, since the host may well still exist.
    @discardableResult
    func refreshHosts() async -> Bool {
        hostsRequestSerial += 1
        let serial = hostsRequestSerial
        let base = collectorURL
        do {
            let (data, response) = try await session.data(from: Self.url(base: base, path: "api/hosts", query: []))
            guard serial == hostsRequestSerial, base == collectorURL else { return true }
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw URLError(.badServerResponse)
            }
            let list = try JSONDecoder().decode([TelemetryHost].self, from: data)
            hosts = list
            hostsError = nil
            if !list.contains(where: { $0.id == selectedHostId }) {
                selectedHostId = TelemetryHost.localId
            }
            return true
        } catch {
            guard serial == hostsRequestSerial, base == collectorURL else { return true }
            hostsError = error.localizedDescription
            return false
        }
    }

    func addHost(name: String) async throws -> HostCredentials {
        let data = try await manage("POST", path: "api/hosts", body: ["name": name], expect: 201)
        let credentials = try JSONDecoder().decode(HostCredentials.self, from: data)
        await refreshHosts()
        return credentials
    }

    func regenerateHostToken(id: String) async throws -> HostCredentials {
        let data = try await manage("POST", path: "api/hosts/\(Self.pathSegment(id))/token", body: [:], expect: 200)
        let credentials = try JSONDecoder().decode(HostCredentials.self, from: data)
        await refreshHosts()
        return credentials
    }

    func removeHost(id: String) async throws {
        let base = collectorURL
        _ = try await manage("DELETE", path: "api/hosts/\(Self.pathSegment(id))", body: [:], expect: 204)
        // The same id on a collector chosen meanwhile is a different host, so leave it selected.
        guard base == collectorURL else { return }
        if selectedHostId == id { selectedHostId = TelemetryHost.localId }
        await refreshHosts()
    }

    // Host-management writes need a JSON body and a same-origin Origin, which the collector checks
    // even for this native client. URLSession sets the Host header itself.
    private func manage(_ method: String, path: String, body: [String: String], expect: Int) async throws -> Data {
        var request = URLRequest(url: Self.url(base: collectorURL, path: path, query: []))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.origin(of: collectorURL), forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == expect else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw HostRequestError(status: status, message: message)
        }
        return data
    }

    // scheme://host[:port], the way a browser writes Origin: no path, no default port.
    static func origin(of url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? "http"
        var host = url.host(percentEncoded: false) ?? ""
        if host.contains(":"), !host.hasPrefix("[") { host = "[\(host)]" }
        let defaultPort = scheme == "https" ? 443 : 80
        guard let port = url.port, port != defaultPort else { return "\(scheme)://\(host)" }
        return "\(scheme)://\(host):\(port)"
    }

    // RFC 3986 unreserved characters only, so "+", "&" and "=" in a value can never be misread.
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func pathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    // The one place collector URLs are built. The path resolves against the collector URL,
    // which always ends in "/", so a collector served under a sub-path keeps it.
    static func url(base: URL, path: String, query: [URLQueryItem]) -> URL {
        let resolved = (path.isEmpty ? base : URL(string: path, relativeTo: base)!).absoluteURL
        var components = URLComponents(url: resolved, resolvingAgainstBaseURL: false)!
        components.percentEncodedQuery = query.isEmpty ? nil : query.map { item in
            let name = item.name.addingPercentEncoding(withAllowedCharacters: unreserved) ?? item.name
            let value = (item.value ?? "").addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
            return "\(name)=\(value)"
        }.joined(separator: "&")
        return components.url!
    }

    // Status runs on its own loop so slow summary requests never delay the label.
    // Restarting cancels the old loop, so its late response cannot undo a newer one.
    private func restartStatusPolling() {
        statusTask?.cancel()
        statusTask = nil
        guard pollingEnabled else { return }
        statusTask = Task {
            while !Task.isCancelled {
                let ok = await refreshStatus()
                try? await Task.sleep(for: .seconds(Prefs.clamp(ok ? statusPollIntervalSec : retryDelaySec, 1...60)))
            }
        }
    }

    private func refreshStatus() async -> Bool {
        let context = currentContext
        do {
            let newStatus: Status = try await get("api/status", context: context)
            guard !Task.isCancelled, context == currentContext else { return true }
            withAnimation(panelAnimation()) { status = newStatus }
            return true
        } catch {
            guard !Task.isCancelled, !Self.isStale(error), context == currentContext else { return true }
            withAnimation(panelAnimation()) { status = nil }
            return false
        }
    }

    // One panel loop at a time: closing the panel or switching window cancels the old one,
    // so a late response can never overwrite newer data.
    private func restartPanelPolling() {
        panelTask?.cancel()
        panelTask = nil
        guard panelOpen, pollingEnabled else { return }
        panelTask = Task {
            while !Task.isCancelled {
                let ok = await refreshPanel()
                try? await Task.sleep(for: .seconds(Prefs.clamp(ok ? panelPollIntervalSec : retryDelaySec, 1...60)))
            }
        }
    }

    private func refreshPanel() async -> Bool {
        let context = currentContext
        do {
            let newSummary: Summary = try await get("api/summary", [URLQueryItem(name: "minutes", value: String(minutes))], context: context)
            let newLive: [LiveEvent]? = try? await get("api/live", context: context)
            guard !Task.isCancelled, context == currentContext else { return true }
            // Animating here lets numbers roll, rows slide and charts morph on every refresh.
            withAnimation(panelAnimation()) {
                summary = newSummary
                summaryError = nil
                live = newLive ?? live
            }
            updatedAt = .now
            // Rides the same poll tick as summary/live, so opening the panel's Turn section
            // never starts a second loop. Fire-and-forget: it manages its own task so a slow
            // response here can never block or be outraced by the next poll tick.
            refreshTurns()
            return true
        } catch {
            guard !Task.isCancelled, !Self.isStale(error), context == currentContext else { return true }
            withAnimation(panelAnimation()) { summaryError = error.localizedDescription }
            return false
        }
    }

    // One turns-list request in flight at a time: a sort switch or the next poll tick cancels
    // whatever was still running. The sort/minutes/context are captured at request time and
    // re-checked on completion, so even an uncancelled-but-superseded response (e.g. two ticks
    // landing out of order) can't overwrite newer state.
    private func refreshTurns() {
        turnsTask?.cancel()
        let sort = turnsSort
        let windowMinutes = minutes
        let context = currentContext
        turnsTask = Task {
            // Reads the same key the Item detail toggle writes, so both views agree on
            // whether headless SDK sessions are in the numbers.
            let excludeHeadless = defaults.bool(forKey: Prefs.Key.hideHeadlessSessions)
            do {
                let list = try await fetchTurns(sort: sort, limit: 20, excludeHeadless: excludeHeadless, context: context)
                guard !Task.isCancelled, sort == turnsSort, windowMinutes == minutes, context == currentContext else { return }
                withAnimation(panelAnimation()) { turns = list; turnsError = nil }
                refreshSelectedTurn()
            } catch {
                guard !Task.isCancelled, !Self.isStale(error), sort == turnsSort, windowMinutes == minutes,
                      context == currentContext else { return }
                turnsError = error.localizedDescription
            }
        }
    }

    // Same one-in-flight-at-a-time shape as refreshTurns. nil pins to "follow the newest in
    // the list"; a pinned id that is no longer in `turns` (aged out) still gets fetched by id,
    // so the panel keeps showing that turn instead of silently snapping to turns.first.
    private func refreshSelectedTurn() {
        turnTask?.cancel()
        guard let promptId = selectedPromptId ?? turns.first?.promptId else {
            turnTask = nil
            turnDetail = nil
            turnDetailError = nil
            return
        }
        let context = currentContext
        turnTask = Task {
            do {
                let detail = try await fetchTurn(promptId: promptId, context: context)
                guard !Task.isCancelled, context == currentContext, (selectedPromptId ?? turns.first?.promptId) == promptId else { return }
                withAnimation(panelAnimation()) { turnDetail = detail; turnDetailError = nil }
            } catch {
                guard !Task.isCancelled, !Self.isStale(error), context == currentContext,
                      (selectedPromptId ?? turns.first?.promptId) == promptId else { return }
                turnDetailError = error.localizedDescription
            }
        }
    }

    // Every telemetry read goes through here with the context it was started for. The host
    // query is always added, and the answer, or the error, is dropped if the context moved on.
    private func get<T: Decodable>(_ path: String, _ query: [URLQueryItem] = [], context: RequestContext) async throws -> T {
        let url = Self.url(base: context.collectorURL, path: path, query: query + [URLQueryItem(name: "host", value: context.hostId)])
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch {
            guard context == currentContext else { throw StaleResult() }
            throw error
        }
        guard context == currentContext else { throw StaleResult() }
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // The detail fetches are started by views, outside the polling tasks, so a host switch does
    // not cancel them. They capture the context when called and throw StaleResult if it moved on.
    func fetchEvent(id: Int) async throws -> EventDetail {
        try await get("api/event", [URLQueryItem(name: "id", value: String(id))], context: currentContext)
    }

    func fetchHookCall(id: Int) async throws -> HookCallDetail {
        try await get("api/hook-call", [URLQueryItem(name: "id", value: String(id))], context: currentContext)
    }

    func fetchItem(kind: StatsKind, name: String, excludeHeadless: Bool, pattern: String? = nil) async throws -> ItemDetail {
        var query = [
            URLQueryItem(name: "kind", value: kind.rawValue),
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "minutes", value: String(minutes)),
            URLQueryItem(name: "excludeHeadless", value: excludeHeadless ? "1" : "0"),
        ]
        if let pattern { query.append(URLQueryItem(name: "pattern", value: pattern)) }
        return try await get("api/item", query, context: currentContext)
    }

    func fetchTurns(sort: TurnsSort, limit: Int, excludeHeadless: Bool) async throws -> [TurnSummary] {
        try await fetchTurns(sort: sort, limit: limit, excludeHeadless: excludeHeadless, context: currentContext)
    }

    private func fetchTurns(sort: TurnsSort, limit: Int, excludeHeadless: Bool, context: RequestContext) async throws -> [TurnSummary] {
        try await get("api/turns", [
            URLQueryItem(name: "minutes", value: String(minutes)),
            URLQueryItem(name: "sort", value: sort.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "excludeHeadless", value: excludeHeadless ? "1" : "0"),
        ], context: context)
    }

    // May come back nil: the collector returns JSON null when the prompt has no events.
    func fetchTurn(promptId: String) async throws -> TurnDetail? {
        try await fetchTurn(promptId: promptId, context: currentContext)
    }

    private func fetchTurn(promptId: String, context: RequestContext) async throws -> TurnDetail? {
        try await get("api/turn", [URLQueryItem(name: "prompt", value: promptId)], context: context)
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
