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
        VStack(alignment: .leading, spacing: 18) {
            if let detail {
                header(detail)
                if let hint = detail.hint { hintSection(hint) }
                contextSection(detail)
                scriptsSection(detail)
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
        }
        .toolbar {
            if let promptId = detail?.call.promptId {
                ToolbarItem(placement: .primaryAction) {
                    Button("Open Turn", systemImage: "list.bullet.indent") { onPush(.turn(promptId: promptId)) }
                        .help("Show the turn this hook ran in")
                }
            }
            RefreshToolbar(isLoading: isLoading) { Task { await load() } }
        }
        .task(id: "\(model.selectionGeneration)/\(id)") { await load() }
    }

    private func header(_ d: HookCallDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeader(
                symbol: d.call.ok ? StatsKind.hooks.symbol : "xmark.octagon",
                tint: d.call.ok ? StatsKind.hooks.tint : .red,
                title: d.name,
                subtitle: date(d.call.tsMs).formatted(.dateTime.month().day().hour().minute().second())
            ) {
                OkBadge(ok: d.call.ok)
            }
            Card(padding: 12) {
                HStack(spacing: 8) {
                    MetricTile(title: "Duration", value: d.call.ms.map(fmtMs) ?? "–")
                    if let hooks = d.call.hooks {
                        MetricTile(title: "OK", value: "\(hooks.success)")
                        MetricTile(title: "Errors", value: "\(hooks.errors)", warn: hooks.errors > 0)
                        if hooks.blocking > 0 { MetricTile(title: "Blocked", value: "\(hooks.blocking)", warn: true) }
                        if hooks.cancelled > 0 { MetricTile(title: "Cancelled", value: "\(hooks.cancelled)", warn: true) }
                    }
                }
                if let hooks = d.call.hooks, hooks.errors > 0 {
                    Text("Telemetry does not say which script failed.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 6)
                }
            }
        }
    }

    private func contextSection(_ d: HookCallDetail) -> some View {
        DetailSection("Context", symbol: "info.circle") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                InfoRow("Session kind", d.session.kindLabel ?? "Not captured", missing: d.session.kindLabel == nil)
                InfoRow("Terminal", d.session.terminal ?? "Not captured", missing: d.session.terminal == nil)
                InfoRow("Folder", d.call.folder.map { displayPath($0, hostId: model.selectedHostId) } ?? "Folder not recorded",
                        missing: d.call.folder == nil, mono: d.call.folder != nil)
                InfoRow("Branch", d.call.branch ?? "Not captured", missing: d.call.branch == nil, mono: d.call.branch != nil)
                InfoRow("Claude Code", d.session.claudeVersion ?? "Not captured", missing: d.session.claudeVersion == nil)
                InfoRow(title: "Launched by") {
                    if let launcher = d.session.launcher {
                        InfoText(text: launcher)
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            InfoText(text: "Launcher not reported", missing: true)
                            Text("A launcher can tag its runs with OTEL_RESOURCE_ATTRIBUTES=launcher=<name>.")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                InfoRow(title: "Session ID") {
                    if let sessionId = d.session.sessionId {
                        HStack(spacing: 6) {
                            InfoText(text: sessionId, mono: true).lineLimit(1)
                            CopyButton(value: sessionId, help: "Copy session id")
                        }
                    } else {
                        InfoText(text: "Not captured", missing: true)
                    }
                }
            }
        }
    }

    private func scriptsSection(_ d: HookCallDetail) -> some View {
        DetailSection(title: model.isRemoteSelected ? "Registrations" : "Scripts", symbol: "scroll") {
            Text(model.isRemoteSelected ? "Remote telemetry" : "Current configuration").font(.caption).foregroundStyle(.tertiary)
        } content: {
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
            Text("Per-script timing is not captured yet.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private func scriptRow(_ script: ItemDetail.Definition) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Tag(script.source.capitalized)
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
            Label(hint, systemImage: "lightbulb").font(.callout)
            Text("Current configuration").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.yellow.opacity(0.12), in: .rect(cornerRadius: 10))
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
