import SwiftUI

// Same layout as the loaded panel with placeholder bars, so the panel does not jump when data lands.
struct SkeletonView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        SummaryView(summary: .placeholder, live: LiveEvent.placeholders)
            .redacted(reason: .placeholder)
            .allowsHitTesting(false)
            .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.45]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in .easeInOut(duration: 0.8) }
            .accessibilityLabel("Loading summary")
    }
}

extension Summary {
    static let placeholder: Summary = {
        let rows = (1...3).map { Stats(name: "placeholder row \($0)", totalMs: 1, p95: 1) }
        let now = Date.now.timeIntervalSince1970 * 1000
        return Summary(
            eventCount: 1,
            kpis: Kpis(sessions: 0, apiP50: 0, apiP95: 0, ttftP50: 0, turnP50: 0, costUsd: 0, cacheHitRatio: 0),
            breakdown: Breakdown(api: 1, tools: 1, hooks: 1),
            // One bucket with no requests draws the "no requests" line, which redacts to a bar.
            apiSeries: Series(points: [Point(t: now, p50: nil, p95: nil, count: 0)]),
            hooks: rows,
            tools: rows,
            subagents: rows
        )
    }()
}

extension LiveEvent {
    static let placeholders = (0..<6).map { LiveEvent(tsMs: Double($0), kind: "", label: "placeholder event", ms: 1, ok: true, sessionId: nil, id: nil) }
}
