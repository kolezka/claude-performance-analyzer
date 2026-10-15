import SwiftUI

// Lane-grouped waterfall: a time axis with nice round ticks and faint gridlines, rows
// grouped under collapsible lane headers (main thread / each subagent / background). A tool
// row draws its pre/post hook calls as thin segments right against its own bar instead of
// giving them separate rows. Falls back to the flat WaterfallView when a turn has no lanes.
struct LaneWaterfallView: View {
    let lanes: [TurnDetail.Lane]
    let rows: [TurnDetail.Row]
    let startMs: Double
    let endMs: Double
    var gaps: [TurnDetail.Gap] = []
    var onSelect: (Int) -> Void = { _ in }
    var rowHeight: CGFloat = 18
    var showAxis: Bool = true
    var showLegend: Bool = true
    var showLaneHeaders: Bool = true
    // The panel's compact section passes one lane id to show without a header, capped to
    // maxRows with "+N more" for the rest.
    var onlyLaneId: String? = nil
    var maxRows: Int? = nil

    @State private var collapsedLanes: Set<String> = []

    private let rowSpacing: CGFloat = 8
    private let rowGap: CGFloat = 3
    private let gapBreakWidth: CGFloat = 14
    private let laneHeaderHeight: CGFloat = 16

    private var sortedGaps: [TurnDetail.Gap] { gaps.sorted { $0.startMs < $1.startMs } }

    private var visibleLanes: [TurnDetail.Lane] {
        guard let onlyLaneId else { return lanes }
        return lanes.filter { $0.id == onlyLaneId }
    }

    private func rows(for lane: TurnDetail.Lane) -> [TurnDetail.Row] {
        let laneRows = rows.filter { $0.lane == lane.id }.sorted { $0.startMs < $1.startMs }
        guard onlyLaneId != nil, let maxRows else { return laneRows }
        return Array(laneRows.prefix(maxRows))
    }

    private var hiddenRowCount: Int {
        guard onlyLaneId != nil, let maxRows else { return 0 }
        let full = rows.filter { row in visibleLanes.contains { $0.id == row.lane } }.count
        return max(full - maxRows, 0)
    }

    private enum DisplayItem: Identifiable {
        case header(TurnDetail.Lane)
        case row(TurnDetail.Row, Int)

        var id: String {
            switch self {
            case .header(let lane): "header-\(lane.id)"
            case .row(let row, let idx): "row-\(row.lane)-\(idx)"
            }
        }
    }

    private var displayItems: [DisplayItem] {
        var items: [DisplayItem] = []
        for lane in visibleLanes {
            if showLaneHeaders { items.append(.header(lane)) }
            guard !collapsedLanes.contains(lane.id) else { continue }
            for (idx, row) in rows(for: lane).enumerated() { items.append(.row(row, idx)) }
        }
        return items
    }

    // Matches exactly what laneList renders below: same items, same rowGap spacing, so the
    // gridlines and gap markers always span the real chart height with no measurement pass.
    private var chartHeight: CGFloat {
        let items = displayItems
        guard !items.isEmpty else { return rowHeight }
        let total = items.reduce(CGFloat(0)) { sum, item in
            switch item {
            case .header: sum + laneHeaderHeight
            case .row: sum + rowHeight
            }
        }
        return total + CGFloat(items.count - 1) * rowGap
    }

    var body: some View {
        GeometryReader { outer in
            // Wider than the flat view's fixed 110pt: real labels like "mcp: outline/update_document"
            // need the room, but a narrow panel shouldn't lose its whole track to the label.
            let labelWidth = min(max(outer.size.width * 0.32, 170), 260)
            // Idle gaps are compressed to a fixed width each; everything else maps linearly
            // over whatever is left. Gap width shrinks (floor ~4pt) when the track is too
            // narrow to fit every gap at full size, instead of letting bars overflow it.
            let trackWidth = max(outer.size.width - labelWidth - rowSpacing, 1)
            let gapCount = sortedGaps.count
            let minGapWidth: CGFloat = 4
            let gapWidth: CGFloat = gapCount == 0
                ? gapBreakWidth
                : max(min(gapBreakWidth, trackWidth * 0.9 / CGFloat(gapCount)), minGapWidth)
            let activePixelWidth = max(trackWidth - gapWidth * CGFloat(gapCount), 0)
            let timeline = GapTimeline(gaps: sortedGaps, startMs: startMs, endMs: endMs, gapPixelWidth: gapWidth, activePixelWidth: activePixelWidth)
            let ticks = axisTicks(timeline: timeline)

            VStack(alignment: .leading, spacing: 4) {
                if showAxis {
                    axisRow(ticks: ticks, labelWidth: labelWidth)
                }
                ZStack(alignment: .topLeading) {
                    gridlines(ticks: ticks, labelWidth: labelWidth)
                    laneList(timeline: timeline, labelWidth: labelWidth)
                    ForEach(Array(sortedGaps.enumerated()), id: \.offset) { _, gap in
                        gapMarker(gap, timeline: timeline, gapWidth: gapWidth, labelWidth: labelWidth)
                    }
                }
                .frame(height: chartHeight)
                if hiddenRowCount > 0 {
                    Text("+\(hiddenRowCount) more").font(.caption2).foregroundStyle(.tertiary)
                }
                if showLegend {
                    legend
                }
            }
        }
        .frame(height: totalHeight)
    }

    private var totalHeight: CGFloat {
        var height = chartHeight
        if showAxis { height += 14 + 4 }
        if hiddenRowCount > 0 { height += 14 }
        if showLegend { height += 18 }
        return height
    }

    private func axisRow(ticks: [AxisTick], labelWidth: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(ticks.enumerated()), id: \.offset) { _, tick in
                Text(tick.label)
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
                    .fixedSize()
                    .offset(x: labelWidth + rowSpacing + tick.x)
            }
        }
        .frame(height: 10, alignment: .topLeading)
    }

    private func gridlines(ticks: [AxisTick], labelWidth: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(ticks.enumerated()), id: \.offset) { _, tick in
                Rectangle()
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 1, height: chartHeight, alignment: .leading)
                    .offset(x: labelWidth + rowSpacing + tick.x)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func laneList(timeline: GapTimeline, labelWidth: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: rowGap) {
            ForEach(displayItems) { item in
                switch item {
                case .header(let lane):
                    laneHeader(lane)
                case .row(let row, _):
                    rowView(row, timeline: timeline, labelWidth: labelWidth)
                }
            }
        }
    }

    private func laneHeader(_ lane: TurnDetail.Lane) -> some View {
        let collapsed = collapsedLanes.contains(lane.id)
        return Button {
            withAnimation(panelAnimation()) {
                if collapsed { collapsedLanes.remove(lane.id) } else { collapsedLanes.insert(lane.id) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(laneTitle(lane)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .frame(height: laneHeaderHeight, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    // The collector already sends subagent titles pre-formatted ("Subagent · route-sonnet"),
    // so this only ever adds the model, never re-adds the "Subagent" prefix.
    private func laneTitle(_ lane: TurnDetail.Lane) -> String {
        switch lane.kind {
        case "main": "Main thread"
        case "background": "Background"
        case "subagent":
            if let model = lane.model, !model.isEmpty { "\(lane.title) · \(model)" } else { lane.title }
        default: lane.title
        }
    }

    private func rowView(_ row: TurnDetail.Row, timeline: GapTimeline, labelWidth: CGFloat) -> some View {
        HStack(spacing: rowSpacing) {
            labelCell(row).frame(width: labelWidth, alignment: .leading)

            ZStack(alignment: .leading) {
                if row.kind == "tool", let pre = row.pre {
                    segment(start: pre.startMs, end: pre.endMs, color: .orange, timeline: timeline, id: pre.id)
                }
                segment(start: row.startMs, end: row.endMs, color: WaterfallView.color(for: row.kind), timeline: timeline, id: row.id, ok: row.ok)
                if row.kind == "tool", let post = row.post {
                    segment(start: post.startMs, end: post.endMs, color: .orange, timeline: timeline, id: post.id)
                }
            }
            // Leading, or the ZStack's own narrow intrinsic size gets centered in this wider
            // frame before each bar's offset is applied (same trap as the flat WaterfallView).
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: rowHeight)
        }
        .frame(height: rowHeight)
        .help(tooltip(row))
    }

    // Label and duration are separate Text views, not one concatenated string: a single Text
    // truncates as a whole, which chewed into the duration ("5...s +500ms hooks"). fixedSize()
    // keeps the duration (and the tool-only hooks suffix) at their natural width always, so
    // only the label itself ever shrinks or truncates.
    private func labelCell(_ row: TurnDetail.Row) -> some View {
        HStack(spacing: 4) {
            if !row.ok {
                Image(systemName: "xmark.octagon").foregroundStyle(.red)
            }
            Text(row.label).lineLimit(1).truncationMode(.middle)
            Text(fmtMs(row.endMs - row.startMs)).foregroundStyle(.secondary).fixedSize()
            // hookMs on a "hooks" row is its own duration restated; the suffix only adds
            // information on a tool row, where it's the pre/post hook overhead around it.
            if row.kind == "tool", row.hookMs > 0 {
                Text("+\(fmtMs(row.hookMs)) hooks").foregroundStyle(.secondary).fixedSize()
            }
        }
        .font(.caption)
    }

    private func segment(start: Double, end: Double, color: Color, timeline: GapTimeline, id: Int?, ok: Bool = true) -> some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(color)
            .opacity(ok ? 0.85 : 1)
            .overlay(alignment: .leading) {
                if !ok {
                    RoundedRectangle(cornerRadius: 2).strokeBorder(.red, lineWidth: 1)
                }
            }
            .frame(width: max(timeline.x(end) - timeline.x(start), 2), height: rowHeight, alignment: .leading)
            .offset(x: timeline.x(start))
            .contentShape(.rect)
            .onTapGesture { if let id { onSelect(id) } }
    }

    private func tooltip(_ row: TurnDetail.Row) -> String {
        let offset = fmtMs(row.startMs - startMs)
        let duration = fmtMs(row.endMs - row.startMs)
        return "\(row.detail ?? row.label)\nstart +\(offset) · \(duration)"
    }

    // A dashed break at the gap's compressed position, spanning the chart height, with its
    // duration rotated to fit the narrow column. The label is an overlay so its unrotated
    // width doesn't widen the frame and shift the line off the gap.
    private func gapMarker(_ gap: TurnDetail.Gap, timeline: GapTimeline, gapWidth: CGFloat, labelWidth: CGFloat) -> some View {
        let x = labelWidth + rowSpacing + timeline.x(gap.startMs) + gapWidth / 2
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

    private var legend: some View {
        HStack(spacing: 12) {
            Swatch(color: WaterfallView.color(for: "api"), text: "API")
            Swatch(color: WaterfallView.color(for: "tool"), text: "Tool")
            Swatch(color: WaterfallView.color(for: "hooks"), text: "Hooks")
            Swatch(color: WaterfallView.color(for: "agent"), text: "Agent")
        }
    }
}
