import SwiftUI

// Inline error under a settings control, with an icon so it does not rely on color alone.
struct ErrorText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(.callout)
            .foregroundStyle(.red)
    }
}
