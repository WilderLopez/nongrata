@testable import NonGrata
import Foundation

@MainActor
final class MemorySecureStore: SecureStore {
    var values: [String: String] = [:]
    var unavailable = false

    func string(forKey key: String) throws(SecureStoreError) -> String? {
        if unavailable { throw .unavailable(errSecInteractionNotAllowed) }
        return values[key]
    }

    func set(_ value: String, forKey key: String) throws(SecureStoreError) {
        if unavailable { throw .unavailable(errSecInteractionNotAllowed) }
        values[key] = value
    }

    func removeValue(forKey key: String) throws(SecureStoreError) {
        if unavailable { throw .unavailable(errSecInteractionNotAllowed) }
        values[key] = nil
    }
}

@MainActor
final class MemoryCloudStore: CloudFlagStore {
    var values: [String: String] = [:]
    private var continuation: AsyncStream<Void>.Continuation?

    func string(forKey key: String) -> String? { values[key] }

    func set(_ value: String?, forKey key: String) { values[key] = value }

    func externalChanges() -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        self.continuation = continuation
        return stream
    }

    /// Another device signed in to the same Apple account changes the store.
    func simulateExternalChange(_ value: String?, forKey key: String) {
        values[key] = value
        continuation?.yield()
    }
}

@MainActor
final class FakeTokens: DeviceTokenProvider {
    var isSupported = true
    var failing = false
    private(set) var generated = 0

    func generateToken() async throws -> Data {
        if failing { throw URLError(.cannotConnectToHost) }
        generated += 1
        return Data("token-\(generated)".utf8)
    }
}

/// A gate the test opens when it wants an async operation to finish.
@MainActor
final class Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

@MainActor
final class FakeIdentity: DeviceIdentity {
    var idfv: String? = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F"
    var iCloudName: String? = "_2a3b4c5d6e7f8091a2b3c4d5e6f70819"
    var iCloudGate: Gate?
    var version: String? = "1.2.3"

    func vendorIdentifier() -> String? { idfv }

    func iCloudRecordName() async -> String? {
        await iCloudGate?.wait()
        return iCloudName
    }

    func appVersion() -> String? { version }
}

@MainActor
final class FakeTransport: CheckTransport {
    enum Mode {
        case ok
        case blocked
        case failing
    }

    var mode: Mode = .ok
    /// If set, the next request waits for it to open before responding.
    var nextGate: Gate?
    private(set) var payloads: [CheckPayload] = []

    func send(_ payload: CheckPayload, to endpoint: URL, timeout: Duration) async throws -> CheckResponse {
        payloads.append(payload)
        let mode = mode // the mode at the time the request arrived
        if let gate = nextGate {
            nextGate = nil
            await gate.wait()
        }
        switch mode {
        case .ok: return CheckResponse(status: .ok, ref: payload.ref)
        case .blocked: return CheckResponse(status: .blocked, ref: payload.ref)
        case .failing: throw URLError(.timedOut)
        }
    }
}

@MainActor
final class TestClock {
    var now = Date(timeIntervalSince1970: 1_800_000_000)

    func advance(by duration: Duration) {
        now += duration.timeInterval
    }
}

/// A test "device": its stores survive creating another `NonGrata` (relaunching the app).
@MainActor
final class TestDevice {
    let secureStore = MemorySecureStore()
    let cloudStore = MemoryCloudStore()
    let tokens = FakeTokens()
    let identity = FakeIdentity()
    let transport = FakeTransport()
    let clock = TestClock()

    static let endpoint = URL(string: "https://guard.test/v1/device/check")!

    func configuration(
        useICloud: Bool = false,
        strictSignup: Bool = true,
        iCloudTimeout: Duration = .seconds(2)
    ) -> NonGrataConfiguration {
        NonGrataConfiguration(
            endpoint: Self.endpoint,
            appId: "myapp",
            hashPrefix: "myapp-ban-v1",
            useICloud: useICloud,
            strictSignup: strictSignup,
            foregroundInterval: .seconds(3600),
            iCloudTimeout: iCloudTimeout,
            deviceCheckEnvironment: .production
        )
    }

    func launch(_ configuration: NonGrataConfiguration? = nil) -> NonGrata {
        NonGrata(
            configuration: configuration ?? self.configuration(),
            dependencies: Dependencies(
                secureStore: secureStore,
                cloudStore: cloudStore,
                tokens: tokens,
                identity: identity,
                transport: transport,
                now: { [clock] in clock.now }
            )
        )
    }
}

/// Yields until `condition` holds (for tasks the SDK launches on its own).
@MainActor
func settle(until condition: () -> Bool) async {
    for _ in 0..<1000 where !condition() {
        await Task.yield()
    }
}
