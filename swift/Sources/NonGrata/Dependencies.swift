import Foundation

// Everything that touches the system sits behind these protocols so `NonGrata` can be
// tested without Keychain, iCloud, DeviceCheck or network. They are always used from the
// main actor, like `NonGrata`.

enum SecureStoreError: Error, Equatable {
    /// The Keychain is unavailable (for example, after a reboot and before first unlock).
    case unavailable(OSStatus)
}

/// Keychain: survives reinstalling the app (observed behavior, not guaranteed by Apple).
@MainActor
protocol SecureStore: Sendable {
    /// `nil` if it doesn't exist. Throws if the Keychain couldn't be read.
    func string(forKey key: String) throws(SecureStoreError) -> String?
    func set(_ value: String, forKey key: String) throws(SecureStoreError)
    func removeValue(forKey key: String) throws(SecureStoreError)
}

/// `NSUbiquitousKeyValueStore`: syncs to other devices signed in to the same Apple account.
@MainActor
protocol CloudFlagStore: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
    /// Emits when another device changes the store.
    func externalChanges() -> AsyncStream<Void>
}

/// DeviceCheck.
@MainActor
protocol DeviceTokenProvider: Sendable {
    var isSupported: Bool { get }
    func generateToken() async throws -> Data
}

@MainActor
protocol DeviceIdentity: Sendable {
    /// `identifierForVendor`; `nil` after a reboot and before unlock.
    func vendorIdentifier() -> String?
    /// `recordName` of the iCloud user in the default container; `nil` without an account.
    func iCloudRecordName() async -> String?
    func appVersion() -> String?
}

@MainActor
protocol CheckTransport: Sendable {
    func send(_ payload: CheckPayload, to endpoint: URL, timeout: Duration) async throws -> CheckResponse
}

struct CheckPayload: Encodable, Equatable, Sendable {
    struct Ids: Encodable, Equatable, Sendable {
        var idfv: String?
        var install: String
        var icloud: String?
        var user: String?

        // Nil keys are sent as an explicit `null`, as the contract specifies.
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(idfv, forKey: .idfv)
            try c.encode(install, forKey: .install)
            try c.encode(icloud, forKey: .icloud)
            try c.encode(user, forKey: .user)
        }

        private enum CodingKeys: String, CodingKey {
            case idfv, install, icloud, user
        }
    }

    var app: String
    var dcToken: String?
    var dcTokenUpdate: String?
    var env: String
    var ref: String
    var ids: Ids
    var intent: String
    var platform: String
    var appVersion: String?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(app, forKey: .app)
        try c.encode(dcToken, forKey: .dcToken)
        try c.encode(dcTokenUpdate, forKey: .dcTokenUpdate)
        try c.encode(env, forKey: .env)
        try c.encode(ref, forKey: .ref)
        try c.encode(ids, forKey: .ids)
        try c.encode(intent, forKey: .intent)
        try c.encode(platform, forKey: .platform)
        try c.encode(appVersion, forKey: .appVersion)
    }

    private enum CodingKeys: String, CodingKey {
        case app
        case dcToken = "dc_token"
        case dcTokenUpdate = "dc_token_update"
        case env, ref, ids, intent, platform
        case appVersion = "app_version"
    }
}

struct CheckResponse: Decodable, Equatable, Sendable {
    enum Status: String, Decodable, Sendable {
        case ok
        case blocked
    }

    var status: Status
    var ref: String
}
