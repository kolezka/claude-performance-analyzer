import SwiftUI

// Remote machines that send telemetry to this Mac's collector over Tailscale or the LAN. Tokens
// and env blocks live only in `actions.revealed` while this tab is open; nothing here is persisted.
struct HostsSettingsTab: View {
    @Bindable var model: Telemetry
    @State private var actions: HostActions
    @State private var newName = ""
    @State private var copied = false
    // Which of this Mac's addresses goes into the revealed env block.
    @State private var endpointIndex = 0
    @State private var pendingRegenerate: TelemetryHost?
    @State private var pendingRemove: TelemetryHost?

    init(model: Telemetry) {
        self.model = model
        _actions = State(initialValue: HostActions(model: model))
    }

    var body: some View {
        Form {
            Section {
                ForEach(model.hosts) { host in hostRow(host) }
                if model.hosts.isEmpty {
                    Text(model.hostsError.map { "Couldn't load hosts: \($0)" } ?? "Loading hosts…")
                        .foregroundStyle(.secondary)
                } else if let hostsError = model.hostsError {
                    Text("Host list may be out of date: \(hostsError)").font(.caption).foregroundStyle(.orange)
                }
            } header: {
                Text("Hosts")
            }

            if let revealed = actions.revealed { revealSection(revealed) }

            Section {
                HStack {
                    TextField("Name", text: $newName, prompt: Text("e.g. Linux workstation"))
                        .onSubmit(add)
                    Button("Add Host", action: add)
                        .disabled(actions.busy || trimmedName.isEmpty || trimmedName.count > 80)
                }
                if let actionError = actions.error {
                    Text(actionError).font(.caption).foregroundStyle(.red)
                }
            } header: {
                Text("Add a remote host")
            } footer: {
                Text("The remote machine sends telemetry over Tailscale or your LAN with its own token. With at least one host, the collector listens on all interfaces, so macOS may ask once to allow incoming connections. Only Tailscale and private LAN peers with a valid token are accepted, and reads stay on this Mac.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .task { await model.refreshHosts() }
        // A token belongs to the collector that issued it, and is shown only while it is fresh.
        .onChange(of: model.collectorURL) { actions.collectorChanged() }
        .onDisappear { actions.tabDisappeared() }
        // Each new reveal starts with an unused Copy button and the first address.
        .onChange(of: actions.revealed?.token) {
            copied = false
            endpointIndex = 0
        }
        .confirmationDialog(
            "Regenerate the token for \(pendingRegenerate?.name ?? "")?",
            isPresented: Binding(get: { pendingRegenerate != nil }, set: { if !$0 { pendingRegenerate = nil } }),
            titleVisibility: .visible,
            presenting: pendingRegenerate
        ) { host in
            Button("Regenerate") { regenerate(host) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The current token stops working at once. The remote machine sends nothing until you paste the new env block.")
        }
        .confirmationDialog(
            "Remove \(pendingRemove?.name ?? "")?",
            isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }),
            titleVisibility: .visible,
            presenting: pendingRemove
        ) { host in
            Button("Remove Host and Data", role: .destructive) { remove(host) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its token stops working and all of its telemetry is deleted from this Mac. This cannot be undone.")
        }
    }

    private var trimmedName: String { newName.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func hostRow(_ host: TelemetryHost) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name)
                Group {
                    if host.isLocal {
                        Text("This Mac's own Claude Code")
                    } else if let lastSeen = host.lastSeenMs {
                        Text("Last seen \(Text(date(lastSeen), style: .relative)) ago")
                    } else {
                        Text("Waiting for data")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if !host.isLocal {
                Button("Regenerate Token") { pendingRegenerate = host }
                    .disabled(actions.busy)
                Button("Remove", role: .destructive) { pendingRemove = host }
                    .disabled(actions.busy)
            }
        }
    }

    private func revealSection(_ credentials: HostCredentials) -> some View {
        let endpoints = credentials.endpoints
        let endpoint = endpoints.flatMap { $0.indices.contains(endpointIndex) ? $0[endpointIndex] : nil }
        let block = credentials.envBlock(using: endpoint)
        return Section {
            if let endpoints {
                if endpoints.isEmpty {
                    Label(
                        "No Tailscale or LAN address found on this Mac. Replace <THIS_MAC_IP> with an address the remote machine can reach before pasting.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                } else {
                    Picker("Reach this Mac at", selection: $endpointIndex) {
                        ForEach(endpoints.indices, id: \.self) { i in
                            Text(endpoints[i].label).tag(i)
                        }
                    }
                    .onChange(of: endpointIndex) { copied = false }
                    if endpoint?.isLAN == true {
                        Label(
                            "Over the LAN, telemetry and this token travel unencrypted. Use it only on a network you trust.",
                            systemImage: "lock.open"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }
                }
            }
            Text(block)
                .font(.caption)
                .monospaced()
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    copyToPasteboard(block)
                    copied = true
                }
                Spacer()
                Button("Done") { actions.dismissReveal() }
            }
        } header: {
            Text("Settings for \(credentials.host.name)")
        } footer: {
            Text("Paste this into the remote machine's ~/.claude/settings.json. It is shown once and will not be shown again; regenerate the token if you lose it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func add() {
        let name = trimmedName
        guard !name.isEmpty, name.count <= 80, !actions.busy else { return }
        actions.add(name: name) { newName = "" }
    }

    private func regenerate(_ host: TelemetryHost) {
        actions.regenerate(id: host.id)
    }

    private func remove(_ host: TelemetryHost) {
        actions.remove(id: host.id)
    }
}
