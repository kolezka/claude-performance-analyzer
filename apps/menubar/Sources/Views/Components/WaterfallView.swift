import SwiftUI

// Horizontal bars on a shared time axis, one row per span. Used by the Turn detail view
// (full span list) and the panel's compact Turn section (capped and shown live).
struct WaterfallView: View {
    let spans: [TurnDetail.Span]
    let startMs: Double
    let endMs: Double
    var gaps: [TurnDetail.Gap] = []
    var onSelect: (Int) -> Void = { _ in }
    var rowHeight: CGFloat = 16

    private let labelWidth: CGFloat = 110
    private let durationWidth: CGFloat = 42
    private let rowSpacing: CGFloat = 6
    private let rowGap: CGFloat = 3
    private let gapBreakWidth: CGFloat = 14

    private var sortedGaps: [TurnDetail.Gap] { gaps.sorted { $0.startMs < $1.startMs } }

    private var chartHeight: CGFloat {
        guard !spans.isEmpty else { return rowHeight }
        return CGFloat(spans.count) * rowHeight + CGFloat(spans.count - 1) * rowGap
    }

    var body: some View {
        GeometryReader { outer in
            // Idle gaps are compressed to a fixed width each; everything else maps linearly
            // over whatever is left, so one 6-hour wait doesn't stretch every other span to a
            // sliver. Gap width is reserved first, and shrinks (floor ~4pt) when the track is
            // too narrow to fit every gap at full size, instead of letting bars overflow it.
            let barWidth = max(outer.size.width - labelWidth - durationWidth - 2 * rowSpacing, 1)
            let gapCount = sortedGaps.count
            let minGapWidth: CGFloat = 4
            let gapWidth: CGFloat = gapCount == 0
                ? gapBreakWidth
                : max(min(gapBreakWidth, barWidth * 0.9 / CGFloat(gapCount)), minGapWidth)
            let activePixelWidth = max(barWidth - gapWidth * CGFloat(gapCount), 0)
            let timeline = GapTimeline(gaps: sortedGaps, startMs: startMs, endMs: endMs, gapPixelWidth: gapWidth, activePixelWidth: activePixelWidth)
            ZStack(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: rowGap) {
                    ForEach(Array(spans.enumerated()), id: \.offset) { _, span in
                        row(span, timeline: timeline, barWidth: barWidth)
                    }
                }
                ForEach(Array(sortedGaps.enumerated()), id: \.offset) { _, gap in
                    gapMarker(gap, timeline: timeline, gapWidth: gapWidth)
                }
            }
        }
        .frame(height: chartHeight)
    }

    private func row(_ span: TurnDetail.Span, timeline: GapTimeline, barWidth: CGFloat) -> some View {
        HStack(spacing: rowSpacing) {
            HStack(spacing: 3) {
                if !span.ok {
                    Image(systemName: "xmark.octagon.fill").font(.caption2).foregroundStyle(.red)
                }
                Text(span.label).lineLimit(1).truncationMode(.middle)
            }
            .font(.caption)
            .frame(width: labelWidth, alignment: .leading)

            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(Self.color(for: span.kind))
                    .opacity(span.ok ? 0.8 : 1)
                    .overlay(alignment: .leading) {
                        if !span.ok {
                            RoundedRectangle(cornerRadius: 3).strokeBorder(.red, lineWidth: 1)
                        }
                    }
                    .frame(width: max(timeline.x(span.endMs) - timeline.x(span.startMs), 2))
                    .offset(x: timeline.x(span.startMs))
            }
            // Leading, or the bar's own narrow frame gets centered in the track before the offset.
            .frame(width: barWidth, height: rowHeight, alignment: .leading)

            Text(fmtMs(span.endMs - span.startMs))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .frame(width: durationWidth, alignment: .trailing)
        }
        .frame(height: rowHeight)
        .contentShape(.rect)
        .onTapGesture { if let id = span.id { onSelect(id) } }
        .help(span.detail ?? span.label)
    }

    // A dashed break at the gap's compressed position, spanning the full chart height, with
    // its duration rotated to fit the narrow column.
    private func gapMarker(_ gap: TurnDetail.Gap, timeline: GapTimeline, gapWidth: CGFloat) -> some View {
        let x = labelWidth + rowSpacing + timeline.x(gap.startMs) + gapWidth / 2
        // The label is an overlay: its unrotated width would otherwise widen the frame and
        // shift the line off the gap.
        return Path { path in
            path.move(to: CGPoint(x: gapWidth / 2, y: 0))
            path.addLine(to: CGPoint(x: gapWidth / 2, y: chartHeight))
        }
        .stroke(Color.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
        .frame(width: gapWidth, height: chartHeight)
        .overlay {
            Text("idle \(fmtMs(gap.endMs - gap.startMs))")
                .font(.system(size: 8))
                .foregroundStyle(.secondary)
                .fixedSize()
                .rotationEffect(.degrees(-90))
        }
        .position(x: x, y: chartHeight / 2)
        .help("Idle for \(fmtMs(gap.endMs - gap.startMs))")
    }

    // Reuses the Breakdown section's API/Tools/Hooks colors; agent and compaction are new here.
    // "hook" (old flat Span.kind) and "hooks" (new lane Row.kind) are the same color.
    static func color(for kind: String) -> Color {
        switch kind {
        case "api": .blue
        case "tool": .purple
        case "hook", "hooks": .orange
        case "agent": .green
        case "compaction": .gray
        default: .secondary
        }
    }
}
