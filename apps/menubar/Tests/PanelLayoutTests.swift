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
