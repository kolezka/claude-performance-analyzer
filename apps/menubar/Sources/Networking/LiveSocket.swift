import Foundation

enum LiveConnectionState: Equatable { case live, reconnecting, offline }

// One frame from the collector's /ws.
struct LiveFrame: Decodable, Equatable {
    let type: String
    let host: String
    let events: [LiveEvent]
    let changed: Int
}

// What Telemetry needs from a socket. Production wraps URLSessionWebSocketTask, tests script frames.
protocol LiveSocketConnection: AnyObject, Sendable {
    // Returns once the handshake succeeded, throws if it did not.
    func open() async throws
    // Next text frame. Throws when the connection closes or fails.
    func receive() async throws -> String
    func cancel()
}

typealias LiveSocketFactory = @Sendable (URL) -> any LiveSocketConnection

final class URLSessionLiveSocket: LiveSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(url: URL, session: URLSession) {
        task = session.webSocketTask(with: url)
    }

    // A ping only completes once the handshake is done, so its result is the open signal.
    func open() async throws {
        task.resume()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: throw URLError(.cannotDecodeContentData)
        }
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

extension Telemetry {
    // ws:// or wss:// for the collector's /ws, keeping any sub-path and port.
    static func socketURL(for collector: URL) -> URL {
        let http = url(base: collector, path: "ws", query: [])
        var components = URLComponents(url: http, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme?.lowercased() == "https" ? "wss" : "ws"
        return components.url!
    }
}
