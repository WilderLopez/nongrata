import NonGrata
import NonGrataUI
import SwiftUI
import UIKit

struct ContentView: View {
    @Bindable var model: DemoModel

    /// One more for every copy: plays the haptic and restarts the toast's timer.
    @State private var copies = 0
    @State private var showsCopied = false

    var body: some View {
        Group {
            if let nonGrata = model.nonGrata {
                content
                    // The SDK's optional screen: covers the app only while the verdict is
                    // `.blocked`, and goes away by itself once the Worker answers `ok`.
                    .nonGrataBlockingOverlay(nonGrata) { ref in
                        Button("Copy support code") { copy(ref) }
                            .buttonStyle(.borderedProminent)
                    }
            } else {
                content
            }
        }
        // Outside the blocking overlay, so the toast also shows over the suspended screen.
        .overlay(alignment: .bottom) {
            if showsCopied {
                CopiedToast()
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: showsCopied)
        .sensoryFeedback(.success, trigger: copies)
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsCopied = false }
        }
    }

    /// Copies and says so: a haptic, a toast and, with VoiceOver, an announcement.
    private func copy(_ value: String) {
        UIPasteboard.general.string = value
        copies += 1
        showsCopied = true
        AccessibilityNotification.Announcement(String(localized: "Copied to clipboard")).post()
    }

    private var content: some View {
        NavigationStack {
            Form {
                verdictSection
                deviceSection
                checksSection
                diagnosticsSection
                historySection
                settingsSection
            }
            .navigationTitle("NonGrata Demo")
        }
    }

    // MARK: Sections

    private var verdictSection: some View {
        Section("Verdict") {
            if let nonGrata = model.nonGrata {
                VerdictRow(verdict: nonGrata.verdict)
                CopyRow(label: "Support code", value: nonGrata.supportCode, copy: copy)
            } else {
                Label("Set your Worker URL in Settings below.", systemImage: "gearshape")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var deviceSection: some View {
        Section {
            CopyRow(label: "installId", value: model.nonGrata?.installId, copy: copy)
            CopyRow(label: "idfv", value: model.idfv, copy: copy)
            if model.useICloud {
                // What the Worker gets for the Apple Account: never the Apple ID itself.
                CopyRow(label: "iCloud ID hash", value: model.nonGrata?.iCloudIdHash, copy: copy)
            }
            CopyRow(label: "Ban this device", value: model.banCommand, monospaced: true, copy: copy)
            CopyRow(label: "Unban by support code", value: model.unbanCommand, monospaced: true, copy: copy)
        } header: {
            Text("This device")
        } footer: {
            Text(model.useICloud
                ? "Tap a row to copy it. Run the commands from the repo root with the Worker's URL and ADMIN_TOKEN in your environment. The iCloud ID hash is the same on every device with this Apple Account; it is empty until the first check, or with no account."
                : "Tap a row to copy it. Run the commands from the repo root with the Worker's URL and ADMIN_TOKEN in your environment.")
        }
    }

    private var checksSection: some View {
        Section {
            Button("Check: launch") { run(.launch) }
            Button("Check: foreground") { run(.foreground) }
            HStack {
                Button("Check: login") { run(.login) }
                TextField("userId", text: $model.userId)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Button("Check: sign-up") { run(.signup) }
        } header: {
            Text("Run a check")
        } footer: {
            Text("Foreground skips the network for 30 s after an allowed verdict (6 h by default in a real app); launch, login and sign-up always ask the Worker. Sign-up is strict by default: if the Worker can't be reached, the check doesn't permit it.")
        }
        .disabled(!model.isConfigured || model.isChecking)
    }

    private var diagnosticsSection: some View {
        Section {
            LabeledContent("DeviceCheck", value: model.deviceCheckStatus)
            LabeledContent("Environment", value: model.deviceCheckEnvironment.rawValue)
            Button("Test DeviceCheck") { Task { await model.testDeviceCheck() } }
            if model.useICloud {
                LabeledContent("iCloud", value: model.iCloudStatus)
                Button("Test iCloud") { Task { await model.testICloud() } }
            }
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("If no token can be generated, checks reach the Worker without DeviceCheck and it decides with its list only. Apple keeps a separate bit0 per environment: Debug builds use development, TestFlight and the App Store production.")
        }
    }

    private var historySection: some View {
        Section("History") {
            if model.history.isEmpty {
                Text("No checks yet.").foregroundStyle(.secondary)
            }
            ForEach(model.history) { entry in
                HStack {
                    VStack(alignment: .leading) {
                        Text(entry.intent.rawValue).font(.body.monospaced())
                        Text(entry.date, style: .time).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing) {
                        Text(entry.verdict.label).foregroundStyle(entry.verdict.color)
                        if let permitted = entry.permitted {
                            Text(permitted ? "sign-up permitted" : "sign-up refused")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private var settingsSection: some View {
        Section {
            TextField("https://…/v1/device/check", text: $model.endpoint)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            LabeledContent("appId") {
                TextField("demo", text: $model.appId)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            LabeledContent("hashPrefix") {
                TextField("demo-ban-v1", text: $model.hashPrefix)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Button("Apply") { model.apply() }
            Button("Reset to this build's values") { model.resetSettings() }
        } header: {
            Text("Settings")
        } footer: {
            Text(model.useICloud
                ? "appId and hashPrefix must match the Worker (HASH_PREFIX_<APP>). The iCloud layer is on in this build: a block jumps to other devices with the same Apple Account."
                : "appId and hashPrefix must match the Worker (HASH_PREFIX_<APP>). The iCloud layer is off in this build: it needs CloudKit on the App ID (see Config/Local.example.xcconfig).")
        }
    }

    private func run(_ intent: CheckIntent) {
        Task { await model.check(intent) }
    }
}

// MARK: - Rows

private struct VerdictRow: View {
    let verdict: NonGrataVerdict

    var body: some View {
        HStack {
            Image(systemName: verdict.symbol).foregroundStyle(verdict.color)
            Text(verdict.label).font(.headline)
            Spacer()
            Text(verdict.explanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct CopyRow: View {
    let label: String
    let value: String?
    var monospaced = false
    let copy: (String) -> Void

    var body: some View {
        Button {
            if let value { copy(value) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value ?? "–")
                    .font(monospaced ? .footnote.monospaced() : .body.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }
        }
        .disabled(value == nil)
    }
}

/// Says that a tap copied something: without it, nothing on screen changes.
private struct CopiedToast: View {
    var body: some View {
        Label("Copied to clipboard", systemImage: "doc.on.doc.fill")
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: .capsule)
            .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
            .accessibilityHidden(true) // announced when it is copied
    }
}

private extension NonGrataVerdict {
    var label: String {
        switch self {
        case .allowed: "allowed"
        case .blocked: "blocked"
        case .unknown: "unknown"
        }
    }

    var explanation: String {
        switch self {
        case .allowed: "The Worker answered ok."
        case let .blocked(ref): "Banned. Support code \(ref)."
        case .unknown: "No answer and no local flag: fail-open."
        }
    }

    var symbol: String {
        switch self {
        case .allowed: "checkmark.shield.fill"
        case .blocked: "hand.raised.fill"
        case .unknown: "questionmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .allowed: .green
        case .blocked: .red
        case .unknown: .orange
        }
    }
}
