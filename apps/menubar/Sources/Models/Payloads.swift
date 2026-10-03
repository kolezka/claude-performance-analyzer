import Foundation

// The fields of src/analytics.ts the panel shows.

struct Status: Decodable {
    let label: String
    let state: String
    // Missing from older collectors, and empty while idle.
    let values: [String: String]?
}

struct Stats: Decodable {
    let name: String
    let totalMs: Double
    let p95: Double
}

struct Summary: Decodable {
    struct Kpis: Decodable {
        let sessions: Int
        let apiP50: Double
        let apiP95: Double
        let ttftP50: Double?
        let turnP50: Double
        let costUsd: Double
        let cacheHitRatio: Double
    }
    struct Breakdown: Decodable {
        let api: Double
        let tools: Double
        let hooks: Double
    }
    struct Point: Decodable {
        let t: Double
        let p50: Double?
        let p95: Double?
        let count: Int
    }
    struct Series: Decodable {
        let points: [Point]
    }

    let eventCount: Int
    let kpis: Kpis
    let breakdown: Breakdown
    let apiSeries: Series
    let hooks: [Stats]
    let tools: [Stats]
    let subagents: [Stats]
}

struct LiveEvent: Decodable {
    let tsMs: Double
    let kind: String
    let label: String
    let ms: Double?
    let ok: Bool
    let sessionId: String?
    // Present only when the collector can resolve a detail record for this event.
    let id: Int?
}
