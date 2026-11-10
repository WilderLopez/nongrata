import DeviceCheck
import Foundation
import NonGrata
import UIKit

/// State of the demo: the settings, the `NonGrata` instance built from them and a history of
/// checks. A real app would create one `NonGrata` at launch with a fixed configuration.
@MainActor
@Observable
final class DemoModel {
    struct Entry: Identifiable {
        let id = UUID()
        let date: Date
        let intent: CheckIntent
        let verdict: NonGrataVerdict
        /// Only for sign-up: what `permits(_:for:)` said.
        let permitted: Bool?
    }

    var endpoint: String
    var appId: String
    var hashPrefix: String
    var userId = "user_12345"

    private(set) var nonGrata: NonGrata?
    private(set) var history: [Entry] = []
    private(set) var isChecking = false
    /// Result of generating a DeviceCheck token directly, to tell "no tokens" from "Apple failed".
    private(set) var deviceCheckStatus = "not tested"

    /// The device's `identifierForVendor`, the value to ban with `kind=idfv`.
    let idfv = UIDevice.current.identifierForVendor?.uuidString

    private let defaults = UserDefaults.standard

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        func value(_ key: String) -> String? {
            // An unset build setting reaches Info.plist as an empty string.
            (info[key] as? String).flatMap { $0.isEmpty ? nil : $0 }
        }
        endpoint = defaults.string(forKey: "endpoint") ?? value("NonGrataDemoEndpoint") ?? ""
        appId = defaults.string(forKey: "appId") ?? value("NonGrataDemoAppId") ?? "demo"
        hashPrefix = defaults.string(forKey: "hashPrefix") ?? value("NonGrataDemoHashPrefix") ?? "demo-ban-v1"
        apply()
    }

    /// Rebuilds `NonGrata` from the current settings. Its state (installId, local block flag)
    /// lives in the Keychain, so it survives this and app restarts.
    func apply() {
        defaults.set(endpoint, forKey: "endpoint")
        defaults.set(appId, forKey: "appId")
        defaults.set(hashPrefix, forKey: "hashPrefix")
        guard let url = URL(string: endpoint), url.scheme == "https" else {
            nonGrata = nil
            return
        }
        nonGrata = NonGrata(configuration: .init(endpoint: url, appId: appId, hashPrefix: hashPrefix))
    }

    var isConfigured: Bool { nonGrata != nil }

    /// Generates (and discards) one DeviceCheck token. The SDK silently sends no tokens when
    /// this fails, and the Worker then decides with its D1 list only.
    func testDeviceCheck() async {
        guard DCDevice.current.isSupported else {
            deviceCheckStatus = "not supported on this device (the Simulator never is)"
            print("[NonGrataDemo] DeviceCheck: \(deviceCheckStatus)")
            return
        }
        do {
            let token = try await DCDevice.current.generateToken()
            deviceCheckStatus = "token OK (\(token.count) bytes)"
        } catch {
            deviceCheckStatus = "token failed: \(error.localizedDescription)"
        }
        print("[NonGrataDemo] DeviceCheck: \(deviceCheckStatus)")
    }

    func check(_ intent: CheckIntent) async {
        guard let nonGrata, !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        let verdict = await nonGrata.check(intent: intent, userId: intent == .login ? userId : nil)
        let permitted = intent == .signup ? nonGrata.permits(verdict, for: .signup) : nil
        history.insert(Entry(date: .now, intent: intent, verdict: verdict, permitted: permitted), at: 0)
        print("[NonGrataDemo] check \(intent.rawValue): \(verdict) installId=\(nonGrata.installId ?? "-")")
        if history.count > 20 { history.removeLast() }
    }

    /// Admin commands for this device, ready to paste in a terminal at the repo root.
    var banCommand: String? {
        nonGrata?.installId.map { "pnpm ng ban app=\(appId) kind=install value=\($0) note=\"demo\"" }
    }

    var unbanCommand: String? {
        nonGrata?.supportCode.map { "pnpm ng unban app=\(appId) ref=\($0)" }
    }
}
