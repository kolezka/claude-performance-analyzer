import SwiftUI

// Maps an absolute ms timestamp to an x offset on the compressed axis: active time scales
// linearly over activePixelWidth, each gap counts as a fixed gapPixelWidth regardless of its
// real duration. Spans never overlap a gap by construction, so the mid-gap clamp only matters
// for a marker drawn exactly at a gap's own boundary. Shared by WaterfallView (flat fallback)
// and LaneWaterfallView (lane-grouped), plus the axis tick labels on the latter.
struct GapTimeline {
    let gaps: [TurnDetail.Gap]
    let startMs: Double
    let endMs: Double
    let gapPixelWidth: CGFloat
    let activePixelWidth: CGFloat

    var activeDurationMs: Double {
        let gapTotal = gaps.reduce(0.0) { $0 + ($1.endMs - $1.startMs) }
        return max(endMs - startMs - gapTotal, 0)
    }

    func x(_ ms: Double) -> CGFloat {
        var elapsedActive = 0.0
        var gapsPassed = 0
        var cursor = startMs
        for gap in gaps {
            if ms <= gap.startMs {
                elapsedActive += max(ms - cursor, 0)
                return fraction(elapsedActive) * activePixelWidth + CGFloat(gapsPassed) * gapPixelWidth
            }
            elapsedActive += max(gap.startMs - cursor, 0)
            gapsPassed += 1
            cursor = gap.endMs
            if ms < gap.endMs {
                return fraction(elapsedActive) * activePixelWidth + CGFloat(gapsPassed - 1) * gapPixelWidth
            }
        }
        elapsedActive += max(ms - cursor, 0)
        return fraction(elapsedActive) * activePixelWidth + CGFloat(gapsPassed) * gapPixelWidth
    }

    // Inverse of the active-time mapping: the absolute timestamp after `target` ms of active
    // (non-gap) time have elapsed since startMs. Used to place axis ticks at nice round active
    // durations without the ticks drifting into a compressed gap.
    func timestamp(forActiveElapsed target: Double) -> Double {
        var elapsedActive = 0.0
        var cursor = startMs
        for gap in gaps {
            let segment = gap.startMs - cursor
            if elapsedActive + segment >= target {
                return cursor + (target - elapsedActive)
            }
            elapsedActive += segment
            cursor = gap.endMs
        }
        let remaining = endMs - cursor
        if elapsedActive + remaining >= target {
            return cursor + (target - elapsedActive)
        }
        return endMs
    }

    private func fraction(_ elapsed: Double) -> CGFloat {
        let duration = activeDurationMs
        guard duration > 0 else { return 0 }
        return CGFloat(elapsed / duration)
    }
}

// A tick on the shared time axis: nice round steps (1s, 2s, 5s, 10s, 30s, 1m, ...) over the
// active duration, aiming for 4 to 6 ticks regardless of how long the turn ran.
struct AxisTick {
    let x: CGFloat
    let label: String
}

func axisTicks(timeline: GapTimeline) -> [AxisTick] {
    let niceSteps: [Double] = [
        1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
        1_800_000, 3_600_000, 7_200_000, 18_000_000, 36_000_000,
    ]
    let duration = timeline.activeDurationMs
    guard duration > 0 else { return [AxisTick(x: 0, label: "0s")] }
    let step = niceSteps.first { duration / $0 <= 6 } ?? niceSteps.last!
    var ticks: [AxisTick] = []
    var elapsed = 0.0
    while elapsed <= duration + 1 {
        let ts = timeline.timestamp(forActiveElapsed: elapsed)
        ticks.append(AxisTick(x: timeline.x(ts), label: axisTickLabel(elapsed)))
        elapsed += step
    }
    return ticks
}

// Exact, never rounded: a 30s step lands ticks on 1m30s, 2m30s, and so on. Rounding those to
// the nearest whole minute ("1m30s" -> "2m") is what produced two ticks both reading "2m".
private func axisTickLabel(_ ms: Double) -> String {
    let totalSeconds = Int((ms / 1_000).rounded())
    if totalSeconds < 60 { return "\(totalSeconds)s" }
    let totalMinutes = totalSeconds / 60
    let seconds = totalSeconds % 60
    if totalMinutes < 60 {
        return seconds == 0 ? "\(totalMinutes)m" : "\(totalMinutes)m\(seconds)s"
    }
    let hours = totalMinutes / 60
    let minutes = totalMinutes % 60
    return minutes == 0 ? "\(hours)h" : "\(hours)h\(minutes)m"
}
