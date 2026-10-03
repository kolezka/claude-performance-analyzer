import Foundation

// Detail payloads (api/event and api/item).

struct EventDetail: Decodable {
    struct Detail: Decodable {
        let key: String
        let value: String
    }

    let id: Int
    let tsMs: Double
    let name: String
    let kind: String
    let label: String
    let ms: Double?
    let ok: Bool
    let sessionId: String?
    let promptId: String?
    let details: [Detail]
    let session: SessionInfo?
}

struct SessionInfo: Decodable {
    struct Repo: Decodable {
        let name: String
        let root: String
        let worktree: String?
    }

    let sessionId: String
    let repo: Repo?
    let pathsSeen: Int
    let otherRepos: [String]
    let branch: String?
    let terminal: String?
    let claudeVersion: String?
    let models: [String]
    let firstMs: Double
    let lastMs: Double
    let prompts: Int
    let costUsd: Double
}

struct ItemDetail: Decodable {
    struct Repo: Decodable {
        let name: String?
        let root: String?
        let count: Int
        let totalMs: Double
        let p95: Double
    }
    struct Recent: Decodable {
        let id: Int
        let tsMs: Double
        let ms: Double?
        let ok: Bool
        let sessionId: String?
        let repo: String?
        let detail: String?
    }

    let kind: String
    let name: String
    let count: Int
    let failures: Int
    let totalMs: Double
    let p50: Double
    let p95: Double
    let maxMs: Double
    let repos: [Repo]
    let recent: [Recent]
}
