import Foundation

// The Hosts tab's add, regenerate and remove actions, with their busy state, error and the
// one-time credential reveal. Owned by the tab, kept apart from the view so it can be tested.
@MainActor
@Observable
final class HostActions {
    private(set) var busy = false
    private(set) var error: String?
    private(set) var revealed: HostCredentials?

    @ObservationIgnored private let model: Telemetry
    // The latest action's task, exposed so tests can wait for it to finish.
    @ObservationIgnored private(set) var task: Task<Void, Never>?
    // Bumped when the tab closes, the collector changes or a new action starts. A completion
    // from an older epoch writes nothing: no reveal, no error, no busy change, no callback.
    @ObservationIgnored private var epoch = 0

    init(model: Telemetry) {
        self.model = model
    }

    func add(name: String, onSuccess: @escaping () -> Void) {
        run(onSuccess: onSuccess) { try await self.model.addHost(name: name) }
    }

    func regenerate(id: String) {
        run { try await self.model.regenerateHostToken(id: id) }
    }

    func remove(id: String) {
        run {
            try await self.model.removeHost(id: id)
            return nil
        }
    }

    // The Done button.
    func dismissReveal() {
        revealed = nil
    }

    // The tab went away. Called from onDisappear.
    func tabDisappeared() {
        invalidate()
    }

    // The collector URL changed. Called from onChange(of: collectorURL). Comparing URLs alone
    // would let an action started on A finish after a change to B and back to A.
    func collectorChanged() {
        invalidate()
    }

    // The request itself is not cancelled. A write the collector already received cannot be
    // undone, and cancelling the follow-up list would surface a "cancelled" host-list error.
    // Its result is simply dropped.
    private func invalidate() {
        epoch += 1
        busy = false
        error = nil
        revealed = nil
    }

    // One action at a time. Every write after the await checks that this action is still current.
    private func run(onSuccess: (() -> Void)? = nil, _ action: @escaping () async throws -> HostCredentials?) {
        epoch += 1
        let started = epoch
        busy = true
        error = nil
        revealed = nil
        task = Task {
            do {
                let credentials = try await action()
                guard started == epoch else { return }
                busy = false
                revealed = credentials
                onSuccess?()
            } catch {
                guard started == epoch else { return }
                busy = false
                self.error = error.localizedDescription
            }
        }
    }
}
