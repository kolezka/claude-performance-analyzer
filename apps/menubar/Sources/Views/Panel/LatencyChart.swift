import Charts
import SwiftUI

// One plotted value. `segment` changes at every empty bucket so the line breaks there,
// like the dashboard's connectNulls: false.
struct LatencySample: Identifiable {
    // Keyed by series and bucket time so a refresh morphs each point instead of reshuffling them.
    var id: String { "\(series)-\(time.timeIntervalSince1970)" }
    let time: Date
    let ms: Double
    let series: String
    let segment: String

    static func from(_ points: [Summary.Point]) -> [LatencySample] {
        var samples: [LatencySample] = []
        for (series, value) in [("p50", \Summary.Point.p50), ("p95", \Summary.Point.p95)] {
            var segment = 0
            var inGap = false
            for p in points {
                guard let ms = p[keyPath: value] else {
                    if !inGap { segment += 1 }
                    inGap = true
                    continue
                }
                inGap = false
                samples.append(LatencySample(time: date(p.t), ms: ms, series: series, segment: "\(series)-\(segment)"))
            }
        }
        return samples
    }
}

struct LatencyChart: View {
    let points: [Summary.Point]
    @State private var hoverTime: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionTitle("API latency")
                Spacer()
                Swatch(color: .blue, text: "p50")
                Swatch(color: .blue.opacity(0.35), text: "p95")
            }
            if points.contains(where: { $0.count > 0 }) {
                chart
            } else {
                Text("No API requests in this window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90)
            }
        }
    }

    // The bucket with requests nearest the pointer, so the callout never shows an empty gap.
    private var hovered: Summary.Point? {
        guard let hoverTime else { return nil }
        let ms = hoverTime.timeIntervalSince1970 * 1000
        return points.filter { $0.count > 0 }.min { abs($0.t - ms) < abs($1.t - ms) }
    }

    private var chart: some View {
        Chart {
            ForEach(LatencySample.from(points)) { s in
                LineMark(x: .value("Time", s.time), y: .value("Latency", s.ms), series: .value("Segment", s.segment))
                    .foregroundStyle(by: .value("Series", s.series))
                    .lineStyle(s.series == "p95" ? StrokeStyle(lineWidth: 2, dash: [4, 3]) : StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.monotone)
                // Points keep a lone bucket visible, since a one-point line draws nothing.
                PointMark(x: .value("Time", s.time), y: .value("Latency", s.ms))
                    .foregroundStyle(by: .value("Series", s.series))
                    .symbolSize(10)
            }
            if let p = hovered {
                RuleMark(x: .value("Time", date(p.t)))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        HoverCallout(point: p)
                    }
            }
        }
        .chartXSelection(value: $hoverTime)
        // Span the whole window, not just the buckets that have requests.
        .chartXScale(domain: date(points.first?.t ?? 0)...date(points.last?.t ?? 0))
        .chartYScale(domain: .automatic(includesZero: true))
        .chartForegroundStyleScale(["p50": Color.blue, "p95": Color.blue.opacity(0.35)])
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { v in
                AxisGridLine()
                AxisValueLabel { if let ms = v.as(Double.self) { Text(fmtMs(ms)) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel(format: .dateTime.hour().minute(), collisionResolution: .greedy(minimumSpacing: 6))
            }
        }
        .frame(height: 90)
    }
}

struct HoverCallout: View {
    let point: Summary.Point

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(date(point.t), format: .dateTime.hour().minute()).foregroundStyle(.secondary)
            if let p50 = point.p50 { Text("p50 \(fmtMs(p50))") }
            if let p95 = point.p95 { Text("p95 \(fmtMs(p95))") }
            Text("\(point.count) req").foregroundStyle(.secondary)
        }
        .font(.caption2)
        .monospacedDigit()
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
    }
}
