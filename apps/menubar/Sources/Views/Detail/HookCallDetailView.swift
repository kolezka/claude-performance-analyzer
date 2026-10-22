import SwiftUI

// One hook call: what telemetry recorded about it, its session, and the scripts the session
// registered. Scripts come from current configuration, so they are candidates, not proof.
struct HookCallDetailView: View {
    @Bindable var model: Telemetry
    let id: Int
    let onPush: (DetailRoute) -> Void

    @State private var detail: HookCallDetail?
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let detail {
                header(detail)
                contextSection(detail)
                scriptsSection(detail)
                if let hint = detail.hint { hintSection(hint) }
                Text("Per-script timing is not captured yet.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let promptId = detail.call.promptId {
                    Button("Open turn", systemImage: "list.bullet.indent") { onPush(.turn(promptId: promptId)) }
                        .controlSize(.small)
                }
            } else if let loadError {
                EmptyState(
                    title: "Couldn't load hook call",
                    symbol: "exclamationmark.triangle",
                    message: "\(loadError)",
                    retry: { Task { await load() } }
                )
            } else {
                DetailSkeleton()
            }
            refreshBar
        }
        .task(id: "\(model.selectionGeneration)/\(id)") { await load() }
    }

    private var refreshBar: some View {
        HStack {
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                .controlSize(.small)
                .disabled(isLoading)
        }
    }

    private func headerText(_ d: HookCallDetail) -> String {
        var parts = [d.call.ms.map(fmtMs) ?? "Duration not captured"]
        if let hooks = d.call.hooks {
            parts.append("\(hooks.success) OK")
            parts.append("\(hooks.errors) error\(hooks.errors == 1 ? "" : "s")")
            if hooks.blocking > 0 { parts.append("\(hooks.blocking) blocked") }
            if hooks.cancelled > 0 { parts.append("\(hooks.cancelled) cancelled") }
            if hooks.errors > 0 { parts.append("failing script not reported") }
        }
        return parts.joined(separator: " · ")
    }

    private func header(_ d: HookCallDetail) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: StatsKind.hooks.symbol)
                .foregroundStyle(d.call.ok ? Color.secondary : Color.red)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(d.name).font(.headline).lineLimit(1).truncationMode(.middle)
                Text(headerText(d))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer()
            OkBadge(ok: d.call.ok)
        }
    }

    private func contextRow(_ title: String, _ value: String, missing: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
            Text(value)
                .foregroundStyle(missing ? .tertiary : .primary)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .font(.caption)
    }

    private func contextSection(_ d: HookCallDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle("Context")
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Time").foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
                Text(date(d.call.tsMs), format: .dateTime.month().day().hour().minute().second()).monospacedDigit()
            }
            .font(.caption)
            contextRow("Session kind", d.session.kindLabel ?? "Not captured", missing: d.session.kindLabel == nil)
            contextRow("Terminal", d.session.terminal ?? "Not captured", missing: d.session.terminal == nil)
            contextRow("Folder", d.call.folder.map { displayPath($0, hostId: model.selectedHostId) } ?? "Folder not recorded", missing: d.call.folder == nil)
            contextRow("Branch", d.call.branch ?? "Not captured", missing: d.call.branch == nil)
            contextRow("Claude Code", d.session.claudeVersion ?? "Not captured", missing: d.session.claudeVersion == nil)
            if let launcher = d.session.launcher {
                contextRow("Launched by", launcher)
            } else {
                contextRow("Launched by", "Launcher not reported", missing: true)
                Text("A launcher can tag its runs with OTEL_RESOURCE_ATTRIBUTES=launcher=<name>.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 118)
            }
            if let sessionId = d.session.sessionId {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Session ID").foregroundStyle(.secondary).frame(width: 110, alignment: .leading)
                    Text(sessionId).monospaced().textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    Button { copyToPasteboard(sessionId) } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("Copy session id")
                }
                .font(.caption)
            } else {
                contextRow("Session ID", "Not captured", missing: true)
            }
        }
    }

    private func scriptsSection(_ d: HookCallDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                SectionTitle(model.isRemoteSelected ? "Registrations" : "Scripts")
                Text(model.isRemoteSelected ? "Remote telemetry" : "Current configuration").font(.caption2).foregroundStyle(.tertiary)
            }
            switch d.candidates.status {
            case "remote":
                Text("Commands and timeouts are not available from remote telemetry.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                ForEach(Array(d.candidates.scripts.enumerated()), id: \.offset) { _, script in
                    scriptRow(script)
                }
            case "matched":
                ForEach(Array(d.candidates.scripts.enumerated()), id: \.offset) { _, script in
                    scriptRow(script)
                }
            case "mismatch":
                let ran = d.call.hooks?.count ?? 0
                Text("\(ran) hook\(ran == 1 ? "" : "s") ran; which one is not reported.")
                    .font(.callout)
                Text("Candidates registered by this session:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(Array(d.candidates.scripts.enumerated()), id: \.offset) { _, script in
                    scriptRow(script)
                }
            case "unresolved":
                Text("This session registered hooks for this event, but current configuration no longer matches them.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            default:
                Text("No matching hook registrations seen for this call.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func scriptRow(_ script: ItemDetail.Definition) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(script.source.capitalized)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.secondary.opacity(0.15), in: .capsule)
                    .foregroundStyle(.secondary)
                Text(script.plugin ?? script.summary).font(.callout.weight(.medium)).lineLimit(1)
            }
            if let command = script.command {
                Text(command)
                    .font(.caption)
                    .monospaced()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .help(command)
            }
            if model.isRemoteSelected {
                if let event = script.hookEvent {
                    Text(event + (script.matcher.map { ": \($0)" } ?? ""))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let source = script.hookSource {
                    Text(source).font(.caption2).foregroundStyle(.tertiary)
                }
            } else {
                HStack(spacing: 10) {
                    Text(script.timeoutSec.map { "Timeout: \(fmtSeconds($0))" } ?? "No timeout set")
                        .foregroundStyle(.secondary)
                    Text("Duration: Not captured").foregroundStyle(.tertiary)
                    Text("Status: Not captured").foregroundStyle(.tertiary)
                }
                .font(.caption2)
            }
        }
        .padding(.vertical, 2)
    }

    private func hintSection(_ hint: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(hint).font(.callout)
            Text("Current configuration").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }

    private func load() async {
        let generation = model.selectionGeneration
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await model.fetchHookCall(id: id)
            guard !Task.isCancelled, generation == model.selectionGeneration else { return }
            detail = d
            loadError = nil
        } catch {
            guard !Task.isCancelled, !Telemetry.isStale(error), generation == model.selectionGeneration else { return }
            loadError = error.localizedDescription
        }
    }
}
