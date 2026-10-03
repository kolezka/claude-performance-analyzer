import SwiftUI

// Ok/failed pill, shared by both detail views.
struct OkBadge: View {
    let ok: Bool

    var body: some View {
        Text(ok ? "OK" : "Failed")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(ok ? Color.green.opacity(0.15) : Color.red.opacity(0.15), in: .capsule)
            .foregroundStyle(ok ? Color.green : Color.red)
    }
}

struct StatCell: View {
    let title: String
    let value: String
    var warn = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.callout.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(warn ? Color.orange : Color.primary)
        }
    }
}

struct DetailSkeleton: View {
    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}
