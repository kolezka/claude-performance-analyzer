import AppKit
import SwiftUI

// Where the overlay is pointed: a single event, or an aggregate row for one kind+name.
enum DetailRoute {
    case event(id: Int)
    case item(kind: StatsKind, name: String)
}

// Dimmed backdrop plus a card, replacing the panel content in place. Not a .sheet or NSWindow:
// either of those closes or misbehaves inside a MenuBarExtra panel.
struct DetailOverlay: View {
    @Bindable var model: Telemetry
    @Binding var stack: [DetailRoute]

    var body: some View {
        if let route = stack.last {
            ZStack {
                Rectangle()
                    .fill(.black.opacity(0.35))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onTapGesture(perform: close)

                DetailCard(model: model, route: route, canGoBack: stack.count > 1, onBack: back, onClose: close, onPush: push)
                    .padding(14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .transition(.opacity)
            .onExitCommand(perform: close)
        }
    }

    private func close() { withAnimation(panelAnimation()) { stack = [] } }
    private func back() { withAnimation(panelAnimation()) { if !stack.isEmpty { stack.removeLast() } } }
    private func push(_ route: DetailRoute) { withAnimation(panelAnimation()) { stack.append(route) } }
}

struct DetailCard: View {
    @Bindable var model: Telemetry
    let route: DetailRoute
    let canGoBack: Bool
    let onBack: () -> Void
    let onClose: () -> Void
    let onPush: (DetailRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            toolbar
            ScrollView {
                routeContent.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
    }

    private var toolbar: some View {
        HStack {
            if canGoBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .help("Back")
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close (Esc)")
        }
    }

    @ViewBuilder private var routeContent: some View {
        switch route {
        case .event(let id):
            EventDetailView(model: model, id: id)
        case .item(let kind, let name):
            ItemDetailView(model: model, kind: kind, name: name, onPush: onPush)
        }
    }
}
