import AppKit
import SwiftUI

// Executable layout harness for the panel header. test/panel-layout.test.ts compiles it with the
// app's real Sources (minus the App entry point), so it renders the production PanelHeader in an
// offscreen NSHostingView and checks the sizes SwiftUI and AppKit actually produce.

// PanelView pads its content by 14 on each side inside a frame of the panel width.
let panelPadding: CGFloat = 14
let panelWidths = [360, 420, 480] // the choices in Settings > Panel, 360 being the default and minimum

// Records what its single child wants when offered exactly the width the panel has.
final class FitProbe {
    var proposed: CGFloat = 0
    var fitted: CGSize = .zero
}

struct MeasureLayout: Layout {
    let probe: FitProbe

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        let fitted = subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: nil)) ?? .zero
        probe.proposed = width
        probe.fitted = fitted
        return CGSize(width: width, height: fitted.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}

struct Rendered {
    let available: CGFloat
    let fitted: CGSize
    // Frames of the segmented controls SwiftUI created, in the hosting view's coordinates.
    // The menu picker is drawn by SwiftUI itself and has no public AppKit view to find.
    let segmented: [CGRect]
}

@MainActor
func render<V: View>(_ view: V, available: CGFloat) -> Rendered {
    let probe = FitProbe()
    let host = NSHostingView(rootView: MeasureLayout(probe: probe) { view }.frame(width: available, alignment: .leading))
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: available, height: 300),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = host
    host.frame = NSRect(x: 0, y: 0, width: available, height: 300)
    host.layoutSubtreeIfNeeded()
    window.displayIfNeeded()

    var segmented: [CGRect] = []
    func walk(_ v: NSView) {
        if let s = v as? NSSegmentedControl { segmented.append(s.convert(s.bounds, to: host)) }
        v.subviews.forEach(walk)
    }
    walk(host)
    window.contentView = nil
    return Rendered(available: available, fitted: probe.fitted, segmented: segmented)
}

func describe(_ r: Rendered) -> String {
    let segs = r.segmented.map { "segmented x=\(Int($0.minX))..\(Int($0.maxX))" }
    return "available=\(Int(r.available)) fitted=\(Int(r.fitted.width.rounded(.up)))x\(Int(r.fitted.height)) "
        + segs.joined(separator: " ")
}

final class Harness {
    var passed = 0
    var failed = 0
    var currentFailed = false

    func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) {
        if !condition {
            currentFailed = true
            print("  assertion failed (line \(line)): \(message())")
        }
    }

    @MainActor
    func run(_ name: String, _ body: () -> Void) {
        currentFailed = false
        body()
        if currentFailed {
            failed += 1
            print("FAIL \(name)")
        } else {
            passed += 1
            print("PASS \(name)")
        }
    }
}

// The header fits when SwiftUI asks for no more than the panel offers, the window picker lies
// inside the panel's content edges, and no text wrapped. Three single-line rows are about 92pt;
// a title squeezed into wrapping one letter per line is well past 100.
@MainActor
func checkFits(_ h: Harness, _ r: Rendered, _ label: String) {
    print("  \(label): \(describe(r))")
    h.check(r.fitted.width <= r.available + 0.5, "\(label): header wants \(r.fitted.width) of \(r.available)")
    h.check(r.fitted.height <= 100, "\(label): header is \(r.fitted.height) tall, so text wrapped")
    for frame in r.segmented {
        h.check(frame.minX >= -0.5 && frame.maxX <= r.available + 0.5, "\(label): control at \(frame) is outside 0..\(r.available)")
    }
}

let prefsDirectory: String = {
    let dir = ProcessInfo.processInfo.environment["CPA_TEST_PREFS_DIR"]
        ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("cpa-menubar-layout-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}()

// A model on an isolated preferences suite that never polls, holding the given hosts.
@MainActor
func makeModel(hosts: [(String, String)], selected: String) -> (Telemetry, () -> Void) {
    let name = (prefsDirectory as NSString).appendingPathComponent("cpa.menubar.layout.\(UUID().uuidString)")
    let defaults = UserDefaults(suiteName: name)!
    defaults.set(selected, forKey: Prefs.Key.selectedHostId)
    let model = Telemetry(defaults: defaults, startPolling: false)
    model.hosts = hosts.map { TelemetryHost(id: $0.0, name: $0.1, createdMs: nil, lastSeenMs: nil) }
    return (model, { model.stopPolling(); defaults.removePersistentDomain(forName: name) })
}

let local: (String, String) = (TelemetryHost.localId, TelemetryHost.localName)
let allWindows = Prefs.WindowOption.allCases
let defaultWindows = Prefs.parseEnabledWindows(Prefs.Defaults.enabledWindowsRaw)
let longHostName: String = String(String(repeating: "very-long-remote-host-name-", count: 3).prefix(80))

@MainActor
func scrollViews(in view: NSView) -> [NSScrollView] {
    (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { scrollViews(in: $0) }
}

@MainActor
func settle(_ host: NSView, window: NSWindow, seconds: Double) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }
}

@main
struct PanelLayoutTests {
    @MainActor
    static func main() {
        _ = NSApplication.shared
        let h = Harness()

        h.run("probe reports a fixed-size child wider than the panel") {
            let r = render(Text(String(repeating: "W", count: 80)).fixedSize(), available: 332)
            print("  control: \(describe(r))")
            h.check(r.fitted.width > r.available + 50, "probe missed an overflowing child: \(describe(r))")
        }

        h.run("scroll probe detects genuine overflow") {
            let host = NSHostingView(rootView: ScrollView { Color.red.frame(width: 200, height: 300) }.frame(width: 200, height: 100))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: 200, height: 100)
            settle(host, window: window, seconds: 0.2)
            if let scroll = scrollViews(in: host).first, let document = scroll.documentView {
                scroll.scrollerStyle = .overlay
                let overflow = document.frame.height - scroll.contentView.bounds.height
                print("  overflow control: \(overflow)")
                h.check(overflow > 100, "probe failed to detect genuine overflow: \(overflow)")
                h.check(scroll.hasVerticalScroller && scroll.verticalScroller?.isHidden == false,
                        "probe did not detect an enabled scroller")
            } else {
                h.check(false, "overflow control did not render an NSScrollView and document")
            }
            window.contentView = nil
        }

        h.run("panel refresh does not enable a scrollbar when content fits") {
            let name = (prefsDirectory as NSString).appendingPathComponent("cpa.panel.scroll.\(UUID().uuidString)")
            let defaults = UserDefaults(suiteName: name)!
            for key in [Prefs.Key.showKpis, Prefs.Key.showLatencyChart, Prefs.Key.showBreakdown,
                        Prefs.Key.showSlowest, Prefs.Key.showTotalTime, Prefs.Key.showWaterfall] {
                defaults.set(false, forKey: key)
            }
            defaults.set(true, forKey: Prefs.Key.showLiveFeed)
            defaults.set(15, forKey: Prefs.Key.liveFeedLength)
            let model = Telemetry(defaults: defaults, startPolling: false)
            model.status = Status(label: "OK", state: "ok", values: nil)
            model.summary = Summary(
                eventCount: 12,
                kpis: Summary.Kpis(sessions: 1, apiP50: 1, apiP95: 2, ttftP50: nil, turnP50: 3, costUsd: 0, cacheHitRatio: 0),
                breakdown: Summary.Breakdown(api: 1, tools: 1, hooks: 1),
                apiSeries: Summary.Series(points: []), hooks: [], tools: [], subagents: []
            )
            model.live = (0..<12).map { i in
                LiveEvent(tsMs: Double(i) * 1000, kind: "tool", label: "Event \(i)", ms: nil, ok: true, sessionId: nil, id: nil)
            }
            let root = PanelView(model: model, screenHeightOverride: 800).defaultAppStorage(defaults)
            let host = NSHostingView(rootView: root)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: 360, height: 900)
            settle(host, window: window, seconds: 0.5)
            guard let scroll = scrollViews(in: host).first, let document = scroll.documentView else {
                h.check(false, "production panel did not render an NSScrollView and document")
                window.contentView = nil
                model.stopPolling()
                defaults.removePersistentDomain(forName: name)
                return
            }
            scroll.scrollerStyle = .overlay
            let initialOverflow = document.frame.height - scroll.contentView.bounds.height
            h.check(initialOverflow <= 0.5, "fixture must initially fit, overflow \(initialOverflow)")
            let initialHeight = document.frame.height
            withAnimation(.smooth(duration: 0.35)) { model.live = Array(model.live.prefix(5)) }
            var peakOverflow: CGFloat = 0
            var enabledSamples = 0
            for _ in 0..<35 {
                settle(host, window: window, seconds: 0.02)
                peakOverflow = max(peakOverflow, document.frame.height - scroll.contentView.bounds.height)
                if scroll.hasVerticalScroller && scroll.verticalScroller?.isHidden == false { enabledSamples += 1 }
            }
            print("  panel: initialHeight=\(initialHeight) finalHeight=\(document.frame.height) peakOverflow=\(peakOverflow) enabledSamples=\(enabledSamples)")
            h.check(document.frame.height < initialHeight - 10, "fixture did not shrink the panel content")
            h.check(enabledSamples == 0, "fitting panel enabled a scrollbar in \(enabledSamples) samples")
            window.contentView = nil
            model.stopPolling()
            defaults.removePersistentDomain(forName: name)
        }

        h.run("overflowing panel remains scrollable across refresh") {
            let name = (prefsDirectory as NSString).appendingPathComponent("cpa.panel.overflow.\(UUID().uuidString)")
            let defaults = UserDefaults(suiteName: name)!
            for key in [Prefs.Key.showKpis, Prefs.Key.showLatencyChart, Prefs.Key.showBreakdown,
                        Prefs.Key.showSlowest, Prefs.Key.showTotalTime, Prefs.Key.showWaterfall, Prefs.Key.showLiveFeed] {
                defaults.set(true, forKey: key)
            }
            defaults.set(15, forKey: Prefs.Key.liveFeedLength)
            defaults.set(8, forKey: Prefs.Key.rowsPerList)
            let model = Telemetry(defaults: defaults, startPolling: false)
            model.status = Status(label: "OK", state: "ok", values: nil)
            let stats = (0..<8).map { Stats(name: "Task \($0)", totalMs: Double($0 + 1), p95: Double($0 + 1)) }
            model.summary = Summary(
                eventCount: 15,
                kpis: Summary.Kpis(sessions: 1, apiP50: 1, apiP95: 2, ttftP50: nil, turnP50: 3, costUsd: 0, cacheHitRatio: 0),
                breakdown: Summary.Breakdown(api: 1, tools: 1, hooks: 1),
                apiSeries: Summary.Series(points: []), hooks: stats, tools: stats, subagents: stats
            )
            model.live = (0..<15).map { i in
                LiveEvent(tsMs: Double(i) * 1000, kind: "tool", label: "Event \(i)", ms: nil, ok: true, sessionId: nil, id: nil)
            }
            let host = NSHostingView(rootView: PanelView(model: model, screenHeightOverride: 400).defaultAppStorage(defaults))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 1200), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: 360, height: 1200)
            settle(host, window: window, seconds: 0.5)
            guard let scroll = scrollViews(in: host).first, let document = scroll.documentView else {
                h.check(false, "overflowing panel did not render an NSScrollView and document")
                window.contentView = nil
                model.stopPolling()
                defaults.removePersistentDomain(forName: name)
                return
            }
            scroll.scrollerStyle = .overlay
            let overflow = document.frame.height - scroll.contentView.bounds.height
            print("  overflowing panel: document=\(document.frame.height) clip=\(scroll.contentView.bounds.height) overflow=\(overflow)")
            h.check(overflow > 20, "fixture must exceed the panel cap, overflow \(overflow)")
            h.check(scroll.contentView.bounds.height < 400, "panel ignored its 400-point screen height")
            h.check(scroll.hasVerticalScroller, "overflowing panel must enable its vertical scroller")
            scroll.contentView.scroll(to: NSPoint(x: 0, y: 20))
            scroll.reflectScrolledClipView(scroll.contentView)
            let before = scroll.contentView.bounds.origin.y
            h.check(before > 10, "fixture could not scroll, offset \(before)")
            withAnimation(.smooth(duration: 0.35)) { model.live = Array(model.live.reversed()) }
            settle(host, window: window, seconds: 0.7)
            let after = scroll.contentView.bounds.origin.y
            h.check(scroll.hasVerticalScroller, "refresh disabled the overflowing panel scroller")
            h.check(abs(before - after) <= 2, "refresh moved scroll position from \(before) to \(after)")
            window.contentView = nil
            model.stopPolling()
            defaults.removePersistentDomain(forName: name)
        }

        h.run("long host name has 80 characters") {
            h.check(longHostName.count == 80, "length \(longHostName.count)")
        }

        h.run("local-only header fits every panel width with every window enabled") {
            for width in panelWidths {
                for (label, windows) in [("default", defaultWindows), ("all", allWindows)] {
                    let (model, cleanup) = makeModel(hosts: [local], selected: TelemetryHost.localId)
                    let r = render(PanelHeader(model: model, windows: windows), available: CGFloat(width) - 2 * panelPadding)
                    checkFits(h, r, "local \(width) \(label) windows")
                    h.check(r.segmented.count == 1, "window picker not rendered: \(describe(r))")
                    cleanup()
                }
            }
        }

        h.run("remote host header fits every panel width with every window enabled") {
            for width in panelWidths {
                for (label, windows) in [("default", defaultWindows), ("all", allWindows)] {
                    for name: String in ["Preview Linux (demo)", longHostName] {
                        let available = CGFloat(width) - 2 * panelPadding
                        let (model, cleanup) = makeModel(hosts: [local, ("r1", name)], selected: "r1")
                        let r = render(PanelHeader(model: model, windows: windows), available: available)
                        checkFits(h, r, "remote \(width) \(label) windows \(name.count) chars")
                        h.check(r.segmented.count == 1, "window picker not rendered: \(describe(r))")
                        // The host picker adds a row of its own, so the header grows past the local one.
                        let (localModel, localCleanup) = makeModel(hosts: [local], selected: TelemetryHost.localId)
                        let l = render(PanelHeader(model: localModel, windows: windows), available: available)
                        h.check(r.fitted.height >= l.fitted.height + 20, "no host row: remote \(r.fitted.height) vs local \(l.fitted.height)")
                        cleanup()
                        localCleanup()
                    }
                }
            }
        }

        print("\(h.passed) passed, \(h.failed) failed")
        exit(h.failed == 0 ? 0 : 1)
    }
}
