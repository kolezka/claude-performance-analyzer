import SwiftUI

// Compact live view of one turn's waterfall, with Latest/Slowest sort and prev/next stepping
// through the /api/turns list. The full span list and header live in TurnDetailView instead.
struct TurnSection: View {
    @Bindable var model: Telemetry
    var onSelectEvent: (Int) -> Void = { _ in }
    var onOpenTurn: (String) -> Void = { _ in }

    private let maxRows = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                SectionTitle("Turn")
                Spacer()
                Picker("Sort", selection: $model.turnsSort) {
                    Text("Latest").tag(Telemetry.TurnsSort.recent)
                    Text("Slowest").tag(Telemetry.TurnsSort.slowest)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.mini)
                .fixedSize()
            }
            if model.turns.isEmpty {
                Text(model.turnsError ?? "No turns in this window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                stepper
                waterfall
            }
        }
    }

    // .index wraps "where in the list": index 0 when unpinned, or the pinned id's position
    // when found. .agedOut is a pinned id the (possibly just-refreshed) list no longer has,
    // so the header below falls back to turnDetail instead of silently showing turns[0].
    private enum Position {
        case index(Int)
        case agedOut
    }

    private var position: Position {
        guard let id = model.selectedPromptId else { return .index(0) }
        if let idx = model.turns.firstIndex(where: { $0.promptId == id }) { return .index(idx) }
        return .agedOut
    }

    private var isPinned: Bool { model.selectedPromptId != nil }

    private var current: TurnSummary? {
        guard case .index(let idx) = position, model.turns.indices.contains(idx) else { return nil }
        return model.turns[idx]
    }

    // Open-in-Details follows whichever turn is actually on screen: the listed one, or the
    // pinned one once it has aged out of the list and we're showing turnDetail instead.
    private var displayedPromptId: String? {
        if let current { return current.promptId }
        if case .agedOut = position { return model.turnDetail?.promptId ?? model.selectedPromptId }
        return nil
    }

    private var canStepOlder: Bool {
        switch position {
        case .index(let idx): return idx < model.turns.count - 1
        case .agedOut: return false // nowhere older than an already-aged-out pin
        }
    }

    private var canStepNewer: Bool {
        switch position {
        case .index(let idx): return idx > 0
        case .agedOut: return true // steps into the list at its oldest entry
        }
    }

    private var stepper: some View {
        HStack(spacing: 6) {
            Button { step(1) } label: { Image(systemName: "chevron.left") }
                .buttonStyle(.plain)
                .disabled(!canStepOlder)
                .help("Older turn")

            VStack(alignment: .leading, spacing: 1) {
                if let current {
                    HStack(spacing: 4) {
                        subtitle(folder: current.folder, sessionLabel: current.sessionLabel, repo: current.repo)
                        if current.inProgress {
                            Text("In progress").foregroundStyle(.orange)
                        } else if isPinned {
                            Text("Pinned").foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption.weight(.medium))
                    Text("\(fmtTurnDuration(activeMs: current.activeMs, idleMs: current.idleMs, wallMs: current.wallMs)) · \(date(current.startMs), format: .dateTime.hour().minute().second())")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else if case .agedOut = position, let detail = model.turnDetail {
                    HStack(spacing: 4) {
                        subtitle(folder: detail.folder, sessionLabel: detail.sessionLabel, repo: detail.repo)
                        Text("Pinned, aged out of list").foregroundStyle(.secondary)
                    }
                    .font(.caption.weight(.medium))
                    Text(fmtTurnDuration(activeMs: detail.activeMs, idleMs: detail.idleMs, wallMs: detail.endMs - detail.startMs))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button { step(-1) } label: { Image(systemName: "chevron.right") }
                .buttonStyle(.plain)
                .disabled(!canStepNewer)
                .help("Newer turn")

            if let promptId = displayedPromptId {
                Button("Open in Details") { onOpenTurn(promptId) }
                    .controlSize(.small)
            }
        }
        .font(.callout)
    }

    // The folder (monospaced, abbreviated, middle-truncated) stands in for the session label
    // wherever both might be shown; older collectors without it keep the old fallback chain.
    private func subtitle(folder: String?, sessionLabel: String?, repo: String?) -> some View {
        Group {
            if let folder {
                Text(abbreviateHome(folder)).monospaced()
            } else {
                Text(sessionLabel ?? repo ?? "Unknown session")
            }
        }
        .lineLimit(1)
        .truncationMode(.middle)
    }

    @ViewBuilder
    private var waterfall: some View {
        if let error = model.turnDetailError {
            Text(error).font(.caption).foregroundStyle(.secondary)
        } else if let detail = model.turnDetail {
            if let lanes = detail.lanes, let rows = detail.rows, !rows.isEmpty {
                // Main lane only in the compact section; every lane and its full row list
                // live in the Details window instead.
                if let mainLaneId = (lanes.first { $0.kind == "main" } ?? lanes.first)?.id {
                    LaneWaterfallView(
                        lanes: lanes,
                        rows: rows,
                        startMs: detail.startMs,
                        endMs: detail.endMs,
                        gaps: detail.gaps ?? [],
                        onSelect: onSelectEvent,
                        rowHeight: 14,
                        showAxis: false,
                        showLegend: false,
                        showLaneHeaders: false,
                        onlyLaneId: mainLaneId,
                        maxRows: maxRows
                    )
                } else {
                    Text("No lanes recorded for this turn.").font(.caption).foregroundStyle(.secondary)
                }
            } else if !detail.spans.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    WaterfallView(
                        spans: Array(detail.spans.prefix(maxRows)),
                        startMs: detail.startMs,
                        endMs: detail.endMs,
                        gaps: detail.gaps ?? [],
                        onSelect: onSelectEvent,
                        rowHeight: 14
                    )
                    if detail.spans.count > maxRows {
                        Text("+\(detail.spans.count - maxRows) more").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            } else {
                Text("No spans recorded for this turn.").font(.caption).foregroundStyle(.secondary)
            }
        } else {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // Newest is index 0. Stepping to it clears the pin so the section resumes following
    // the newest turn on the next refresh instead of staying pinned to that one id.
    private func step(_ delta: Int) {
        guard !model.turns.isEmpty else { return }
        let newIndex: Int
        switch position {
        case .index(let idx):
            newIndex = Prefs.clamp(idx + delta, 0...(model.turns.count - 1))
        case .agedOut:
            // Only reachable via the "newer" button (older is disabled): the pinned turn is
            // older than everything shown, so enter the list at its oldest entry.
            newIndex = model.turns.count - 1
        }
        model.selectedPromptId = newIndex == 0 ? nil : model.turns[newIndex].promptId
    }
}
