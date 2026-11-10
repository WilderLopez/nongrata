import CloudKit
import DeviceCheck
import Foundation
import Security
#if canImport(UIKit)
    import UIKit
#endif

// Real implementations of the protocols in Dependencies.swift.

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
        // Readable after first unlock, and never migrated to another device through a backup.
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

/// Requires the `com.apple.developer.ubiquity-kvstore-identifier` entitlement.
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
        // Asks iCloud for the changes pending since the last launch.
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

    /// Only called with `useICloud`: `CKContainer.default()` fails if the app lacks CloudKit.
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
        // Contract: only a 200 with { status, ref } is a valid response.
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw TransportError.status(status) }
        return try JSONDecoder().decode(CheckResponse.self, from: data)
    }
}
