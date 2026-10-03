import SwiftUI

// ContentUnavailableView wraps itself in a ScrollView, which collapses to zero height in a
// self-sizing menu bar panel. A plain stack sizes to its content.
struct EmptyState: View {
    let title: String
    let symbol: String
    let message: LocalizedStringKey
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
                .symbolEffect(.bounce, value: title)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Retry Now", systemImage: "arrow.clockwise", action: retry)
                    .controlSize(.small)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}
