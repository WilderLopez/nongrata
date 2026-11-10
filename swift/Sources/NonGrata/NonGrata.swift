import Foundation
import Observation

/// Asks the Worker whether this device is blocked and remembers the verdict.
///
/// - Fail-open: if the check fails and there is no local mark, the verdict is `.unknown` and the
///   app carries on, except for signup in strict mode (`permits(_:for:)`).
/// - The local mark (Keychain and, with `useICloud`, `NSUbiquitousKeyValueStore`) is only set by
///   a `blocked` from the Worker and only cleared by an `ok`. An error leaves it untouched.
/// - The SDK shows no UI and never closes the app: the app draws its own blocking screen.
@MainActor
@Observable
public final class NonGrata {
    public private(set) var verdict: NonGrataVerdict
    /// The SDK's own UUID, stored in the Keychain, for analytics and support. `nil` only if the
    /// Keychain was unavailable (before first unlock); it is retried on every check.
    public private(set) var installId: String?
    /// Hash of the iCloud ID, once it has been read.
    public private(set) var iCloudIdHash: String?

    @ObservationIgnored private let configuration: NonGrataConfiguration
    @ObservationIgnored private let hasher: IdentifierHasher
    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private var lastAllowedAt: Date?
    @ObservationIgnored private var generation = 0

    public convenience init(configuration: NonGrataConfiguration) {
        self.init(configuration: configuration, dependencies: .system(configuration))
    }

    init(configuration: NonGrataConfiguration, dependencies: Dependencies) {
        self.configuration = configuration
        self.hasher = IdentifierHasher(prefix: configuration.hashPrefix)
        self.dependencies = dependencies
        self.verdict = .unknown
        self.installId = try? Self.loadOrCreateInstallId(in: dependencies.secureStore)
        if let ref = localMarkRef() {
            verdict = .blocked(ref: ref)
        }
        observeCloudMark()
    }

    /// This device's support code (`ref`).
    public var supportCode: String? {
        installId.map { IdentifierHasher.ref(installHash: hasher.hash(.install, $0)) }
    }

    /// Checks with the Worker. With `.foreground` it does nothing if the last check that returned
    /// `.allowed` was less than `foregroundInterval` ago; while blocked it always checks, so it
    /// can detect an unban.
    @discardableResult
    public func check(intent: CheckIntent, userId: String? = nil) async -> NonGrataVerdict {
        if intent == .foreground, verdict == .allowed, let lastAllowedAt,
           dependencies.now().timeIntervalSince(lastAllowedAt) < configuration.foregroundInterval.timeInterval
        {
            return verdict
        }

        generation += 1
        let current = generation
        let response = await performCheck(intent: intent, userId: userId)
        // If another check started in the meantime, that one wins.
        guard current == generation else { return verdict }
        apply(response)
        return verdict
    }

    /// Whether the app may proceed with `intent` given a verdict. `.unknown` lets it proceed
    /// (fail-open), except `.signup` with `strictSignup`.
    public func permits(_ verdict: NonGrataVerdict, for intent: CheckIntent) -> Bool {
        switch verdict {
        case .allowed: true
        case .blocked: false
        case .unknown: !(intent == .signup && configuration.strictSignup)
        }
    }

    // MARK: - Check

    private func performCheck(intent: CheckIntent, userId: String?) async -> CheckResponse? {
        if installId == nil {
            installId = try? Self.loadOrCreateInstallId(in: dependencies.secureStore)
        }
        guard let installId else { return nil }

        async let tokens = deviceTokens()
        async let icloud = iCloudHash()
        let installHash = hasher.hash(.install, installId)

        let payload = await CheckPayload(
            app: configuration.appId,
            dcToken: tokens.query,
            dcTokenUpdate: tokens.update,
            env: configuration.deviceCheckEnvironment.rawValue,
            ref: IdentifierHasher.ref(installHash: installHash),
            ids: .init(
                idfv: dependencies.identity.vendorIdentifier().map { hasher.hash(.idfv, $0) },
                install: installHash,
                icloud: icloud,
                user: userId.map { hasher.hash(.user, $0) }
            ),
            intent: intent.rawValue,
            platform: "ios",
            appVersion: dependencies.identity.appVersion()
        )

        do {
            return try await dependencies.transport.send(
                payload, to: configuration.endpoint, timeout: configuration.timeout
            )
        } catch {
            return nil
        }
    }

    /// Two tokens: one to query the bits and one to update them (Apple asks not to reuse tokens).
    private func deviceTokens() async -> (query: String?, update: String?) {
        guard dependencies.tokens.isSupported else { return (nil, nil) }
        async let query = deviceToken()
        async let update = deviceToken()
        let first = await query
        let second = await update
        return first == nil ? (second, nil) : (first, second)
    }

    private func deviceToken() async -> String? {
        let provider = dependencies.tokens
        return await withTimeout(configuration.timeout) {
            try? await provider.generateToken().base64EncodedString()
        } ?? nil
    }

    private func iCloudHash() async -> String? {
        guard configuration.useICloud else { return nil }
        if let iCloudIdHash { return iCloudIdHash }
        // If the timeout expires, the read keeps going and leaves the hash ready for the next check.
        return await withTimeout(configuration.iCloudTimeout) { [weak self] () -> String? in
            guard let self, let name = await dependencies.identity.iCloudRecordName() else { return nil }
            let hash = hasher.hash(.icloud, name)
            iCloudIdHash = hash
            return hash
        } ?? nil
    }

    private func apply(_ response: CheckResponse?) {
        switch response?.status {
        case .ok:
            setLocalMark(nil)
            lastAllowedAt = dependencies.now()
            verdict = .allowed
        case .blocked:
            let ref = response!.ref
            setLocalMark(ref)
            verdict = .blocked(ref: ref)
        case nil:
            verdict = localMarkRef().map { .blocked(ref: $0) } ?? .unknown
        }
    }

    // MARK: - Local mark

    private static let installIdKey = "installId"
    private static let blockedRefKey = "blockedRef"
    private var cloudMarkKey: String { "nongrata.\(configuration.appId).blockedRef" }

    /// Only creates a new `installId` if none exists; if the Keychain fails, it throws so the
    /// existing one is never overwritten.
    private static func loadOrCreateInstallId(in store: any SecureStore) throws(SecureStoreError) -> String {
        if let existing = try store.string(forKey: installIdKey) { return existing }
        let created = UUID().uuidString
        try store.set(created, forKey: installIdKey)
        return created
    }

    private func localMarkRef() -> String? {
        if let ref = try? dependencies.secureStore.string(forKey: Self.blockedRefKey) { return ref }
        guard configuration.useICloud, let cloud = dependencies.cloudStore else { return nil }
        return cloud.string(forKey: cloudMarkKey)
    }

    private func setLocalMark(_ ref: String?) {
        if let ref {
            try? dependencies.secureStore.set(ref, forKey: Self.blockedRefKey)
        } else {
            try? dependencies.secureStore.removeValue(forKey: Self.blockedRefKey)
        }
        if configuration.useICloud {
            dependencies.cloudStore?.set(ref, forKey: cloudMarkKey)
        }
    }

    /// Blocks live if another device signed in to the same Apple account sets the mark.
    /// The loop ends on the first change after `NonGrata` is deallocated.
    private func observeCloudMark() {
        guard configuration.useICloud, let cloud = dependencies.cloudStore else { return }
        let changes = cloud.externalChanges()
        let key = cloudMarkKey
        Task { [weak self] in
            for await _ in changes {
                guard let self else { return }
                if let ref = cloud.string(forKey: key), verdict != .blocked(ref: ref) {
                    verdict = .blocked(ref: ref)
                }
            }
        }
    }
}

// MARK: - Dependencies

struct Dependencies {
    var secureStore: any SecureStore
    var cloudStore: (any CloudFlagStore)?
    var tokens: any DeviceTokenProvider
    var identity: any DeviceIdentity
    var transport: any CheckTransport
    var now: @MainActor () -> Date

    @MainActor
    static func system(_ configuration: NonGrataConfiguration) -> Dependencies {
        Dependencies(
            secureStore: KeychainStore(service: configuration.keychainService),
            cloudStore: configuration.useICloud ? UbiquitousFlagStore() : nil,
            tokens: AppleDeviceTokenProvider(),
            identity: SystemDeviceIdentity(),
            transport: URLSessionCheckTransport(),
            now: { Date() }
        )
    }
}

// MARK: - Utilities

extension Duration {
    var timeInterval: TimeInterval {
        let (seconds, attoseconds) = components
        return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
    }
}

/// Returns the result of `operation`, or `nil` if `timeout` expires first. The operation is not
/// cancelled: it keeps running in the background (CloudKit, for example, doesn't always honor
/// cancellation).
@MainActor
func withTimeout<T: Sendable>(
    _ timeout: Duration,
    _ operation: @escaping @MainActor () async -> T
) async -> T? {
    let gate = ResumeGate<T?>()
    return await withCheckedContinuation { continuation in
        gate.continuation = continuation
        Task { @MainActor in gate.resume(await operation()) }
        gate.timer = Task { @MainActor in
            try? await Task.sleep(for: timeout)
            gate.resume(nil)
        }
    }
}

@MainActor
private final class ResumeGate<T: Sendable> {
    var continuation: CheckedContinuation<T, Never>?
    var timer: Task<Void, Never>?

    func resume(_ value: T) {
        guard let continuation else { return }
        self.continuation = nil
        timer?.cancel()
        continuation.resume(returning: value)
    }
}
