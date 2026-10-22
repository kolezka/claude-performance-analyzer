import Foundation

// Detail payloads (api/event, api/item, api/turns, api/turn).

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
    // Missing from older collectors, which have no concept of headless SDK sessions.
    let kind: String?
    let kindLabel: String?
}

struct ItemDetail: Decodable {
    struct Repo: Decodable {
        let name: String?
        let root: String?
        // Older collectors don't send a ready-made label, so the view falls back to name.
        let label: String?
        let count: Int
        let totalMs: Double
        let p95: Double
    }
    struct HookRecentInfo: Decodable {
        let hookEvent: String
        let matcher: String?
        let count: Int
        let success: Int
        let errors: Int
        let blocking: Int
        let cancelled: Int
        let stdoutChars: Int
        let contextChars: Int
    }
    struct Recent: Decodable {
        let id: Int
        let tsMs: Double
        let ms: Double?
        let ok: Bool
        let sessionId: String?
        let repo: String?
        let detail: String?
        let promptId: String?
        let sessionKind: String?
        let sessionLabel: String?
        let branch: String?
        let hooks: HookRecentInfo?
        // Missing from older collectors, which only reported the session's repo name.
        let folder: String?
        let worktree: Bool?
    }
    struct Definition: Decodable {
        let source: String
        let plugin: String?
        let matcher: String?
        let type: String
        let command: String?
        let summary: String
        let sessions: Int
        let configPath: String?
        // Sent for remote hosts only: the registered hook event and source as telemetry reported
        // them. Remote definitions never carry a command or config path.
        let hookEvent: String?
        let hookSource: String?
    }

    let kind: String
    let name: String
    let count: Int
    let failures: Int
    let totalMs: Double
    let p50: Double
    let p95: Double
    let maxMs: Double
    // Missing from older collectors, which have no concept of headless SDK sessions.
    let headlessCount: Int?
    let repos: [Repo]
    let recent: [Recent]
    let failed: [Recent]?
    let definitions: [Definition]?
}

// One row of /api/turns: a turn's timing and where it ran, without its spans.
struct TurnSummary: Decodable, Identifiable {
    var id: String { promptId }
    let promptId: String
    let startMs: Double
    let endMs: Double
    let wallMs: Double
    let inProgress: Bool
    let sessionId: String?
    let sessionKind: String?
    let sessionLabel: String?
    let repo: String?
    let command: String?
    let apiMs: Double
    let toolMs: Double
    let hookMs: Double
    // Missing from older collectors, which didn't separate idle time from active turn time.
    let activeMs: Double?
    let idleMs: Double?
    let folder: String?
}

// /api/turn: one turn's full span list for the waterfall. The collector returns JSON null
// when the prompt has no recorded events, so this decodes as an optional at the call site.
struct TurnDetail: Decodable {
    // Flat span list from the first cut of this view. Kept as a fallback render when an
    // older collector sends no `rows`/`lanes`.
    struct Span: Decodable {
        let kind: String
        let label: String
        let startMs: Double
        let endMs: Double
        let ok: Bool
        let id: Int?
        let detail: String?
    }
    // A stretch of wall time with no activity (e.g. waiting on the user), compressed to a
    // narrow break on the waterfall's time axis instead of stretching every span thin.
    struct Gap: Decodable {
        let startMs: Double
        let endMs: Double
    }
    struct Breakdown: Decodable {
        let apiMs: Double
        let toolMs: Double
        let hookMs: Double
    }
    // One track of the lane-grouped waterfall: the main thread, one per concurrent subagent,
    // or background work.
    struct Lane: Decodable, Identifiable {
        let id: String
        let kind: String
        let title: String
        let model: String?
    }
    // A hook call folded directly onto its tool row instead of getting its own row.
    struct HookRef: Decodable {
        let startMs: Double
        let endMs: Double
        let id: Int?
    }
    struct Row: Decodable {
        let lane: String
        let kind: String
        let label: String
        let detail: String?
        let startMs: Double
        let endMs: Double
        let ok: Bool
        let id: Int?
        let pre: HookRef?
        let post: HookRef?
        let hookMs: Double
    }

    let promptId: String?
    let command: String?
    let startMs: Double
    let endMs: Double
    let sessionId: String?
    let sessionKind: String?
    let sessionLabel: String?
    let repo: String?
    let spans: [Span]
    // Missing from older collectors, which didn't separate idle time from active turn time,
    // name a working folder, or group work into lanes.
    let gaps: [Gap]?
    let activeMs: Double?
    let idleMs: Double?
    let folder: String?
    let branch: String?
    let breakdown: Breakdown?
    let lanes: [Lane]?
    let rows: [Row]?
}
