import Foundation

// Executable test harness for host selection. It is compiled together with the app's real
// Sources (minus the App entry point) by test/hosts.test.ts, so every assertion runs against
// production types, an isolated UserDefaults suite and a URLSession with a mock URLProtocol.

// MARK: - Mock collector

struct RecordedRequest {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data?

    // Path relative to the collector base, without a leading slash, e.g. "api/status".
    func path(base: String = "/") -> String {
        let full = url.path(percentEncoded: true)
        let trimmed = full.hasPrefix(base) ? String(full.dropFirst(base.count)) : full
        return trimmed
    }

    // Decodes the query the way the collector's URLSearchParams does: "+" is a space.
    var query: [String: [String]] {
        guard let raw = url.query(percentEncoded: true), !raw.isEmpty else { return [:] }
        var out: [String: [String]] = [:]
        for pair in raw.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (s: Substring) in String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "<bad>" }
            let key = decode(parts[0])
            let value = parts.count > 1 ? decode(parts[1]) : ""
            out[key, default: []].append(value)
        }
        return out
    }

    var host: String? { query["host"]?.first }
    var collector: String { "\(url.scheme ?? "")://\(url.host ?? ""):\(url.port ?? 0)" }
}

enum MockAction {
    case json(Int, Any)
    case status(Int)
    case fail(URLError.Code)
    case hold
}

final class MockServer: @unchecked Sendable {
    nonisolated(unsafe) static var current = MockServer { _ in .status(500) }

    private let lock = NSLock()
    private var _recorded: [RecordedRequest] = []
    private var _held: [(RecordedRequest, MockURLProtocol)] = []
    var route: (RecordedRequest) -> MockAction

    init(route: @escaping (RecordedRequest) -> MockAction) { self.route = route }

    var recorded: [RecordedRequest] { lock.withLock { _recorded } }
    var held: [RecordedRequest] { lock.withLock { _held.map(\.0) } }

    func handle(_ request: RecordedRequest, from proto: MockURLProtocol) {
        let action: MockAction = lock.withLock {
            _recorded.append(request)
            return route(request)
        }
        if case .hold = action {
            lock.withLock { _held.append((request, proto)) }
            return
        }
        proto.respond(action)
    }

    // Answers every held request matching the filter. Returns how many were answered.
    @discardableResult
    func release(where filter: (RecordedRequest) -> Bool, with respond: (RecordedRequest) -> MockAction) -> Int {
        let matched: [(RecordedRequest, MockURLProtocol)] = lock.withLock {
            let m = _held.filter { filter($0.0) }
            _held.removeAll { filter($0.0) }
            return m
        }
        for (req, proto) in matched { proto.respond(respond(req)) }
        return matched.count
    }
}

final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    private var runLoop: CFRunLoop?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        runLoop = CFRunLoopGetCurrent()
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        }
        let recorded = RecordedRequest(
            url: request.url!,
            method: request.httpMethod ?? "GET",
            headers: request.allHTTPHeaderFields ?? [:],
            body: body
        )
        MockServer.current.handle(recorded, from: self)
    }

    override func stopLoading() {}

    func respond(_ action: MockAction) {
        let work = { [self] in
            switch action {
            case .json(let status, let object):
                let data = try! JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
                deliver(status: status, data: data)
            case .status(let status):
                deliver(status: status, data: Data())
            case .fail(let code):
                client?.urlProtocol(self, didFailWithError: URLError(code))
            case .hold:
                break
            }
        }
        if let runLoop {
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, work)
            CFRunLoopWakeUp(runLoop)
        } else {
            work()
        }
    }

    private func deliver(status: Int, data: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

func mockSession(requestTimeout: Double) -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    config.timeoutIntervalForRequest = requestTimeout
    config.timeoutIntervalForResource = Prefs.resourceTimeout(forRequestTimeout: requestTimeout)
    return URLSession(configuration: config)
}

// MARK: - Fixtures

func hostJSON(_ id: String, _ name: String) -> [String: Any] {
    ["id": id, "name": name, "createdMs": id == "local" ? NSNull() : 1_700_000_000_000, "lastSeenMs": NSNull()]
}

let localHost = hostJSON("local", "This Mac")

func statusJSON(_ label: String) -> [String: Any] { ["label": label, "state": "ok", "values": ["apiP50": label]] }

func summaryJSON(events: Int) -> [String: Any] {
    [
        "eventCount": events,
        "kpis": ["sessions": 1, "apiP50": 1, "apiP95": 2, "ttftP50": NSNull(), "turnP50": 3, "costUsd": 0.5, "cacheHitRatio": 0.1],
        "breakdown": ["api": 1, "tools": 1, "hooks": 1],
        "apiSeries": ["points": []],
        "hooks": [], "tools": [], "subagents": [],
    ]
}

func liveJSON(_ label: String) -> [[String: Any]] {
    [["tsMs": 1, "kind": "api", "label": label, "ms": 5, "ok": true, "sessionId": NSNull(), "id": 1]]
}

func turnSummaryJSON(_ promptId: String) -> [String: Any] {
    [
        "promptId": promptId, "startMs": 1, "endMs": 2, "wallMs": 1, "inProgress": false,
        "sessionId": NSNull(), "sessionKind": NSNull(), "sessionLabel": NSNull(), "repo": NSNull(), "command": NSNull(),
        "apiMs": 1, "toolMs": 0, "hookMs": 0, "activeMs": NSNull(), "idleMs": NSNull(), "folder": NSNull(),
    ]
}

func turnDetailJSON(_ promptId: String) -> [String: Any] {
    ["promptId": promptId, "command": NSNull(), "startMs": 1, "endMs": 2, "sessionId": NSNull(), "sessionKind": NSNull(),
     "sessionLabel": NSNull(), "repo": NSNull(), "spans": []]
}

func eventJSON(_ label: String) -> [String: Any] {
    ["id": 7, "tsMs": 1, "name": "api_request", "kind": "api", "label": label, "ms": 1, "ok": true,
     "sessionId": NSNull(), "promptId": NSNull(), "details": [], "session": NSNull()]
}

func itemJSON(_ name: String) -> [String: Any] {
    ["kind": "tools", "name": name, "count": 1, "failures": 0, "totalMs": 1, "p50": 1, "p95": 1, "maxMs": 1,
     "headlessCount": 0, "repos": [], "recent": [], "failed": [], "definitions": []]
}

func hookCallJSON(_ name: String) -> [String: Any] {
    ["name": name, "call": ["id": 7, "tsMs": 1, "ms": 5, "ok": true, "launcher": name],
     "session": ["launcher": name], "candidates": ["status": "remote", "scripts": [
        ["source": "user", "type": "telemetry", "command": NSNull(), "configPath": NSNull(),
         "timeoutSec": NSNull(), "summary": "Registered on remote host", "sessions": 1,
         "hookEvent": "Stop", "hookSource": "userSettings"],
     ]], "hint": NSNull()]
}

// Answers every telemetry route for the given host with data tagged by `tag`.
func telemetryReply(_ req: RecordedRequest, tag: String, base: String = "/") -> MockAction {
    switch req.path(base: base) {
    case "api/status": .json(200, statusJSON(tag))
    case "api/summary": .json(200, summaryJSON(events: tag.count * 10 + 1))
    case "api/live": .json(200, liveJSON(tag))
    case "api/turns": .json(200, [turnSummaryJSON("p-\(tag)")])
    case "api/turn": .json(200, turnDetailJSON(req.query["prompt"]?.first ?? "?"))
    case "api/event": .json(200, eventJSON(tag))
    case "api/hook-call": .json(200, hookCallJSON(tag))
    case "api/item": .json(200, itemJSON(tag))
    default: .status(404)
    }
}

// MARK: - Harness

@MainActor
final class Harness {
    var passed = 0
    var failed = 0
    var current = ""
    var currentFailed = false

    func check(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, line: Int = #line) {
        if !condition() {
            currentFailed = true
            print("  assertion failed (line \(line)): \(message())")
        }
    }

    func run(_ name: String, _ body: () async throws -> Void) async {
        current = name
        currentFailed = false
        do {
            try await body()
        } catch {
            currentFailed = true
            print("  threw: \(error)")
        }
        if currentFailed {
            failed += 1
            print("FAIL \(name)")
        } else {
            passed += 1
            print("PASS \(name)")
        }
    }
}

struct TimedOut: Error { let what: String }

@MainActor
func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(timeout)
    while !condition() {
        if Date.now > deadline { throw TimedOut(what: what) }
        try await Task.sleep(for: .milliseconds(15))
    }
}

// An absolute-path suite name makes CFPreferences keep the plist at that path, so test suites
// live in the wrapper's temp directory and never in ~/Library/Preferences.
let prefsDirectory: String = {
    let dir = ProcessInfo.processInfo.environment["CPA_TEST_PREFS_DIR"]
        ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("cpa-menubar-tests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}()

final class IsolatedDefaults {
    let name = (prefsDirectory as NSString).appendingPathComponent("cpa.menubar.tests.\(UUID().uuidString)")
    let defaults: UserDefaults

    init() { defaults = UserDefaults(suiteName: name)! }

    func cleanup() {
        defaults.removePersistentDomain(forName: name)
    }
    // Every stored value, as one string, to search for leaked secrets.
    var dump: String { String(describing: defaults.persistentDomain(forName: name) ?? [:]) }
}

@MainActor
func makeModel(_ store: IsolatedDefaults, polling: Bool = false) -> Telemetry {
    Telemetry(defaults: store.defaults, makeSession: mockSession(requestTimeout:), startPolling: polling)
}

// Stops every loop before the model is dropped, so one test's polling never leaks into the next.
@MainActor
func shutdown(_ model: Telemetry) {
    model.panelOpen = false
    model.stopPolling()
}

// MARK: - Staged stale-response scenarios

enum OwnerSwitch { case host, collector }

// Both owners report prompt id "p-shared", the cross-host collision case, so a late old turn
// matches the new selection by id and only the request-context check can reject it.
// The owner is told apart by the `command` sentinel instead. The old owner's newest turn is
// "p-oldnewest", so only pinning the older "p-shared" ever requests that prompt from it.
func stagedReply(_ req: RecordedRequest, tag: String, oldTag: String = "OLDHOST") -> MockAction {
    switch req.path() {
    case "api/turns":
        let ids = tag == oldTag ? ["p-oldnewest", "p-shared"] : ["p-shared"]
        return .json(200, ids.map { id -> [String: Any] in
            var row = turnSummaryJSON(id)
            row["command"] = tag
            return row
        })
    case "api/turn":
        var detail = turnDetailJSON(req.query["prompt"]?.first ?? "?")
        detail["command"] = tag
        return .json(200, detail)
    default:
        return telemetryReply(req, tag: tag)
    }
}

// The old owner is host A on collector 4318. Every old request upstream of `target` answers,
// so the polling chain (summary, then live, then turns, then the selected turn) actually issues
// the target request, and only that request is held. The test then switches owner, waits for
// the new owner's decoded data, releases the held old request and inspects the model's state.
@MainActor
func stagedStale(_ h: Harness, target: String, switching: OwnerSwitch) async throws {
    let oldTag = "OLDHOST" // summary eventCount 71
    let newTag = "NEW" // summary eventCount 31
    let lateOutcomes: [(String, MockAction?)] = [
        ("late success", nil), ("late connection failure", .fail(.networkConnectionLost)), ("late HTTP 500", .status(500)),
    ]
    for (outcomeName, outcome) in lateOutcomes {
        let store = IsolatedDefaults(); defer { store.cleanup() }
        let isOld = { (r: RecordedRequest) in r.url.port == 4318 && r.host == "A" }
        MockServer.current = MockServer { req in
            if req.path() == "api/hosts" { return .json(200, [localHost, hostJSON("A", "Alpha"), hostJSON("B", "Beta")]) }
            if isOld(req) { return req.path() == target ? .hold : stagedReply(req, tag: oldTag) }
            return stagedReply(req, tag: newTag)
        }
        let model = makeModel(store); defer { shutdown(model) }
        model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
        await model.refreshHosts()
        model.selectedHostId = "A"
        model.startPolling()
        model.panelOpen = true

        let label = "\(target) \(outcomeName)"
        if target == "api/turn" {
            // Pin the turn, so the held request is the one the panel's pinned selection produced.
            try await waitUntil("\(label): old turns list arrives") { model.turns.first?.command == oldTag }
            // Follow-newest asks for "p-oldnewest"; only the pin asks the old owner for "p-shared".
            let isPinnedRequest = { (r: RecordedRequest) in isOld(r) && r.path() == "api/turn" && r.query["prompt"] == ["p-shared"] }
            h.check(!MockServer.current.recorded.contains(where: isPinnedRequest), "\(label): p-shared requested before the pin")
            model.selectedPromptId = "p-shared"
            try await waitUntil("\(label): pinned old turn request issued and held") {
                MockServer.current.held.contains(where: isPinnedRequest)
            }
        } else {
            try await waitUntil("\(label): old request held") {
                MockServer.current.held.contains { isOld($0) && $0.path() == target }
            }
        }
        // The upstream old data really landed, so the chain reached the target and is not short-circuited.
        switch target {
        case "api/turns": h.check(model.summary?.eventCount == 71, "\(label): old summary was not applied before turns")
        case "api/turn": h.check(model.turns.map(\.promptId) == ["p-oldnewest", "p-shared"] && model.turns.allSatisfy { $0.command == oldTag },
                                 "\(label): old turns were not applied before the turn")
        default: break
        }

        switch switching {
        case .host: model.selectedHostId = "B"
        case .collector: model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
        }
        h.check(model.selectedPromptId == nil, "\(label): pinned turn survived the switch")
        try await waitUntil("\(label): new owner's data shown") {
            model.status?.label == newTag && model.summary?.eventCount == 31 && model.live.first?.label == newTag
                && model.turns.map(\.command) == [newTag] && model.turnDetail?.command == newTag
        }
        let released = MockServer.current.release(where: { isOld($0) && $0.path() == target }) { req in
            outcome ?? stagedReply(req, tag: "LATEOLD")
        }
        h.check(released >= 1, "\(label): nothing was held to release")
        try await Task.sleep(for: .milliseconds(400))

        h.check(model.selectedHostId == (switching == .host ? "B" : "A"), "\(label): selection is \(model.selectedHostId)")
        h.check(model.status?.label == newTag, "\(label): status is \(String(describing: model.status?.label))")
        h.check(model.summary?.eventCount == 31, "\(label): summary is \(String(describing: model.summary?.eventCount))")
        h.check(model.live.map(\.label) == [newTag], "\(label): live is \(model.live.map(\.label))")
        h.check(model.turns.map(\.command) == [newTag], "\(label): turns are from \(model.turns.map(\.command))")
        h.check(model.turnDetail?.command == newTag, "\(label): turn detail is from \(String(describing: model.turnDetail?.command))")
        h.check(model.selectedPromptId == nil, "\(label): selected turn is \(String(describing: model.selectedPromptId))")
        h.check(model.summaryError == nil, "\(label): summaryError \(String(describing: model.summaryError))")
        h.check(model.turnsError == nil, "\(label): turnsError \(String(describing: model.turnsError))")
        h.check(model.turnDetailError == nil, "\(label): turnDetailError \(String(describing: model.turnDetailError))")
    }
}

// MARK: - Host actions (the Hosts tab's controller)

func credentialsJSON(token: String) -> [String: Any] {
    ["host": hostJSON("box", "Box"), "token": token,
     "env": ["OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer \(token)"], "tailscaleAddress": "100.64.0.1"]
}

// A collector whose management writes and follow-up host list can each be held. A write
// answers with `writeFailure` when given, else with credentials carrying `token`.
func hostActionServer(holdWrite: Bool, holdListAfterWrite: Bool, token: String, writeFailure: MockAction? = nil) -> MockServer {
    var wrote = false
    return MockServer { req in
        if req.method != "GET" {
            wrote = true
            if holdWrite { return .hold }
            if let writeFailure { return writeFailure }
            return req.path().hasSuffix("/token") ? .json(200, credentialsJSON(token: token)) : .json(201, credentialsJSON(token: token))
        }
        if req.path() == "api/hosts" {
            return wrote && holdListAfterWrite ? .hold : .json(200, [localHost, hostJSON("box", "Box")])
        }
        return .status(404)
    }
}

// Answers whatever is held: the write (with credentials or a failure), and the list.
func releaseHeldHostActions(token: String, writeFailure: MockAction?) {
    MockServer.current.release(where: { _ in true }) { req in
        if req.method != "GET" {
            if let writeFailure { return writeFailure }
            return req.path().hasSuffix("/token") ? .json(200, credentialsJSON(token: token)) : .json(201, credentialsJSON(token: token))
        }
        return .json(200, [localHost, hostJSON("box", "Box")])
    }
}

enum HostActionKind: CaseIterable { case add, regenerate }

@MainActor
func start(_ kind: HostActionKind, on actions: HostActions) {
    switch kind {
    case .add: actions.add(name: "Box") {}
    case .regenerate: actions.regenerate(id: "box")
    }
}

// MARK: - Tests

@main
struct TelemetryHostsTests {
    @MainActor
    static func main() async {
        // Compile-time only: the app keeps its no-argument initializer. Never invoked, since it
        // would poll the real local collector with the real preferences.
        let _: @MainActor () -> Telemetry = { Telemetry() }

        let h = Harness()

        await h.run("isolated defaults stay out of the user's preferences") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            store.defaults.set("probe-value", forKey: "probe")
            h.check(store.defaults.string(forKey: "probe") == "probe-value", "suite does not read back")
            h.check(store.dump.contains("probe-value"), "dump does not see stored values: \(store.dump)")
            h.check(store.name.hasPrefix("/"), "suite name is not a path: \(store.name)")
            h.check(UserDefaults.standard.string(forKey: "probe") == nil, "probe leaked into standard defaults")
        }

        await h.run("local host is first and the default selection") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("r1", "Linux box")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            h.check(model.selectedHostId == "local", "default id is \(model.selectedHostId)")
            h.check(model.selectedHostName == "This Mac", "default name is \(model.selectedHostName)")
            await model.refreshHosts()
            h.check(model.hosts.map(\.id) == ["local", "r1"], "hosts \(model.hosts.map(\.id))")
            h.check(model.hosts.first?.createdMs == nil, "local createdMs should decode as nil")
            h.check(model.hosts.last?.createdMs == 1_700_000_000_000, "remote createdMs")
            h.check(Prefs.Key.allManaged.contains(Prefs.Key.selectedHostId), "selectedHostId is reset by Reset All")
            h.check(Prefs.Key.selectedHostId != Prefs.Key.collectorURL, "selection and collector URL are distinct settings")
        }

        await h.run("every telemetry request carries the encoded host") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            let weird = "h&x=1+2 é/?#"
            let base = "/collector/"
            MockServer.current = MockServer { req in
                if req.path(base: base) == "api/hosts" { return .json(200, [localHost, hostJSON(weird, "Weird")]) }
                return telemetryReply(req, tag: "W", base: base)
            }
            let model = makeModel(store); defer { shutdown(model) }
            model.collectorURL = URL(string: "http://127.0.0.1:4318/collector/")!
            await model.refreshHosts()
            model.selectedHostId = weird
            // Polling starts only after the switch, so every telemetry request below is for the new host.
            let firstAfterSwitch = MockServer.current.recorded.count
            model.startPolling()
            model.panelOpen = true
            _ = try await model.fetchEvent(id: 7)
            let hookCall = try await model.fetchHookCall(id: 7)
            h.check(hookCall.name == "W" && hookCall.candidates.status == "remote", "hook call payload decoded")
            h.check(hookCall.candidates.scripts.first?.hookEvent == "Stop" && hookCall.candidates.scripts.first?.timeoutSec == nil, "remote hook metadata decoded")
            _ = try await model.fetchItem(kind: .tools, name: "a&b=c+d", excludeHeadless: true, pattern: "1/2:1&x=+ é")
            _ = try await model.fetchTurns(sort: .slowest, limit: 5, excludeHeadless: false)
            _ = try await model.fetchTurn(promptId: "p+1&q=2")
            let routes = ["api/status", "api/summary", "api/live", "api/turns", "api/turn", "api/event", "api/item", "api/hook-call"]
            try await waitUntil("all routes requested for the weird host") {
                let seen = Set(MockServer.current.recorded.filter { $0.host == weird }.map { $0.path(base: base) })
                return routes.allSatisfy(seen.contains)
            }
            for req in MockServer.current.recorded.dropFirst(firstAfterSwitch) where routes.contains(req.path(base: base)) {
                h.check(req.url.path(percentEncoded: true).hasPrefix(base), "\(req.url) lost the collector base path")
                h.check(req.query["host"] == [weird], "\(req.path(base: base)) host decoded as \(String(describing: req.query["host"]))")
            }
            let all = MockServer.current.recorded
            let item = all.last { $0.path(base: base) == "api/item" }
            h.check(item?.query["name"] == ["a&b=c+d"], "item name decoded as \(String(describing: item?.query["name"]))")
            h.check(item?.query["kind"] == ["tools"] && item?.query["excludeHeadless"] == ["1"], "item params")
            h.check(item?.query["pattern"] == ["1/2:1&x=+ é"], "pattern filter must be encoded without losing host scope")
            h.check(all.last { $0.path(base: base) == "api/hook-call" }?.query["id"] == ["7"], "hook call id")
            let turn = all.last { $0.path(base: base) == "api/turn" && $0.query["prompt"] == ["p+1&q=2"] }
            h.check(turn != nil, "turn prompt not decoded exactly")
            let event = all.last { $0.path(base: base) == "api/event" }
            h.check(event?.query["id"] == ["7"], "event id")
            let turns = all.last { $0.path(base: base) == "api/turns" && $0.query["sort"] == ["slowest"] }
            h.check(turns?.query["limit"] == ["5"], "turns params")
            let summary = all.last { $0.path(base: base) == "api/summary" }
            h.check(summary?.query["minutes"] == ["60"], "summary minutes")
        }

        await h.run("local requests say host=local") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in telemetryReply(req, tag: "L") }
            let model = makeModel(store); defer { shutdown(model) }
            _ = try await model.fetchEvent(id: 1)
            h.check(MockServer.current.recorded.last?.query["host"] == ["local"], "local event host")
        }

        await h.run("management writes send JSON, Origin and encoded ids") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            let creds: [String: Any] = [
                "host": hostJSON("a/b", "box"), "token": "cpa_TESTTOKEN",
                "env": ["OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer cpa_TESTTOKEN"], "tailscaleAddress": "100.64.0.1",
            ]
            MockServer.current = MockServer { req in
                switch (req.method, req.path(base: "/base/")) {
                case ("GET", "api/hosts"): .json(200, [localHost, hostJSON("a/b", "box")])
                case ("POST", "api/hosts"): .json(201, creds)
                case ("POST", "api/hosts/a%2Fb/token"): .json(200, creds)
                case ("DELETE", "api/hosts/a%2Fb"): .status(204)
                default: .json(404, ["error": "nope"])
                }
            }
            let model = makeModel(store); defer { shutdown(model) }
            model.collectorURL = URL(string: "http://127.0.0.1:4318/base/")!
            _ = try await model.addHost(name: "box")
            _ = try await model.regenerateHostToken(id: "a/b")
            try await model.removeHost(id: "a/b")
            let writes = MockServer.current.recorded.filter { $0.method != "GET" }
            h.check(writes.map { "\($0.method) \($0.path(base: "/base/"))" } == ["POST api/hosts", "POST api/hosts/a%2Fb/token", "DELETE api/hosts/a%2Fb"],
                    "writes \(writes.map { "\($0.method) \($0.url.absoluteString)" })")
            for w in writes {
                h.check(w.headers["Origin"] == "http://127.0.0.1:4318", "\(w.method) Origin \(String(describing: w.headers["Origin"]))")
                h.check(w.headers["Content-Type"] == "application/json", "\(w.method) content type \(String(describing: w.headers["Content-Type"]))")
                h.check(w.host == nil, "management write should not carry a host query")
            }
            let addBody = writes.first?.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
            h.check(addBody == ["name": "box"], "add body \(String(describing: addBody))")
            for w in writes.dropFirst() {
                let body = w.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                h.check(body != nil && body!.isEmpty, "\(w.method) body should be {}")
            }
        }

        await h.run("origin keeps a non-default port and drops the path") {
            h.check(Telemetry.origin(of: URL(string: "http://example.test/x/")!) == "http://example.test", "no port")
            h.check(Telemetry.origin(of: URL(string: "https://example.test:8443/")!) == "https://example.test:8443", "port")
            h.check(Telemetry.origin(of: URL(string: "http://[::1]:4318/")!) == "http://[::1]:4318", "ipv6 brackets")
        }

        await h.run("credentials decode, refresh the list and never persist") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            var created = false
            let token = "cpa_SECRET_\(UUID().uuidString)"
            MockServer.current = MockServer { req in
                switch (req.method, req.path()) {
                case ("GET", "api/hosts"): return .json(200, created ? [localHost, hostJSON("n1", "New box")] : [localHost])
                case ("POST", "api/hosts"):
                    created = true
                    return .json(201, [
                        "host": hostJSON("n1", "New box"), "token": token,
                        "env": ["OTEL_EXPORTER_OTLP_ENDPOINT": "http://<THIS_MAC_TAILSCALE_IP>:4318",
                                "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer \(token)"],
                        "tailscaleAddress": NSNull(),
                    ])
                default: return .status(404)
                }
            }
            let model = makeModel(store); defer { shutdown(model) }
            let creds = try await model.addHost(name: "New box")
            h.check(creds.token == token, "token")
            h.check(creds.host.id == "n1" && creds.host.name == "New box", "host")
            h.check(creds.tailscaleAddress == nil, "tailscaleAddress should be nil")
            h.check(creds.env["OTEL_EXPORTER_OTLP_HEADERS"] == "Authorization=Bearer \(token)", "env header")
            let block = creds.envBlock
            let parsed = (try? JSONSerialization.jsonObject(with: Data(block.utf8))) as? [String: [String: String]]
            h.check(parsed?["env"] == creds.env, "env block round-trips: \(block)")
            h.check(model.hosts.map(\.id) == ["local", "n1"], "list refreshed after add: \(model.hosts.map(\.id))")
            h.check(model.selectedHostId == "local", "adding does not switch hosts")
            h.check(!store.dump.contains(token), "token leaked into preferences")
            h.check(!store.dump.contains("OTEL_EXPORTER"), "env leaked into preferences")
        }

        await h.run("management errors surface the collector message") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                req.method == "POST" ? .json(409, ["error": "A host with that name already exists"]) : .json(200, [localHost])
            }
            let model = makeModel(store); defer { shutdown(model) }
            do {
                _ = try await model.addHost(name: "dup")
                h.check(false, "add should throw on 409")
            } catch {
                h.check(error.localizedDescription.contains("already exists"), "message: \(error.localizedDescription)")
            }
        }

        await h.run("selection persists across launches") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("r1", "Linux box")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            await model.refreshHosts()
            let generation = model.selectionGeneration
            model.selectedHostId = "r1"
            h.check(model.selectionGeneration == generation + 1, "generation \(model.selectionGeneration) after one change")
            h.check(store.defaults.string(forKey: Prefs.Key.selectedHostId) == "r1", "stored id")
            h.check(model.selectedHostName == "Linux box", "name \(model.selectedHostName)")
            let relaunched = makeModel(store); defer { shutdown(relaunched) }
            h.check(relaunched.selectedHostId == "r1", "relaunch id \(relaunched.selectedHostId)")
            h.check(relaunched.selectedHostName != "This Mac", "an unconfirmed remote id must not read as This Mac")
        }

        await h.run("a missing saved host falls back to local after a good list") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            store.defaults.set("gone", forKey: Prefs.Key.selectedHostId)
            MockServer.current = MockServer { req in
                req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("r1", "Linux box")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            h.check(model.selectedHostId == "gone", "saved id loads before the list arrives")
            h.check(model.selectedHostName != "This Mac", "unconfirmed remote shown as \(model.selectedHostName)")
            await model.refreshHosts()
            h.check(model.selectedHostId == "local", "fell back to \(model.selectedHostId)")
            h.check(store.defaults.string(forKey: Prefs.Key.selectedHostId) == "local", "fallback persisted")
        }

        await h.run("no fallback when the host list fails") {
            for failure in [MockAction.fail(.cannotConnectToHost), .status(500), .json(200, ["not": "a list"])] {
                let store = IsolatedDefaults(); defer { store.cleanup() }
                store.defaults.set("r1", forKey: Prefs.Key.selectedHostId)
                MockServer.current = MockServer { _ in failure }
                let model = makeModel(store); defer { shutdown(model) }
                await model.refreshHosts()
                h.check(model.selectedHostId == "r1", "\(failure): selection changed to \(model.selectedHostId)")
                h.check(model.selectedHostName != "This Mac", "\(failure): remote labelled as This Mac")
                h.check(model.hostsError != nil, "\(failure): hostsError not set")
                h.check(store.defaults.string(forKey: Prefs.Key.selectedHostId) == "r1", "\(failure): stored id changed")
            }
        }

        await h.run("a slow host A cannot overwrite host B after switching") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                if req.path() == "api/hosts" { return .json(200, [localHost, hostJSON("A", "Alpha"), hostJSON("B", "Beta")]) }
                if req.host == "A" { return .hold }
                return telemetryReply(req, tag: req.host ?? "?")
            }
            let model = makeModel(store, polling: true); defer { shutdown(model) }
            await model.refreshHosts()
            model.selectedHostId = "A"
            model.panelOpen = true
            model.navigator.open(.event(id: 1))
            let generationA = model.selectionGeneration
            // Manual detail loads are not part of the polling tasks, so nothing cancels them.
            let detachedEvent = Task { @MainActor in try await model.fetchEvent(id: 7) }
            let detachedTurn = Task { @MainActor in try await model.fetchTurn(promptId: "p-A") }
            let detachedHook = Task { @MainActor in try await model.fetchHookCall(id: 7) }
            try await waitUntil("A's status, summary, event, hook call and turn are in flight") {
                Set(MockServer.current.held.map { $0.path() }).isSuperset(of: ["api/status", "api/summary", "api/event", "api/turn", "api/hook-call"])
            }
            model.selectedHostId = "B"
            h.check(model.selectionGeneration == generationA + 1, "generation bumped")
            h.check(model.navigator.stack.isEmpty, "detail stack cleared on switch")
            h.check(model.status == nil && model.summary == nil && model.live.isEmpty, "old telemetry cleared on switch")
            try await waitUntil("B data shown") {
                model.status?.label == "B" && model.summary?.eventCount == 11 && model.live.first?.label == "B"
                    && model.turns.first?.promptId == "p-B" && model.turnDetail?.promptId == "p-B"
            }
            let released = MockServer.current.release(where: { $0.host == "A" }) { telemetryReply($0, tag: "AAAA") }
            h.check(released >= 4, "released \(released) held A requests")
            var eventLeaked = false
            do {
                let late = try await detachedEvent.value
                eventLeaked = true
                print("  late event label \(late.label)")
            } catch {}
            h.check(!eventLeaked, "late A event was returned after switching to B")
            do {
                _ = try await detachedTurn.value
                h.check(false, "late A turn was returned after switching to B")
            } catch {}
            do {
                _ = try await detachedHook.value
                h.check(false, "late A hook call was returned after switching to B")
            } catch {
                h.check(Telemetry.isStale(error), "late hook call must fail as stale, got \(error)")
            }
            try await Task.sleep(for: .milliseconds(300))
            h.check(model.status?.label == "B", "status reverted to \(String(describing: model.status?.label))")
            h.check(model.summary?.eventCount == 11, "summary reverted to \(String(describing: model.summary?.eventCount))")
            h.check(model.live.first?.label == "B", "live reverted")
            h.check(model.turns.map(\.promptId) == ["p-B"], "turns reverted to \(model.turns.map(\.promptId))")
            h.check(model.turnDetail?.promptId == "p-B", "turn detail reverted")
            h.check(model.selectedPromptId == nil, "selected turn should reset on switch")
            h.check(model.summaryError == nil && model.turnsError == nil && model.turnDetailError == nil, "errors appeared")
        }

        await h.run("delayed failures from host A do not mark host B as failed") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                if req.path() == "api/hosts" { return .json(200, [localHost, hostJSON("A", "Alpha"), hostJSON("B", "Beta")]) }
                if req.host == "A" { return .hold }
                return telemetryReply(req, tag: req.host ?? "?")
            }
            let model = makeModel(store, polling: true); defer { shutdown(model) }
            await model.refreshHosts()
            model.selectedHostId = "A"
            model.panelOpen = true
            let detached = Task { @MainActor in try await model.fetchItem(kind: .hooks, name: "x", excludeHeadless: false) }
            let detachedHook = Task { @MainActor in try await model.fetchHookCall(id: 7) }
            try await waitUntil("A in flight") {
                Set(MockServer.current.held.map { $0.path() }).isSuperset(of: ["api/status", "api/summary", "api/item", "api/hook-call"])
            }
            model.selectedHostId = "B"
            try await waitUntil("B data shown") { model.status?.label == "B" && model.turnDetail?.promptId == "p-B" }
            MockServer.current.release(where: { $0.host == "A" }) { _ in .fail(.networkConnectionLost) }
            do {
                _ = try await detached.value
                h.check(false, "detached A item should not succeed")
            } catch {
                h.check(Telemetry.isStale(error), "late A failure should report as stale, got \(error)")
            }
            do {
                _ = try await detachedHook.value
                h.check(false, "late A hook failure should report as stale")
            } catch {
                h.check(Telemetry.isStale(error), "late hook failure should report as stale, got \(error)")
            }
            try await Task.sleep(for: .milliseconds(300))
            h.check(model.status?.label == "B", "status cleared by A failure")
            h.check(model.summaryError == nil && model.turnsError == nil && model.turnDetailError == nil, "A error leaked into B")
        }

        await h.run("collector URL change with the same host id drops the old response") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                if req.path() == "api/hosts" { return .json(200, [localHost, hostJSON("A", "Alpha")]) }
                if req.url.port == 4318 { return .hold }
                return telemetryReply(req, tag: "U2")
            }
            let model = makeModel(store, polling: true); defer { shutdown(model) }
            model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
            await model.refreshHosts()
            model.selectedHostId = "A"
            model.panelOpen = true
            let detached = Task { @MainActor in try await model.fetchEvent(id: 7) }
            try await waitUntil("URL1 status and event in flight") {
                let held = MockServer.current.held
                return held.contains { $0.path() == "api/status" && $0.host == "A" } && held.contains { $0.path() == "api/event" }
            }
            let generation = model.selectionGeneration
            model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
            h.check(model.selectionGeneration > generation, "collector change must invalidate in-flight work")
            h.check(model.selectedHostId == "A", "same host id kept")
            try await waitUntil("URL2 status shown") { model.status?.label == "U2" && model.summary != nil }
            let fromURL2 = MockServer.current.recorded.filter { $0.url.port == 4319 && $0.path() == "api/status" }
            h.check(fromURL2.allSatisfy { $0.host == "A" }, "URL2 status not scoped to A")
            MockServer.current.release(where: { $0.url.port == 4318 }) { telemetryReply($0, tag: "U1-OLD") }
            do {
                _ = try await detached.value
                h.check(false, "old collector event was returned")
            } catch {}
            try await Task.sleep(for: .milliseconds(300))
            h.check(model.status?.label == "U2", "status from old collector: \(String(describing: model.status?.label))")
            h.check(model.live.first?.label == "U2", "live from old collector")
        }

        await h.run("collector URL change with a missing host falls back after the new list") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                if req.path() == "api/hosts" {
                    return .json(200, req.url.port == 4318 ? [localHost, hostJSON("A", "Alpha")] : [localHost])
                }
                return telemetryReply(req, tag: "x")
            }
            let model = makeModel(store, polling: true); defer { shutdown(model) }
            model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
            await model.refreshHosts()
            model.selectedHostId = "A"
            model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
            try await waitUntil("fallback to local on the new collector") { model.selectedHostId == "local" }
        }

        await h.run("staged late status after host switch cannot revert state") {
            try await stagedStale(h, target: "api/status", switching: .host)
        }
        await h.run("staged late summary after host switch cannot revert state") {
            try await stagedStale(h, target: "api/summary", switching: .host)
        }
        await h.run("staged late live after host switch cannot revert state") {
            try await stagedStale(h, target: "api/live", switching: .host)
        }
        await h.run("staged late turns after host switch cannot revert state") {
            try await stagedStale(h, target: "api/turns", switching: .host)
        }
        await h.run("staged late pinned turn after host switch cannot revert state") {
            try await stagedStale(h, target: "api/turn", switching: .host)
        }
        await h.run("staged late status after same-id collector change cannot revert state") {
            try await stagedStale(h, target: "api/status", switching: .collector)
        }
        await h.run("staged late summary after same-id collector change cannot revert state") {
            try await stagedStale(h, target: "api/summary", switching: .collector)
        }
        await h.run("staged late live after same-id collector change cannot revert state") {
            try await stagedStale(h, target: "api/live", switching: .collector)
        }
        await h.run("staged late turns after same-id collector change cannot revert state") {
            try await stagedStale(h, target: "api/turns", switching: .collector)
        }
        await h.run("staged late pinned turn after same-id collector change cannot revert state") {
            try await stagedStale(h, target: "api/turn", switching: .collector)
        }

        await h.run("an older host list cannot override a newer one") {
            for (outcomeName, late) in [("success without A", MockAction.json(200, [localHost])), ("failure", .fail(.networkConnectionLost))] {
                let store = IsolatedDefaults(); defer { store.cleanup() }
                var first = true
                MockServer.current = MockServer { req in
                    guard req.path() == "api/hosts" else { return .status(404) }
                    if first { first = false; return .hold }
                    return .json(200, [localHost, hostJSON("A", "Alpha")])
                }
                store.defaults.set("A", forKey: Prefs.Key.selectedHostId)
                let relaunched = makeModel(store); defer { shutdown(relaunched) }
                let older = Task { @MainActor in await relaunched.refreshHosts() }
                try await waitUntil("\(outcomeName): older list held") { MockServer.current.held.contains { $0.path() == "api/hosts" } }
                await relaunched.refreshHosts()
                h.check(relaunched.hosts.map(\.id) == ["local", "A"], "\(outcomeName): newer list not applied")
                let generation = relaunched.selectionGeneration
                MockServer.current.release(where: { $0.path() == "api/hosts" }) { _ in late }
                _ = await older.value
                h.check(relaunched.selectedHostId == "A", "\(outcomeName): older list moved selection to \(relaunched.selectedHostId)")
                h.check(relaunched.hosts.map(\.id) == ["local", "A"], "\(outcomeName): older list replaced hosts with \(relaunched.hosts.map(\.id))")
                h.check(relaunched.hostsError == nil, "\(outcomeName): older failure set hostsError \(String(describing: relaunched.hostsError))")
                h.check(relaunched.selectionGeneration == generation, "\(outcomeName): older list invalidated state")
                h.check(store.defaults.string(forKey: Prefs.Key.selectedHostId) == "A", "\(outcomeName): stored selection changed")
            }
        }

        await h.run("an old collector's host list cannot apply after a collector change") {
            for (outcomeName, late) in [("success without A", MockAction.json(200, [localHost])), ("failure", .fail(.networkConnectionLost))] {
                let store = IsolatedDefaults(); defer { store.cleanup() }
                store.defaults.set("A", forKey: Prefs.Key.selectedHostId)
                MockServer.current = MockServer { req in
                    guard req.path() == "api/hosts" else { return .status(404) }
                    return req.url.port == 4318 ? .hold : .json(200, [localHost, hostJSON("A", "Alpha on 4319")])
                }
                let model = makeModel(store); defer { shutdown(model) }
                model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
                let older = Task { @MainActor in await model.refreshHosts() }
                try await waitUntil("\(outcomeName): old collector list held") { MockServer.current.held.contains { $0.url.port == 4318 } }
                model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
                await model.refreshHosts()
                let generation = model.selectionGeneration
                MockServer.current.release(where: { $0.url.port == 4318 }) { _ in late }
                _ = await older.value
                h.check(model.selectedHostId == "A", "\(outcomeName): old collector list moved selection to \(model.selectedHostId)")
                h.check(model.selectedHostName == "Alpha on 4319", "\(outcomeName): hosts replaced, name \(model.selectedHostName)")
                h.check(model.hostsError == nil, "\(outcomeName): old failure set hostsError")
                h.check(model.selectionGeneration == generation, "\(outcomeName): old list invalidated state")
            }
        }

        await h.run("removing the selected host selects local") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            var removed = false
            MockServer.current = MockServer { req in
                switch (req.method, req.path()) {
                case ("GET", "api/hosts"): return .json(200, removed ? [localHost] : [localHost, hostJSON("r1", "Box")])
                case ("DELETE", "api/hosts/r1"): removed = true; return .status(204)
                default: return .status(404)
                }
            }
            let model = makeModel(store); defer { shutdown(model) }
            await model.refreshHosts()
            model.selectedHostId = "r1"
            try await model.removeHost(id: "r1")
            h.check(model.selectedHostId == "local", "selection \(model.selectedHostId)")
            h.check(model.hosts.map(\.id) == ["local"], "list \(model.hosts.map(\.id))")
        }

        await h.run("a late remove on the old collector does not reset the new selection") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                if req.method == "DELETE" { return .hold }
                return req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("A", "Alpha")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
            await model.refreshHosts()
            model.selectedHostId = "A"
            let removal = Task { @MainActor in try await model.removeHost(id: "A") }
            try await waitUntil("DELETE in flight") { MockServer.current.held.contains { $0.method == "DELETE" } }
            model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
            await model.refreshHosts()
            h.check(model.selectedHostId == "A", "new collector confirmed A")
            let generation = model.selectionGeneration
            MockServer.current.release(where: { $0.method == "DELETE" }) { _ in .status(204) }
            _ = try? await removal.value
            h.check(model.selectedHostId == "A", "late old-collector remove reset selection to \(model.selectedHostId)")
            h.check(model.selectionGeneration == generation, "late remove invalidated the new collector's state")
        }

        await h.run("reset all selects local and bumps the generation") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("r1", "Box")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            await model.refreshHosts()
            model.selectedHostId = "r1"
            let generation = model.selectionGeneration
            model.resetAllSettings()
            h.check(model.selectedHostId == "local", "selection \(model.selectedHostId)")
            h.check(model.selectionGeneration > generation, "generation not bumped")
            let stored = store.defaults.string(forKey: Prefs.Key.selectedHostId)
            h.check(stored == nil || stored == "local", "stored \(String(describing: stored))")
        }

        await h.run("dashboard URL carries the selected host") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = MockServer { req in
                req.path() == "api/hosts" ? .json(200, [localHost, hostJSON("r 1&x", "Box")]) : .status(404)
            }
            let model = makeModel(store); defer { shutdown(model) }
            h.check(model.dashboardURL.absoluteString == "http://127.0.0.1:4318/", "local dashboard \(model.dashboardURL)")
            await model.refreshHosts()
            model.selectedHostId = "r 1&x"
            let req = RecordedRequest(url: model.dashboardURL, method: "GET", headers: [:], body: nil)
            h.check(req.query["host"] == ["r 1&x"], "dashboard host \(model.dashboardURL)")
            h.check(model.dashboardURL.path() == "/", "dashboard path \(model.dashboardURL)")
        }

        await h.run("remote paths stay verbatim, local paths shorten") {
            let home = NSHomeDirectory()
            h.check(displayPath(home + "/code/x", hostId: "local") == "~/code/x", "local path")
            h.check(displayPath(home + "/code/x", hostId: "r1") == home + "/code/x", "remote path was abbreviated")
            h.check(displayPath("~/code", hostId: "r1") == "~/code", "remote tilde path")
        }

        await h.run("menu bar label names a remote host and keeps local unchanged") {
            let ok = Status(label: "1.2s", state: "ok", values: ["apiP50": "1.2s"])
            let local = MenuBarLabelContent(status: ok, style: .iconAndValue, labelValue: "apiP50", offline: .off, hostName: nil)
            h.check(local.text == "1.2s" && local.showIcon, "local text \(String(describing: local.text))")
            h.check(local.accessibility == "Claude Code telemetry", "local a11y \(local.accessibility)")
            let remote = MenuBarLabelContent(status: ok, style: .iconAndValue, labelValue: "apiP50", offline: .off, hostName: "Linux box")
            h.check(remote.text?.contains("1.2s") == true && remote.text?.contains("Linux box") == true, "remote text \(String(describing: remote.text))")
            h.check(remote.accessibility.contains("Linux box"), "remote a11y \(remote.accessibility)")
            let iconOnly = MenuBarLabelContent(status: ok, style: .iconOnly, labelValue: "apiP50", offline: .off, hostName: "Linux box")
            h.check(iconOnly.text == nil && iconOnly.showIcon, "icon only should stay icon only")
            h.check(iconOnly.accessibility.contains("Linux box"), "icon only a11y")
            let offline = MenuBarLabelContent(status: nil, style: .valueOnly, labelValue: "apiP50", offline: .hidden, hostName: nil)
            h.check(offline.showIcon && offline.text == nil, "offline hidden keeps icon")
        }

        await h.run("remote hook definitions decode event and source without command") {
            let json = #"{"source":"plugin","plugin":"p","matcher":"Bash","type":"telemetry","command":null,"summary":"Registered on remote host","sessions":2,"configPath":null,"hookEvent":"PreToolUse","hookSource":"pluginHook"}"#
            let def = try JSONDecoder().decode(ItemDetail.Definition.self, from: Data(json.utf8))
            h.check(def.hookEvent == "PreToolUse" && def.hookSource == "pluginHook", "fields")
            h.check(def.command == nil && def.configPath == nil, "command/config absent")
            let old = #"{"source":"user","plugin":null,"matcher":null,"type":"command","command":"x","summary":"x","sessions":1,"configPath":"/a"}"#
            let oldDef = try JSONDecoder().decode(ItemDetail.Definition.self, from: Data(old.utf8))
            h.check(oldDef.hookEvent == nil && oldDef.command == "x", "local payload still decodes")
        }

        await h.run("host actions reveal credentials and errors for the current tab") {
            for kind in HostActionKind.allCases {
                let store = IsolatedDefaults(); defer { store.cleanup() }
                MockServer.current = hostActionServer(holdWrite: false, holdListAfterWrite: false, token: "cpa_CURRENT")
                let model = makeModel(store); defer { shutdown(model) }
                let actions = HostActions(model: model)
                var addedCallbacks = 0
                switch kind {
                case .add: actions.add(name: "Box") { addedCallbacks += 1 }
                case .regenerate: actions.regenerate(id: "box")
                }
                h.check(actions.busy, "\(kind): not busy while running")
                await actions.task?.value
                h.check(actions.revealed?.token == "cpa_CURRENT", "\(kind): reveal \(String(describing: actions.revealed?.token))")
                h.check(!actions.busy && actions.error == nil, "\(kind): busy \(actions.busy) error \(String(describing: actions.error))")
                if kind == .add { h.check(addedCallbacks == 1, "add success callback ran \(addedCallbacks)x") }
                actions.dismissReveal()
                h.check(actions.revealed == nil, "\(kind): Done did not clear the reveal")
            }
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = hostActionServer(holdWrite: false, holdListAfterWrite: false, token: "x",
                                                  writeFailure: .json(409, ["error": "A host with that name already exists"]))
            let model = makeModel(store); defer { shutdown(model) }
            let actions = HostActions(model: model)
            actions.add(name: "Box") {}
            await actions.task?.value
            h.check(actions.error?.contains("already exists") == true, "current error \(String(describing: actions.error))")
            h.check(actions.revealed == nil && !actions.busy, "current failure state")
        }

        await h.run("a late host action after the tab closed reveals nothing") {
            for kind in HostActionKind.allCases {
                for (outcomeName, failure) in [("success", nil), ("failure", MockAction.json(409, ["error": "late failure"]))] as [(String, MockAction?)] {
                    for holdList in [false, true] {
                        let stage = holdList ? "follow-up list" : "write"
                        let label = "\(kind) \(outcomeName), deferred \(stage)"
                        // A failed write never reaches the follow-up list, so that pairing has nothing to hold.
                        if holdList && failure != nil { continue }
                        let store = IsolatedDefaults(); defer { store.cleanup() }
                        MockServer.current = hostActionServer(holdWrite: !holdList, holdListAfterWrite: holdList, token: "cpa_LATE", writeFailure: failure)
                        let model = makeModel(store); defer { shutdown(model) }
                        let actions = HostActions(model: model)
                        var addedCallbacks = 0
                        switch kind {
                        case .add: actions.add(name: "Box") { addedCallbacks += 1 }
                        case .regenerate: actions.regenerate(id: "box")
                        }
                        let old = actions.task
                        try await waitUntil("\(label): request held") {
                            MockServer.current.held.contains { holdList ? $0.method == "GET" : $0.method != "GET" }
                        }
                        actions.tabDisappeared()
                        h.check(!actions.busy && actions.revealed == nil && actions.error == nil, "\(label): closing did not reset the tab state")
                        releaseHeldHostActions(token: "cpa_LATE", writeFailure: failure)
                        await old?.value
                        // Reopening the tab shows whatever the retained controller holds now.
                        h.check(actions.revealed == nil, "\(label): reopened tab revealed \(String(describing: actions.revealed?.token))")
                        h.check(actions.error == nil, "\(label): reopened tab shows error \(String(describing: actions.error))")
                        h.check(!actions.busy, "\(label): busy after the late completion")
                        h.check(addedCallbacks == 0, "\(label): late success callback ran \(addedCallbacks)x")
                        h.check(model.hostsError == nil, "\(label): hostsError \(String(describing: model.hostsError))")
                    }
                }
            }
        }

        await h.run("an old host action cannot clear a newer action's busy state") {
            let store = IsolatedDefaults(); defer { store.cleanup() }
            MockServer.current = hostActionServer(holdWrite: true, holdListAfterWrite: false, token: "cpa_X")
            let model = makeModel(store); defer { shutdown(model) }
            let actions = HostActions(model: model)
            actions.add(name: "Box") {}
            let old = actions.task
            try await waitUntil("add held") { MockServer.current.held.contains { $0.method == "POST" && $0.path() == "api/hosts" } }
            actions.tabDisappeared()
            actions.regenerate(id: "box")
            let newer = actions.task
            try await waitUntil("regenerate held") { MockServer.current.held.contains { $0.path().hasSuffix("/token") } }
            MockServer.current.release(where: { $0.path() == "api/hosts" && $0.method == "POST" }) { _ in .json(201, credentialsJSON(token: "cpa_OLD")) }
            await old?.value
            h.check(actions.busy, "old completion cleared the newer action's busy state")
            h.check(actions.revealed == nil, "old completion revealed \(String(describing: actions.revealed?.token))")
            MockServer.current.release(where: { $0.path().hasSuffix("/token") }) { _ in .json(200, credentialsJSON(token: "cpa_NEW")) }
            await newer?.value
            h.check(actions.revealed?.token == "cpa_NEW", "newer reveal \(String(describing: actions.revealed?.token))")
            h.check(!actions.busy, "newer action left busy set")
        }

        await h.run("a host action from before a collector A-B-A change reveals nothing") {
            for (outcomeName, failure) in [("success", nil), ("failure", MockAction.json(409, ["error": "late failure"]))] as [(String, MockAction?)] {
                let store = IsolatedDefaults(); defer { store.cleanup() }
                MockServer.current = hostActionServer(holdWrite: true, holdListAfterWrite: false, token: "cpa_ABA", writeFailure: failure)
                let model = makeModel(store); defer { shutdown(model) }
                model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
                let actions = HostActions(model: model)
                actions.add(name: "Box") {}
                let old = actions.task
                try await waitUntil("\(outcomeName): add held") { MockServer.current.held.contains { $0.method == "POST" } }
                // What the tab's onChange(of: collectorURL) does, for each change.
                model.collectorURL = URL(string: "http://127.0.0.1:4319/")!
                actions.collectorChanged()
                model.collectorURL = URL(string: "http://127.0.0.1:4318/")!
                actions.collectorChanged()
                releaseHeldHostActions(token: "cpa_ABA", writeFailure: failure)
                await old?.value
                h.check(actions.revealed == nil, "\(outcomeName): A-B-A revealed \(String(describing: actions.revealed?.token))")
                h.check(actions.error == nil, "\(outcomeName): A-B-A error \(String(describing: actions.error))")
                h.check(!actions.busy, "\(outcomeName): busy after A-B-A")
            }
        }

        print("SUMMARY passed=\(h.passed) failed=\(h.failed)")
        exit(h.failed == 0 ? 0 : 1)
    }
}
