import SwiftUI

// Keeps one socket to the collector for pushed events, refreshes aggregates on a slow 30 s loop
// (and on demand), and polls the host list all the time. The summary and live feed are fetched
// only while the panel is open. Every telemetry request is scoped to the selected host.
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
    // Time-based values (idle status, the rolling window, in-progress turns) change without a push.
    static let refreshIntervalSec = 30.0
    static let socketBackoffMinSec = 1.0
    static let socketBackoffMaxSec = 15.0
    // A burst of pushes becomes one refetch: wait for a short quiet gap, but never longer than this.
    static let coalesceDelayMs = 300
    static let coalesceMaxWaitMs = 1000
    // What /api/live returns, so a pushed feed never outgrows a fetched one.
    static let liveFeedCapacity = 60

    var connectionState = LiveConnectionState.offline
    // Hooks in flight for the selected host, and a clock the panel reads for their elapsed time.
    // The clock only advances while the panel is open and something is running.
    var runningHooks = RunningHooks()
    var clock = Date.now
    var isTicking: Bool { tickerTask != nil }
    var status: Status?
    var summary: Summary?
    var summaryError: String?
    var live: [LiveEvent] = []
    var updatedAt: Date?
    // Navigation for the Details window. Owned here, not the window, so a panel click can
    // set a route before the window even exists yet.
    var navigator = DetailNavigator()
    var panelOpen = false {
        didSet {
            guard panelOpen != oldValue else { return }
            refreshNow()
            updateTicker()
        }
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
            refreshNow()
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
            restartSocket()
        }
    }
    var requestTimeoutSec: Double {
        didSet {
            guard requestTimeoutSec != oldValue else { return }
            defaults.set(requestTimeoutSec, forKey: Prefs.Key.requestTimeoutSec)
            rebuildSession()
            refreshNow()
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
    @ObservationIgnored private let makeSocket: LiveSocketFactory
    @ObservationIgnored private let refreshIntervalSec: Double
    @ObservationIgnored private var session: URLSession
    @ObservationIgnored private var pollingEnabled = false
    // One loop refreshes status and, with the panel open, the panel. refreshNow() restarts it; if
    // a refresh is in flight the loop runs one more right after instead of cancelling requests.
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private var refreshInFlight = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var socketTask: Task<Void, Never>?
    @ObservationIgnored private var socket: (any LiveSocketConnection)?
    @ObservationIgnored private var coalesceTask: Task<Void, Never>?
    @ObservationIgnored private var dirtySince: ContinuousClock.Instant?
    @ObservationIgnored private var tickerTask: Task<Void, Never>?
    @ObservationIgnored private var turnsTask: Task<Void, Never>?
    @ObservationIgnored private var turnTask: Task<Void, Never>?
    @ObservationIgnored private var hostsTask: Task<Void, Never>?
    // Only the newest host-list request may apply, so an add's refresh is not undone by an older poll.
    @ObservationIgnored private var hostsRequestSerial = 0

    // Tests inject an isolated defaults suite, a mock session and a scripted socket, and may hold
    // networking off. startPolling keeps its name; it now starts the socket and the refresh loop.
    init(
        defaults: UserDefaults = .standard,
        makeSession: @escaping (Double) -> URLSession = Telemetry.makeSession(requestTimeout:),
        makeSocket: @escaping LiveSocketFactory = Telemetry.makeSocket(url:),
        refreshIntervalSec: Double = Telemetry.refreshIntervalSec,
        startPolling: Bool = true
    ) {
        self.defaults = defaults
        self.makeSession = makeSession
        self.makeSocket = makeSocket
        self.refreshIntervalSec = refreshIntervalSec
        minutes = defaults.object(forKey: Prefs.Key.window) as? Int ?? Prefs.Defaults.minutes
        collectorURL = Prefs.loadCollectorURL(defaults)
        let timeout = Prefs.loadRequestTimeout(defaults)
        requestTimeoutSec = timeout
        retryDelaySec = Prefs.loadInterval(Prefs.Key.retryDelaySec, default: Prefs.Defaults.retryDelaySec, defaults)
        selectedHostId = Prefs.loadSelectedHostId(defaults)
        session = makeSession(timeout)
        if startPolling { self.startPolling() }
    }

    func startPolling() {
        pollingEnabled = true
        restartHostsPolling()
        refreshNow()
        restartSocket()
    }

    func stopPolling() {
        pollingEnabled = false
        for task in [refreshTask, hostsTask, socketTask, coalesceTask, tickerTask, turnsTask, turnTask] { task?.cancel() }
        refreshTask = nil
        refreshInFlight = false
        refreshAgain = false
        coalesceTask = nil
        dirtySince = nil
        tickerTask = nil
        runningHooks = RunningHooks()
        hostsTask = nil
        socketTask = nil
        socket?.cancel()
        socket = nil
        connectionState = .offline
        turnsTask = nil
        turnTask = nil
    }

    // Skips the retry-delay wait after a failure.
    func retry() {
        refreshNow()
    }

    func resetAllSettings() {
        for key in Prefs.Key.allManaged { defaults.removeObject(forKey: key) }
        collectorURL = Prefs.defaultCollectorURL
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

    // The socket has its own session: the request timeout setting is for one-shot requests.
    nonisolated static func makeSocket(url: URL) -> any LiveSocketConnection {
        URLSessionLiveSocket(url: url, session: makeSession(requestTimeout: Prefs.Defaults.requestTimeoutSec))
    }

    private func rebuildSession() {
        session = makeSession(requestTimeoutSec)
    }

    private var currentContext: RequestContext {
        RequestContext(collectorURL: collectorURL, hostId: selectedHostId, generation: selectionGeneration)
    }

    // Everything shown belongs to the old host or collector: cancel the telemetry tasks,
    // clear their state and the Details stack, then start over for the new context.
    private func invalidateTelemetry() {
        selectionGeneration += 1
        for task in [refreshTask, coalesceTask, tickerTask, turnsTask, turnTask] { task?.cancel() }
        refreshTask = nil
        refreshInFlight = false
        refreshAgain = false
        coalesceTask = nil
        dirtySince = nil
        tickerTask = nil
        runningHooks = RunningHooks()
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
        refreshNow()
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

    // Refreshes everything the current context shows right away and restarts the slow loop.
    // A refresh already in flight is left to finish; one more follows it.
    func refreshNow() {
        guard pollingEnabled else { return }
        if refreshInFlight {
            refreshAgain = true
        } else {
            restartRefreshLoop()
        }
    }

    private func restartRefreshLoop() {
        refreshTask?.cancel()
        refreshAgain = false
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshTask = Task {
            while !Task.isCancelled {
                refreshInFlight = true
                let ok = await refreshAll()
                // A loop replaced while it waited must not touch the flags the new loop relies on.
                guard generation == refreshGeneration, !Task.isCancelled else { return }
                refreshInFlight = false
                if refreshAgain {
                    refreshAgain = false
                    continue
                }
                try? await Task.sleep(for: .seconds(ok ? refreshIntervalSec : Prefs.clamp(retryDelaySec, 1...60)))
            }
        }
    }

    // Status and panel run side by side, so a slow summary never delays the label.
    private func refreshAll() async -> Bool {
        guard panelOpen else { return await refreshStatus() }
        async let statusOk = refreshStatus()
        async let panelOk = refreshPanel()
        let (s, p) = await (statusOk, panelOk)
        return s && p
    }

    // One socket for the app's lifetime, re-created on a collector change. Pushed frames feed
    // handleFrame; every successful open resyncs, since frames only cover what came after it.
    private func restartSocket() {
        socketTask?.cancel()
        socketTask = nil
        socket?.cancel()
        socket = nil
        connectionState = .offline
        guard pollingEnabled else { return }
        let base = collectorURL
        socketTask = Task { await runSocket(base: base) }
    }

    private func runSocket(base: URL) async {
        let url = Self.socketURL(for: base)
        var backoff = Self.socketBackoffMinSec
        var hadLive = false
        var connection: (any LiveSocketConnection)?
        while !Task.isCancelled {
            let fresh = makeSocket(url)
            connection = fresh
            socket = fresh
            do {
                try await fresh.open()
                guard !Task.isCancelled else { break }
                backoff = Self.socketBackoffMinSec
                hadLive = true
                connectionState = .live
                refreshNow()
                while !Task.isCancelled {
                    let text = try await fresh.receive()
                    handleFrame(text, collector: base)
                }
            } catch {
                guard !Task.isCancelled else { break }
                connectionState = hadLive ? .reconnecting : .offline
            }
            fresh.cancel()
            if socket === fresh { socket = nil }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, Self.socketBackoffMaxSec)
        }
        // Only this loop's own connection. A replacement loop may own `socket` by now.
        connection?.cancel()
        if let connection, socket === connection { socket = nil }
    }

    // One pushed frame. The socket carries every host, so only the selected one gets through, and
    // a frame from a socket opened against an earlier collector is dropped with it. Pushed rows
    // land in the feed at once; aggregates are marked dirty and refetched together.
    func handleFrame(_ text: String, collector: URL) {
        guard collector == collectorURL,
              let frame = try? JSONDecoder().decode(LiveFrame.self, from: Data(text.utf8)),
              frame.type == "events", frame.host == selectedHostId
        else { return }
        if !frame.events.isEmpty {
            let known = Set(live.map(\.liveKey))
            let additions = frame.events.filter { !known.contains($0.liveKey) }
            if !additions.isEmpty {
                let merged = (additions + live).sorted { $0.tsMs > $1.tsMs }
                withAnimation(panelAnimation()) { live = Array(merged.prefix(Self.liveFeedCapacity)) }
                updatedAt = .now
            }
            runningHooks.track(frame.events.sorted { $0.tsMs < $1.tsMs })
            runningHooks.prune(nowMs: Date.now.timeIntervalSince1970 * 1000)
            updateTicker()
        }
        if frame.changed > 0 { markDirty() }
    }

    // Ticks at 4 Hz while the panel is open and a hook is running, and not at all otherwise.
    private func updateTicker() {
        let wanted = panelOpen && !runningHooks.isEmpty
        if wanted, tickerTask == nil {
            tickerTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    if Task.isCancelled { return }
                    clock = .now
                    runningHooks.prune(nowMs: clock.timeIntervalSince1970 * 1000)
                    if runningHooks.isEmpty { break }
                }
                tickerTask = nil
            }
        } else if !wanted, let running = tickerTask {
            running.cancel()
            tickerTask = nil
        }
    }

    // Debounce with a cap: refetch 300 ms after the last mark, or 1 s after the first mark in the
    // burst, whichever comes first, so a steady stream still refreshes about once a second.
    private func markDirty() {
        let now = ContinuousClock.now
        let since = dirtySince ?? now
        dirtySince = since
        coalesceTask?.cancel()
        let deadline = min(now + .milliseconds(Self.coalesceDelayMs), since + .milliseconds(Self.coalesceMaxWaitMs))
        coalesceTask = Task {
            try? await Task.sleep(until: deadline)
            guard !Task.isCancelled else { return }
            dirtySince = nil
            coalesceTask = nil
            refreshNow()
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

    private func refreshPanel() async -> Bool {
        let context = currentContext
        // A window change queues a follow-up instead of cancelling, so the answer must still be
        // for the window the user is looking at when it lands.
        let windowMinutes = minutes
        do {
            let newSummary: Summary = try await get("api/summary", [URLQueryItem(name: "minutes", value: String(windowMinutes))], context: context)
            let newLive: [LiveEvent]? = try? await get("api/live", context: context)
            guard !Task.isCancelled, context == currentContext, windowMinutes == minutes else { return true }
            // Animating here lets numbers roll, rows slide and charts morph on every refresh.
            withAnimation(panelAnimation()) {
                summary = newSummary
                summaryError = nil
                live = newLive ?? live
            }
            // The fetched list may predate a pushed completion; track() keeps that completion.
            if let newLive {
                runningHooks.track(newLive.reversed())
                runningHooks.prune(nowMs: Date.now.timeIntervalSince1970 * 1000)
                updateTicker()
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
