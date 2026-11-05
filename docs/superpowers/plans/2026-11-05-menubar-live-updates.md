# Menu Bar Live Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the menu bar app's 2 s polling with the collector's existing WebSocket so the panel updates per event, refetches aggregates in coalesced bursts, shows ticking in-flight hooks and keeps a 30 s refresh for time-based values.

**Architecture:** Push invalidates, pull aggregates. The Swift model keeps one long-lived socket to `/ws`, merges pushed events straight into the Live feed, marks aggregates dirty and refetches them through a 300 ms debounce with a 1 s cap. One 30 s refresh loop runs in every connection state. The collector gains one small change: trace and metric batches publish the same frame shape with an empty event list.

**Tech Stack:** Bun, TypeScript (collector), SwiftUI on macOS 14, `@Observable`, URLSessionWebSocketTask, the existing swiftc test harness run by `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-05-menubar-live-updates-design.md`

## Global Constraints
- Socket frame shape stays `{ "type": "events", "host": <hostId>, "events": [LiveEvent...], "changed": <n> }`. No new message type.
- Coalescing constants: 300 ms debounce after the last dirty mark, never later than 1 s after the first mark in a burst. Constants, not settings.
- Slow refresh: fixed 30 s, runs in every connection state; a coalesced refetch resets its timer. The host list poll (10 s) is unchanged.
- Reconnect backoff: start 1 s, double, cap 15 s, reset to 1 s after a successful open. Every open runs one full resync.
- Live feed capacity 60 rows (what `/api/live` returns). Row identity is the key `"\(tsMs)/\(sessionId ?? "")/\(kind)/\(label)"`, the same one `rowIds` uses in `LiveFeed.swift`.
- Running hook staleness cutoff 120 000 ms (same as the dashboard's `STALE_HOOK_MS`). Ticker 4 Hz (250 ms), only while the panel is open and at least one hook is running.
- The settings "Status poll interval" and "Panel poll interval" are removed. `requestTimeoutSec` and `retryDelaySec` stay.
- Animations go through the existing `panelAnimation()`; the elapsed counter updates even when animations are off.
- Comments and docs: short, plain, no long dashes.
- Work happens in the worktree `.claude/worktrees/live-updates` on branch `feat/menubar-live-updates`. All test commands run from that directory.

## Review Focus
1. A malformed or non-JSON socket frame: the model ignores it and stays live (Task 5 test "a malformed frame is ignored").
2. A frame arriving while a host switch is in progress: dropped, nothing from the old host shows (Task 5 test "a frame after a host switch is dropped").
3. The collector restarts while the panel is open: state leaves live, the 30 s refresh keeps data flowing, reconnect resyncs (Task 4 tests on close and reopen).
4. A hook_start whose hook completion never arrives: pruned after 120 s so the counter does not run forever (Task 6 pure test).
5. Old builds left `statusPollIntervalSec` / `panelPollIntervalSec` in UserDefaults: Reset All Settings still clears them (Task 8 test).

---

### Task 1: Collector publishes for trace and metric batches

**Files:**
- Modify `apps/collector/src/http.ts` (the `ingest` function, traces and metrics branches, around the `broadcast` call on the logs branch).
- Test: `apps/collector/test/ingest.test.ts`.

**Interfaces:**
- Consumes: the existing `ingest` request handlers and `store.addSpans(...)`, `store.addMetrics(...)`, `broadcast`.
- Produces: nothing new for Swift, the frame shape is unchanged. Add `function broadcastChanged(hostId: string, changed: number)` next to `broadcast`, publishing `JSON.stringify({ type: "events", host: hostId, events: [], changed })`.

- [ ] **Step 1: Write the failing test**

Add to `apps/collector/test/ingest.test.ts`, reusing `startCollector` and `otlpJson` from `./server`:

```ts
test("trace and metric batches notify WebSocket clients with an empty event list", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${collector.port}/ws`);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const frames: any[] = [];
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  for (const signal of ["traces", "metrics"] as const) {
    const res = await fetch(`${collector.url}/v1/${signal}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(otlpJson(signal, `notify-${signal}`, "m")),
    });
    expect(res.status).toBe(200);
  }
  for (let i = 0; i < 20 && frames.length < 2; i++) await Bun.sleep(100);
  ws.close();
  expect(frames).toHaveLength(2);
  for (const f of frames) expect(f).toEqual({ type: "events", host: "local", events: [], changed: 1 });
});
```

- [ ] **Step 2: Run the test to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/collector/test/ingest.test.ts
```

Expected: FAIL, `frames` has length 0.

- [ ] **Step 3: Implement**

Add `broadcastChanged(hostId, changed)` next to `broadcast`. Call it after `store.addSpans(...)` with the parsed span count and after `store.addMetrics(...)` with the parsed metric count. Do not publish when the count is 0.

- [ ] **Step 4: Run the test to see it pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/collector/test/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/collector/src/http.ts apps/collector/test/ingest.test.ts
git commit -m "feat(collector): notify socket clients on trace and metric batches"
```

### Task 2: Socket seam and frame model

**Files:**
- Create `apps/menubar/Sources/Networking/LiveSocket.swift`.
- Modify `apps/menubar/Sources/Models/Payloads.swift` (add `Equatable` to `LiveEvent`, add a `liveKey` property).
- Modify `apps/menubar/Sources/Views/Panel/LiveFeed.swift` (build ids from `e.liveKey`).
- Test: `apps/menubar/Tests/TelemetryHostsTests.swift` (new `h.run` check) and `apps/menubar/test/hosts.test.ts` (append the new check name to the `required` array, the test fails otherwise).

**Interfaces:**
- Consumes: `LiveEvent`, `Telemetry`.
- Produces (exact Swift):

```swift
enum LiveConnectionState: Equatable { case live, reconnecting, offline }

// One frame from the collector's /ws.
struct LiveFrame: Decodable, Equatable {
    let type: String
    let host: String
    let events: [LiveEvent]
    let changed: Int
}

// What Telemetry needs from a socket. Production wraps URLSessionWebSocketTask, tests script frames.
protocol LiveSocketConnection: AnyObject, Sendable {
    // Returns once the handshake succeeded, throws if it did not.
    func open() async throws
    // Next text frame. Throws when the connection closes or fails.
    func receive() async throws -> String
    func cancel()
}
typealias LiveSocketFactory = @Sendable (URL) -> any LiveSocketConnection

final class URLSessionLiveSocket: LiveSocketConnection { init(url: URL, session: URLSession) ... }  // builder decides how open() detects the handshake (delegate didOpen or a ping)

extension LiveEvent {
    // Same identity LiveFeed's rowIds uses, so pushed rows and fetched rows match up.
    var liveKey: String { "\(tsMs)/\(sessionId ?? "")/\(kind)/\(label)" }
}
extension Telemetry {
    // ws:// or wss:// for the collector's /ws, keeping any sub-path and port.
    static func socketURL(for collector: URL) -> URL
}
```

- [ ] **Step 1: Write the failing harness check**

Append to the `TelemetryHostsTests.swift` main list and add its name to the `required` array in `apps/menubar/test/hosts.test.ts`:

```swift
await h.run("socket URL swaps the scheme and keeps the collector path and port") {
    let a = Telemetry.socketURL(for: URL(string: "http://127.0.0.1:4318/")!)
    h.check(a.absoluteString == "ws://127.0.0.1:4318/ws", "got \(a)")
    let b = Telemetry.socketURL(for: URL(string: "https://box.example:8443/collector/")!)
    h.check(b.absoluteString == "wss://box.example:8443/collector/ws", "got \(b)")
    let frame = try JSONDecoder().decode(LiveFrame.self, from: Data(#"{"type":"events","host":"local","events":[],"changed":3}"#.utf8))
    h.check(frame.changed == 3 && frame.events.isEmpty, "frame decode")
}
```

- [ ] **Step 2: Run the harness to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL with a compile error for the missing symbols. This compiles all Swift sources, so it takes a few minutes.

- [ ] **Step 3: Implement**

Create `LiveSocket.swift` with the types above. Add `Equatable` and `liveKey` to `LiveEvent`. Change `LiveFeed.swift` to build its ids from `e.liveKey` instead of the inline string.

- [ ] **Step 4: Run the harness to see it pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Sources/Networking/LiveSocket.swift apps/menubar/Sources/Models/Payloads.swift \
  apps/menubar/Sources/Views/Panel/LiveFeed.swift apps/menubar/Tests/TelemetryHostsTests.swift \
  apps/menubar/test/hosts.test.ts
git commit -m "feat(menubar): add the live socket seam and frame model"
```

### Task 3: Fake socket in the test harness

**Files:**
- Modify `apps/menubar/Tests/TelemetryHostsTests.swift` (add fake socket types near `MockServer`, change `makeModel` to inject the hub, add the check).
- Modify `apps/menubar/test/hosts.test.ts` (required list).

**Interfaces:**
- Consumes: `LiveSocketConnection`, `LiveSocketFactory`.
- Produces (test-only):

```swift
// Scripted socket. Mode decides whether open() succeeds. Frames pushed with push() come out of receive(); close() makes the pending receive() throw.
final class FakeSocket: LiveSocketConnection, @unchecked Sendable {
    let url: URL
    func push(_ text: String)
    func close()
}
final class FakeSocketHub: @unchecked Sendable {
    enum Mode { case refuse, accept }
    var mode: Mode
    var sockets: [FakeSocket]        // every socket the model created, in order
    var factory: LiveSocketFactory  // hands out FakeSocket instances using the current mode
}
```

This task only adds the two types and a check that exercises them directly. It does not touch `makeModel` or `Telemetry`, so it compiles against Task 2 alone. Task 4 changes `makeModel` to inject the hub once the `Telemetry` init accepts a socket factory.

- [ ] **Step 1: Write the failing check**

Check name: "the fake socket hands frames to receive and fails on close". Add the same name to the `required` array in `apps/menubar/test/hosts.test.ts`.

- [ ] **Step 2: Run the harness to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL, the name is required and no such check ran.

- [ ] **Step 3: Implement**

Add `FakeSocket` and `FakeSocketHub`. Assertions in the check: after `push("x")`, `receive()` returns `"x"`; after `close()`, `receive()` throws; a hub in `.refuse` mode makes `open()` throw.

- [ ] **Step 4: Run the harness to see it pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Tests/TelemetryHostsTests.swift apps/menubar/test/hosts.test.ts
git commit -m "test(menubar): add a scripted socket for the harness"
```

### Task 4: Telemetry runs the socket, resyncs and keeps one 30 s refresh loop

**Files:**
- Modify `apps/menubar/Sources/Networking/Telemetry.swift`.
- Modify `apps/menubar/Sources/Settings/ConnectionSettingsTab.swift` (delete the two poll interval steppers, rename `Section("Polling")` to `Section("Requests")`).
- Modify `apps/menubar/Tests/TelemetryHostsTests.swift` (`makeModel` becomes `makeModel(_ store: IsolatedDefaults, polling: Bool = false, hub: FakeSocketHub = FakeSocketHub(mode: .refuse), refreshIntervalSec: Double = Telemetry.refreshIntervalSec) -> Telemetry` and passes `makeSocket: hub.factory` and `refreshIntervalSec:` into `Telemetry`; the default `.refuse` hub keeps every existing check on the HTTP path) and `apps/menubar/test/hosts.test.ts`.

**Interfaces:**
- Consumes: `LiveSocketFactory`, `LiveConnectionState`, `LiveFrame`, `Telemetry.socketURL(for:)`, `FakeSocketHub`.
- Produces (on `Telemetry`):

```swift
init(defaults: UserDefaults = .standard,
     makeSession: @escaping (Double) -> URLSession = Telemetry.makeSession(requestTimeout:),
     makeSocket: LiveSocketFactory = Telemetry.makeSocket(url:),
     refreshIntervalSec: Double = Telemetry.refreshIntervalSec,
     startPolling: Bool = true)             // name kept so existing tests compile; it now starts the socket and the refresh loop
static let refreshIntervalSec = 30.0
static let socketBackoffMinSec = 1.0
static let socketBackoffMaxSec = 15.0
var connectionState: LiveConnectionState   // observable, starts .offline
func refreshNow()                           // immediate full refresh (status, hosts stay on their own loop, panel when open) and restarts the 30 s timer
```

- [ ] **Step 1: Write the failing checks**

Add these names to the `required` array in `apps/menubar/test/hosts.test.ts`, then the checks in `TelemetryHostsTests.swift`, using `makeModel(store, polling: true, hub:)` and `waitUntil`. Pass `refreshIntervalSec: 0.5` where a test needs to observe the slow loop.

- "socket open resyncs once and suppresses fast polling": hub `.accept`; after `connectionState == .live` wait 300 ms; recorded `api/status` requests equal exactly 2 (the startup refresh the loop runs at once, then the resync on open); then sleep 1.2 s more with the default 30 s interval; still exactly 2.
- "socket close leaves live and the slow refresh keeps running": hub `.accept`, `refreshIntervalSec: 0.5`; after live, `hub.sockets.last!.close()`; wait until `connectionState != .live`; count `api/status` requests, sleep 1.2 s, count grew by at least 2.
- "reconnect backs off and resyncs on reopen": hub `.refuse`; wait until `hub.sockets.count >= 2` and check the gap between the two factory calls is at least 1 s and `connectionState == .offline`; switch hub to `.accept`; wait until `.live`; `api/status` count grew by 1.

- [ ] **Step 2: Run the harness to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL, the three check names are required and do not exist yet.

- [ ] **Step 3: Implement**

Replace `statusTask` and `panelTask` with one `refreshTask` loop: an immediate `refreshAll()`, then `sleep(refreshIntervalSec, or retryDelaySec after a failure)` and `refreshAll()` again. `refreshAll()` runs `refreshStatus()` and, if `panelOpen`, `refreshPanel()` concurrently with `async let`. `refreshNow()` restarts that loop; if a `refreshAll()` is already in flight it lets it finish and runs one more right after, so no request is cancelled and no two run at once. `startPolling()`, `panelOpen`, `minutes`, `retry()` and `invalidateTelemetry()` call `refreshNow()`. A fetched `/api/live` list replaces `live` wholesale, as today; it is the authoritative copy. Remove `restartStatusPolling`, `restartPanelPolling`, `statusPollIntervalSec` and `panelPollIntervalSec` from the model, and delete the two steppers from `ConnectionSettingsTab.swift` in this step so the app compiles.

The `socketTask` loop: build `Self.socketURL(for: collectorURL)`, `makeSocket(url)`, `try await open()`; on success set `backoff = 1`, `connectionState = .live`, `refreshNow()`, then loop `receive()` and call `handleFrame(text, collector: base)`. This task adds `handleFrame` as a stub that does nothing, Task 5 fills it in. On any throw: `cancel()`, set `connectionState = hadLive ? .reconnecting : .offline`, sleep `backoff`, double it up to 15. The `collectorURL` setter restarts the socket loop. `stopPolling()` cancels it too. Host switches do not touch the socket: it carries every host and `handleFrame` filters by the current selection.

Production `static func makeSocket(url: URL) -> any LiveSocketConnection` returns `URLSessionLiveSocket(url:session:)` with its own ephemeral `URLSession` built by `Telemetry.makeSession(requestTimeout: Prefs.Defaults.requestTimeoutSec)`. The request timeout setting does not apply to the socket, so changing it does not reconnect.

- [ ] **Step 4: Run the harness to see it pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Sources/Networking/Telemetry.swift apps/menubar/Sources/Settings/ConnectionSettingsTab.swift \
  apps/menubar/Tests/TelemetryHostsTests.swift apps/menubar/test/hosts.test.ts
git commit -m "feat(menubar): drive the panel from the collector socket with a 30 s refresh"
```

### Task 5: Frames feed the Live section and coalesce aggregate refetches

**Files:**
- Modify `apps/menubar/Sources/Networking/Telemetry.swift` (replace the `handleFrame` stub).
- Modify `apps/menubar/Tests/TelemetryHostsTests.swift` and `apps/menubar/test/hosts.test.ts`.

**Interfaces:**
- Consumes: `LiveFrame`, `panelAnimation()`, `refreshStatus()`, `refreshPanel()`.
- Produces:

```swift
static let coalesceDelayMs = 300
static let coalesceMaxWaitMs = 1000
static let liveFeedCapacity = 60
func handleFrame(_ text: String, collector: URL)   // internal
private func markDirty()
```

`handleFrame` decodes `LiveFrame`, ignores anything not type `"events"`, not the current `selectedHostId`, or not the current `collectorURL`. It merges events into `live` by `liveKey`, newest first, capped at 60, inside `withAnimation(panelAnimation())`. If `changed > 0` it calls `markDirty()`, then `runningHooks.track` (Task 6).

`markDirty()` is the debounce: it fires `refreshNow()` 300 ms after the last mark, or 1 s after the first mark in the burst, whichever comes first. If a refresh is in flight, one more runs right after it, never two.

- [ ] **Step 1: Write the failing checks**

Add these names to the `required` array, then the checks, with the hub in `.accept` mode, the panel open, and mock routes answering `api/live` with rows carrying ids:

- "a pushed frame for the selected host lands in live before any live request": hold `api/live` with `.hold`; push a frame with one event for host local (id null); `waitUntil` `live.first?.label` equals the pushed label; check `live.first?.id == nil` and no `api/live` was answered yet.
- "pushed rows gain their id after the coalesced refetch": same frame with `changed: 1`; mock `api/live` returns the same row (same tsMs, sessionId, kind, label) with `"id": 42`; `waitUntil` `live.first?.id == 42`; check `live.count == 1` (no duplicate).
- "a frame for another host changes nothing": push a frame with `host: "r1"` while local is selected; sleep 400 ms; `live` unchanged and no new `api/summary` request.
- "a burst of frames causes one coalesced summary refetch": record the summary count; push 10 frames with `changed: 1`, 10 ms apart; sleep 800 ms; summary count grew by exactly 1.
- "a steady stream of frames refetches about once a second": push a frame every 100 ms for 3 s; summary count grew by 3 or 4.
- "an empty-events frame with changed triggers a refetch": frame with `events: []`, `changed: 2`; summary count grows by 1 within 800 ms.
- "a frame after a host switch is dropped": a frame for host A arrives after `selectedHostId = "B"`; `live` stays B's.
- "a malformed frame is ignored": push `"not json"` and `{"type":"nope"}`; the model is still `.live` and `live` is unchanged.

- [ ] **Step 2: Run the harness to see them fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL, the check names are required and do not exist yet.

- [ ] **Step 3: Implement**

Replace the `handleFrame` stub and add `markDirty()` as described above.

- [ ] **Step 4: Run the harness to see them pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Sources/Networking/Telemetry.swift apps/menubar/Tests/TelemetryHostsTests.swift \
  apps/menubar/test/hosts.test.ts
git commit -m "feat(menubar): merge pushed events and coalesce aggregate refetches"
```

### Task 6: Running hooks model and ticker

**Files:**
- Create `apps/menubar/Sources/Models/RunningHooks.swift`.
- Modify `apps/menubar/Sources/Networking/Telemetry.swift` (track on frames and on fetched live lists, run the ticker).
- Modify `apps/menubar/Tests/TelemetryHostsTests.swift` and `apps/menubar/test/hosts.test.ts`.

**Interfaces:**
- Consumes: `LiveEvent` (`kind`, `label`, `sessionId`, `tsMs`).
- Produces:

```swift
struct RunningHook: Identifiable, Equatable {
    let sessionId: String?
    let label: String
    let startedMs: Double
    var id: String { "\(sessionId ?? "")|\(label)" }
}
// Hooks that started and have not completed. Pure value type so it is testable without the model.
struct RunningHooks: Equatable {
    static let staleMs = 120_000.0
    private(set) var entries: [RunningHook]   // oldest first
    var isEmpty: Bool
    mutating func track(_ events: [LiveEvent])          // events in chronological order; kind "hook_start" inserts or replaces by id, kind "hook" removes by id
    mutating func prune(nowMs: Double)                   // drops entries older than staleMs
}
```

On `Telemetry`: `var runningHooks = RunningHooks()`, `var clock = Date.now` (observable, advanced by the ticker), `var isTicking: Bool` (true while the ticker task exists, for tests).

After a frame: `runningHooks.track(frame.events.sorted { $0.tsMs < $1.tsMs })`. After `/api/live` is applied: rebuild, `runningHooks = RunningHooks(); runningHooks.track(newLive.reversed())`. `updateTicker()` after every change to `panelOpen` or `runningHooks`: start a 250 ms loop that sets `clock = .now` and calls `prune(nowMs:)` while `panelOpen && !runningHooks.isEmpty`, cancel it otherwise. `stopPolling()` and `invalidateTelemetry()` cancel the ticker and reset `runningHooks` too.

- [ ] **Step 1: Write the failing checks**

Add these names to the `required` array, then the checks:

- "running hooks track start and complete and prune stale ones": a pure test on `RunningHooks` with a hook_start at t=0 and a matching hook at t=500 (removed), a second hook_start at t=0 with no completion, `prune(nowMs: 120_001)` empties it, `prune(nowMs: 60_000)` keeps it.
- "no ticker while the panel is closed or nothing is running": a model with the panel closed and a pushed hook_start gives `isTicking == false`; open the panel, `waitUntil isTicking`; push the matching hook completion, `waitUntil !isTicking`.

- [ ] **Step 2: Run the harness to see them fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL, the check names are required and do not exist yet.

- [ ] **Step 3: Implement**

Create `RunningHooks.swift` with the types above and wire the tracking, `clock` and `updateTicker()` into `Telemetry`. Call `updateTicker()` from `handleFrame` and from the `/api/live` merge.

- [ ] **Step 4: Run the harness to see them pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Sources/Models/RunningHooks.swift apps/menubar/Sources/Networking/Telemetry.swift \
  apps/menubar/Tests/TelemetryHostsTests.swift apps/menubar/test/hosts.test.ts
git commit -m "feat(menubar): track running hooks and tick while they run"
```

### Task 7: Panel views show connection state and running hooks

**Files:**
- Modify `apps/menubar/Sources/Views/Panel/LiveFeed.swift` (new parameters `running: [RunningHook]` and `now: Date`; one line per running hook above the rows: hook label, "running", elapsed via `fmtMs(now.timeIntervalSince1970 * 1000 - startedMs)`).
- Modify `apps/menubar/Sources/Views/Panel/SummaryView.swift` (new `let running: [RunningHook]`, `let now: Date`, passed into `LiveFeed`).
- Modify `apps/menubar/Sources/Views/Panel/PanelView.swift` (pass `model.runningHooks.entries` and `model.clock`).
- Modify `apps/menubar/Sources/Views/Panel/SkeletonView.swift` (its placeholder preview passes an empty array and `.now`).
- Modify `apps/menubar/Sources/Views/Panel/PanelHeader.swift` (after `stateText`, when `model.status != nil`, append `· Live`, `· Reconnecting` or `· Offline, polling` from `model.connectionState`).

**Interfaces:**
- Consumes: `RunningHook`, `Telemetry.connectionState`, `Telemetry.clock` from Tasks 4 and 6.
- Produces: no new symbols outside these view files.

- [ ] **Step 1: Write the failing check**

There is no new harness check. View rendering is checked manually per the spec's acceptance list. The compile step below is the failing signal first: the views do not build until the new parameters exist.

- [ ] **Step 2: Run it to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/panel-layout.test.ts
```

Expected: FAIL, the views do not compile against the new model symbols.

- [ ] **Step 3: Implement**

Add the parameters and the hook line as described, pass `model.runningHooks.entries` and `model.clock` from `PanelView`, and append the connection state to the header's state line.

- [ ] **Step 4: Run the checks to see them pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/panel-layout.test.ts
cd .claude/worktrees/live-updates && bun run --filter @cpa/menubar build
```

Expected: both pass.

- [ ] **Step 5: Check the built app by hand**

- [ ] Run a Claude Code turn with hooks. Rows appear within about a second and the running hook line counts up.
- [ ] Stop the collector. The header shows `Offline, polling`.
- [ ] Start the collector. The header returns to `Live`.

- [ ] **Step 6: Commit**

```sh
git add apps/menubar/Sources/Views/Panel/LiveFeed.swift apps/menubar/Sources/Views/Panel/SummaryView.swift \
  apps/menubar/Sources/Views/Panel/PanelView.swift apps/menubar/Sources/Views/Panel/SkeletonView.swift \
  apps/menubar/Sources/Views/Panel/PanelHeader.swift
git commit -m "feat(menubar): show connection state and running hooks in the panel"
```

### Task 8: Remove the poll interval settings

**Files:**
- Modify `apps/menubar/Sources/Settings/Prefs.swift` (delete `Defaults.statusPollIntervalSec` and `Defaults.panelPollIntervalSec`; keep the two `Key` strings but move them into `static let retired = [statusPollIntervalSec, panelPollIntervalSec]` with a comment that reset still clears values older builds stored, and keep them inside `allManaged` through that list; fix the `loadInterval` comment to say it now serves the retry delay).
- Modify `apps/menubar/Sources/Settings/ConnectionSettingsTab.swift` (if not already done in Task 4: delete the two steppers, rename `Section("Polling")` to `Section("Requests")`).
- Modify `docs/menu-bar-app.md` (line 23 becomes: "The panel updates live from the collector while it is open and refreshes every 30 s for values that change with time."; line 25: replace "tune polling intervals" with "set the request timeout and retry delay").
- Test: `apps/menubar/Tests/TelemetryHostsTests.swift` and `apps/menubar/test/hosts.test.ts`.

**Interfaces:**
- Consumes: `Telemetry.resetAllSettings()`, `Prefs.Key.allManaged`.
- Produces: `Prefs.Key.retired`, a list of retired keys that `allManaged` still includes so reset clears them.

- [ ] **Step 1: Write the failing check**

Add the name "removed poll interval keys are cleared by reset all" to the `required` array, then the check: write `defaults.set(2.0, forKey: "statusPollIntervalSec")` and `panelPollIntervalSec` into an isolated store, call `model.resetAllSettings()`, and both `defaults.object(forKey:)` are nil.

- [ ] **Step 2: Run the harness to see it fail**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: FAIL, the check does not exist yet.

- [ ] **Step 3: Implement**

Make the `Prefs.swift` and `docs/menu-bar-app.md` edits described in Files, and the `ConnectionSettingsTab.swift` edits if Task 4 did not already make them.

- [ ] **Step 4: Run the harness to see it pass**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/menubar/Sources/Settings/Prefs.swift apps/menubar/Sources/Settings/ConnectionSettingsTab.swift \
  docs/menu-bar-app.md apps/menubar/Tests/TelemetryHostsTests.swift apps/menubar/test/hosts.test.ts
git commit -m "refactor(menubar): drop the poll interval settings"
```

### Task 9: Whole-suite verification and existing-test repair

**Files:**
- No new files. Repair any old harness check that waited on a poll tick.

**Interfaces:**
- Consumes: everything from Tasks 1 to 8.
- Produces: a green suite, a built app, no new symbols.

- [ ] **Step 1: Run the old harness suites and see what breaks**

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
cd .claude/worktrees/live-updates && bun test apps/menubar/test/panel-layout.test.ts
```

The old checks assumed a 2 s poll (for example the "staged late ..." checks and "delayed failures from host A"). Expected: some of them FAIL.

- [ ] **Step 2: Repair each stale check**

For any old check that waited on a poll tick, rewrite it to trigger the refresh through `panelOpen`, a host switch or `refreshNow()` instead of waiting. Never loosen its assertions. Re-run the two suites above until they pass without a count that assumes polling:

```sh
cd .claude/worktrees/live-updates && bun test apps/menubar/test/hosts.test.ts
cd .claude/worktrees/live-updates && bun test apps/menubar/test/panel-layout.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full suite and typecheck once**

```sh
cd .claude/worktrees/live-updates && bun test
cd .claude/worktrees/live-updates && bun run typecheck
```

Expected: `0 fail`.

- [ ] **Step 4: Build the app**

```sh
cd .claude/worktrees/live-updates && bun run --filter @cpa/menubar build
```

Expected: build succeeds.

- [ ] **Step 5: Commit the repairs, only if tests needed changes**

```sh
git add apps/menubar/Tests/TelemetryHostsTests.swift apps/menubar/test/hosts.test.ts
git commit -m "test(menubar): adapt harness checks to push-driven refresh"
```
