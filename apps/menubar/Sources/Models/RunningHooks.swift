import Foundation

struct RunningHook: Identifiable, Equatable {
    let sessionId: String?
    let label: String
    let startedMs: Double
    var id: String { "\(sessionId ?? "")|\(label)" }
}

// Hooks that started and have not completed. Pure value type so it is testable without the model.
// Completions are remembered, so a fetched list that still shows an older start (a fetch that
// began before the completion was pushed) cannot bring a finished hook back.
struct RunningHooks: Equatable {
    // A hook whose completion never arrives falls out after this long. Same as the dashboard.
    static let staleMs = 120_000.0

    private(set) var entries: [RunningHook] = []
    private var completedMs: [String: Double] = [:]

    var isEmpty: Bool { entries.isEmpty }

    // Events in any order, replayed lists included: a start only replaces an older start, and a
    // completion only removes a start that happened before it, so stale history changes nothing.
    mutating func track(_ events: [LiveEvent]) {
        for event in events {
            let hook = RunningHook(sessionId: event.sessionId, label: event.label, startedMs: event.tsMs)
            switch event.kind {
            case "hook_start":
                if let done = completedMs[hook.id], done >= hook.startedMs { continue }
                if let current = entries.first(where: { $0.id == hook.id }), current.startedMs >= hook.startedMs { continue }
                entries.removeAll { $0.id == hook.id }
                entries.append(hook)
            case "hook":
                completedMs[hook.id] = max(completedMs[hook.id] ?? 0, event.tsMs)
                entries.removeAll { $0.id == hook.id && $0.startedMs <= event.tsMs }
            default:
                break
            }
        }
    }

    mutating func prune(nowMs: Double) {
        entries.removeAll { nowMs - $0.startedMs > Self.staleMs }
        completedMs = completedMs.filter { nowMs - $0.value <= Self.staleMs }
    }
}
