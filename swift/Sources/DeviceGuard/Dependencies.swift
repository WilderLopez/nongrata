import Foundation

// Todo lo que toca el sistema queda detrás de estos protocolos para poder probar
// `DeviceGuard` sin Keychain, iCloud, DeviceCheck ni red. Se usan siempre desde el
// main actor, igual que `DeviceGuard`.

enum SecureStoreError: Error, Equatable {
    /// El Keychain no está disponible (por ejemplo, tras reiniciar y antes del primer desbloqueo).
    case unavailable(OSStatus)
}

/// Keychain: sobrevive a reinstalar (comportamiento observado, no garantizado por Apple).
@MainActor
protocol SecureStore: Sendable {
    /// `nil` si no existe. Lanza si el Keychain no se pudo leer.
    func string(forKey key: String) throws(SecureStoreError) -> String?
    func set(_ value: String, forKey key: String) throws(SecureStoreError)
    func removeValue(forKey key: String) throws(SecureStoreError)
}

/// `NSUbiquitousKeyValueStore`: salta a los dispositivos con la misma cuenta de Apple.
@MainActor
protocol CloudFlagStore: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
    /// Emite cuando otro dispositivo cambia el almacén.
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
    /// `identifierForVendor`; `nil` tras reiniciar y antes de desbloquear.
    func vendorIdentifier() -> String?
    /// `recordName` del usuario de iCloud en el contenedor por defecto; `nil` sin cuenta.
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

        // Las claves nulas se mandan como `null` explícito, como en el contrato.
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
