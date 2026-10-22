import SwiftUI

// Root content of the Details window. Replaces the old in-panel overlay: a real window that
// stays open across panel closes, can be resized, and remembers its own frame.
struct DetailWindowView: View {
    @Bindable var model: Telemetry
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        Group {
            if let route = model.navigator.stack.last {
                ScrollView {
                    routeContent(route).frame(maxWidth: .infinity, alignment: .leading)
                }
                // A host switch remounts the content, dropping every loaded detail and its tasks.
                .id(model.selectionGeneration)
            } else {
                EmptyState(
                    title: "Nothing selected",
                    symbol: "square.dashed",
                    message: "Click a row in the panel to see its details here."
                )
            }
        }
        .padding(14)
        .frame(minWidth: 520, minHeight: 560)
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                if model.navigator.stack.count > 1 {
                    Button(action: model.navigator.back) {
                        Image(systemName: "chevron.left")
                    }
                    .help("Back")
                }
            }
        }
        .background {
            // Keeps Esc wired to close even though nothing in this window is a sheet or popover.
            Button("", action: close).keyboardShortcut(.cancelAction).hidden()
        }
    }

    private var title: String {
        switch model.navigator.stack.last {
        case nil: "Details"
        case .event: "Event"
        case .item(let kind, let name): "\(kind.label): \(name)"
        case .turn: "Turn"
        }
    }

    @ViewBuilder
    private func routeContent(_ route: DetailRoute) -> some View {
        switch route {
        case .event(let id):
            EventDetailView(model: model, id: id)
        case .item(let kind, let name):
            ItemDetailView(model: model, kind: kind, name: name, onPush: model.navigator.push)
        case .turn(let promptId):
            TurnDetailView(model: model, promptId: promptId, onPush: model.navigator.push)
        }
    }

    private func close() { dismissWindow(id: "details") }
}
