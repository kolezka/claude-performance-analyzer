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

struct HostEndpoint: Decodable, Hashable {
    let network: String
    let interface: String
    let address: String
    let url: String

    var isLAN: Bool { network == "lan" }
    var label: String { "\(isLAN ? "LAN" : "Tailscale") \(address) (\(interface))" }
}

// Returned once by add-host and regenerate-token. Held only by the view that shows it,
// never written to preferences or logged.
struct HostCredentials: Decodable {
    let host: TelemetryHost
    let token: String
    // Points at endpoints[0], or at a placeholder when endpoints is empty.
    let env: [String: String]
    // This Mac's addresses a remote host can send to. Empty when the collector found none;
    // nil from an older collector that does not list them.
    let endpoints: [HostEndpoint]?

    // The block to paste into the remote machine's Claude Code settings.json.
    func envBlock(using endpoint: HostEndpoint? = nil) -> String {
        var env = env
        if let endpoint { env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint.url }
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
