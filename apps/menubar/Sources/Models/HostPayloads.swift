import Foundation

// Collector hosts (api/hosts). "local" is this Mac and always comes first.
struct TelemetryHost: Decodable, Identifiable, Equatable {
    static let localId = "local"
    static let localName = "This Mac"

    let id: String
    let name: String
    let createdMs: Double?
    let lastSeenMs: Double?

    var isLocal: Bool { id == Self.localId }
}

// Returned once by add-host and regenerate-token. Held only by the view that shows it,
// never written to preferences or logged.
struct HostCredentials: Decodable {
    let host: TelemetryHost
    let token: String
    let env: [String: String]
    // nil when the collector found no Tailscale address and put a placeholder in the endpoint.
    let tailscaleAddress: String?

    // The block to paste into the remote machine's Claude Code settings.json.
    var envBlock: String {
        let data = try? JSONSerialization.data(
            withJSONObject: ["env": env],
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

// The collector's {error} body on a rejected host-management request.
struct HostRequestError: LocalizedError {
    let status: Int
    let message: String?

    var errorDescription: String? { message ?? "The collector answered HTTP \(status)." }
}
