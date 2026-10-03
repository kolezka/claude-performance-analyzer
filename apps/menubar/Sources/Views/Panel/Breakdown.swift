import Charts
import SwiftUI

struct Swatch: View {
    let color: Color
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
}

struct Breakdown: View {
    let breakdown: Summary.Breakdown
    // Charts ignore redaction, so the skeleton greys the bar out by hand.
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let colors = redaction.isEmpty ? [Color.blue, .purple, .orange] : [Color.secondary.opacity(0.3), .secondary.opacity(0.2), .secondary.opacity(0.1)]
        let parts = [("API", breakdown.api, colors[0]), ("Tools", breakdown.tools, colors[1]), ("Hooks", breakdown.hooks, colors[2])]
        let total = parts.reduce(0) { $0 + $1.1 }
        if total > 0 {
            VStack(alignment: .leading, spacing: 5) {
                SectionTitle("Where turn time goes")
                Chart(parts, id: \.0) { name, ms, _ in
                    BarMark(x: .value("Time", ms), stacking: .normalized)
                        .foregroundStyle(by: .value("Part", name))
                }
                .chartForegroundStyleScale(domain: parts.map(\.0), range: parts.map(\.2))
                .chartXAxis(.hidden)
                .chartLegend(.hidden)
                .clipShape(.capsule)
                .frame(height: 8)
                HStack(spacing: 12) {
                    ForEach(parts, id: \.0) { name, ms, color in
                        Swatch(color: color, text: "\(name) \((ms / total).formatted(.percent.precision(.fractionLength(0))))")
                    }
                }
            }
        }
    }
}
