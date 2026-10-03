import SwiftUI

struct ConnectionSettingsTab: View {
    @Bindable var model: Telemetry
    @State private var urlDraft = ""
    @State private var urlError: String?
    @State private var testResult: TestResult?
    @State private var isTesting = false

    private enum TestResult {
        case ok
        case failure(String)
    }

    var body: some View {
        Form {
            Section("Collector") {
                HStack {
                    TextField("Collector URL", text: $urlDraft)
                        .onSubmit(applyURL)
                    Button("Apply", action: applyURL)
                        .disabled(urlDraft == model.collectorURL.absoluteString)
                }
                if let urlError {
                    Text(urlError).font(.caption).foregroundStyle(.red)
                }
                HStack(spacing: 8) {
                    Button("Test Connection") { Task { await testConnection() } }
                        .disabled(isTesting)
                    if isTesting {
                        ProgressView().controlSize(.small)
                    } else if let testResult {
                        switch testResult {
                        case .ok:
                            Label("Reachable", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        case .failure(let message):
                            Label(message, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                        }
                    }
                }
            }
            Section("Polling") {
                Stepper(value: $model.statusPollIntervalSec, in: 1...60) {
                    Text("Status poll interval: \(Int(model.statusPollIntervalSec))s")
                }
                Stepper(value: $model.panelPollIntervalSec, in: 1...60) {
                    Text("Panel poll interval: \(Int(model.panelPollIntervalSec))s")
                }
                Stepper(value: $model.requestTimeoutSec, in: 1...30) {
                    Text("Request timeout: \(Int(model.requestTimeoutSec))s")
                }
                Stepper(value: $model.retryDelaySec, in: 1...60) {
                    Text("Retry delay after failure: \(Int(model.retryDelaySec))s")
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { urlDraft = model.collectorURL.absoluteString }
        // A result belongs to the URL that was tested, so editing the draft clears it.
        .onChange(of: urlDraft) { testResult = nil }
    }

    private func applyURL() {
        guard let url = Prefs.validCollectorURL(urlDraft) else {
            urlError = "Enter a valid http or https URL with a host, without query or fragment."
            return
        }
        urlError = nil
        model.collectorURL = url
        urlDraft = url.absoluteString
    }

    private func testConnection() async {
        guard let url = Prefs.validCollectorURL(urlDraft) else {
            urlError = "Enter a valid http or https URL with a host."
            return
        }
        urlError = nil
        isTesting = true
        defer { isTesting = false }
        let testedDraft = urlDraft
        let result = await model.testConnection(url: url)
        guard urlDraft == testedDraft else { return }
        switch result {
        case .success: testResult = .ok
        case .failure(let error): testResult = .failure(error.localizedDescription)
        }
    }
}
