import Observation

// Where the Details window is pointed: a single event, an aggregate row for one kind+name,
// one hook call, or one turn's waterfall.
enum DetailRoute: Equatable {
    case event(id: Int)
    case item(kind: StatsKind, name: String)
    case hookCall(id: Int)
    case turn(promptId: String)
}

// Navigation stack for the Details window. open() replaces the stack, since a fresh row
// click in the panel always starts a new drill-down. push()/back() move within it.
@Observable
final class DetailNavigator {
    var stack: [DetailRoute] = []

    func open(_ route: DetailRoute) { stack = [route] }
    func push(_ route: DetailRoute) { stack.append(route) }
    func back() { if !stack.isEmpty { stack.removeLast() } }
}
