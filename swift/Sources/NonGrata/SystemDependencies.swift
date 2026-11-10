import CloudKit
import DeviceCheck
import Foundation
import Security
#if canImport(UIKit)
    import UIKit
#endif

// Implementaciones reales de los protocolos de Dependencies.swift.

struct KeychainStore: SecureStore {
    let service: String

    func string(forKey key: String) throws(SecureStoreError) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            return (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
        case errSecItemNotFound:
            return nil
        default:
            throw .unavailable(status)
        }
    }

    func set(_ value: String, forKey key: String) throws(SecureStoreError) {
        let data = Data(value.utf8)
        let update = SecItemUpdate(
            baseQuery(key) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw .unavailable(update) }

        var add = baseQuery(key)
        add[kSecValueData as String] = data
        // Tras el primer desbloqueo y sin migrar a otro dispositivo por copia de seguridad.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw .unavailable(status) }
    }

    func removeValue(forKey key: String) throws(SecureStoreError) {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .unavailable(status) }
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

/// Requiere el entitlement `com.apple.developer.ubiquity-kvstore-identifier`.
struct UbiquitousFlagStore: CloudFlagStore {
    func string(forKey key: String) -> String? {
        NSUbiquitousKeyValueStore.default.string(forKey: key)
    }

    func set(_ value: String?, forKey key: String) {
        let store = NSUbiquitousKeyValueStore.default
        if let value {
            store.set(value, forKey: key)
        } else {
            store.removeObject(forKey: key)
        }
        store.synchronize()
    }

    func externalChanges() -> AsyncStream<Void> {
        // Pide a iCloud los cambios pendientes desde el último arranque.
        NSUbiquitousKeyValueStore.default.synchronize()
        let name = NSUbiquitousKeyValueStore.didChangeExternallyNotification
        return AsyncStream { continuation in
            let task = Task { @MainActor in
                for await _ in NotificationCenter.default.notifications(named: name).map({ _ in () }) {
                    continuation.yield()
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

struct AppleDeviceTokenProvider: DeviceTokenProvider {
    var isSupported: Bool { DCDevice.current.isSupported }

    func generateToken() async throws -> Data {
        try await DCDevice.current.generateToken()
    }
}

struct SystemDeviceIdentity: DeviceIdentity {
    func vendorIdentifier() -> String? {
        #if canImport(UIKit)
            UIDevice.current.identifierForVendor?.uuidString
        #else
            nil
        #endif
    }

    /// Solo se llama con `useICloud`: `CKContainer.default()` falla si la app no tiene CloudKit.
    func iCloudRecordName() async -> String? {
        try? await CKContainer.default().userRecordID().recordName
    }

    func appVersion() -> String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }
}

struct URLSessionCheckTransport: CheckTransport {
    enum TransportError: Error {
        case status(Int)
    }

    private static let session = URLSession(configuration: .ephemeral)

    func send(_ payload: CheckPayload, to endpoint: URL, timeout: Duration) async throws -> CheckResponse {
        var request = URLRequest(
            url: endpoint,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: timeout.timeInterval
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await Self.session.data(for: request)
        // Contrato: solo un 200 con { status, ref } es una respuesta válida.
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw TransportError.status(status) }
        return try JSONDecoder().decode(CheckResponse.self, from: data)
    }
}
