import Foundation
import Observation

/// Comprueba con el Worker si este dispositivo está bloqueado y recuerda el veredicto.
///
/// - Fail-open: si la comprobación falla y no hay marca local, el veredicto es `.unknown` y la
///   app sigue, salvo el registro en modo estricto (`permits(_:for:)`).
/// - La marca local (Keychain y, con `useICloud`, `NSUbiquitousKeyValueStore`) solo la pone un
///   `blocked` del Worker y solo la quita un `ok`. Un error no la toca.
/// - El SDK no presenta interfaz ni cierra la app: la app pinta su pantalla de bloqueo.
@MainActor
@Observable
public final class DeviceGuard {
    public private(set) var verdict: DeviceGuardVerdict
    /// UUID propio guardado en el Keychain, para analítica y soporte. `nil` solo si el Keychain
    /// no estaba disponible (antes del primer desbloqueo); se reintenta en cada comprobación.
    public private(set) var installId: String?
    /// Hash del ID de iCloud, cuando ya se ha leído.
    public private(set) var iCloudIdHash: String?

    @ObservationIgnored private let configuration: DeviceGuardConfiguration
    @ObservationIgnored private let hasher: IdentifierHasher
    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private var lastAllowedAt: Date?
    @ObservationIgnored private var generation = 0

    public convenience init(configuration: DeviceGuardConfiguration) {
        self.init(configuration: configuration, dependencies: .system(configuration))
    }

    init(configuration: DeviceGuardConfiguration, dependencies: Dependencies) {
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

    /// Código de soporte (`ref`) de este dispositivo.
    public var supportCode: String? {
        installId.map { IdentifierHasher.ref(installHash: hasher.hash(.install, $0)) }
    }

    /// Comprueba con el Worker. Con `.foreground` no hace nada si la última comprobación con
    /// `.allowed` es de hace menos de `foregroundInterval`; si está bloqueado, comprueba siempre
    /// para detectar el desbaneo.
    @discardableResult
    public func check(intent: CheckIntent, userId: String? = nil) async -> DeviceGuardVerdict {
        if intent == .foreground, verdict == .allowed, let lastAllowedAt,
           dependencies.now().timeIntervalSince(lastAllowedAt) < configuration.foregroundInterval.timeInterval
        {
            return verdict
        }

        generation += 1
        let current = generation
        let response = await performCheck(intent: intent, userId: userId)
        // Si empezó otra comprobación mientras tanto, esa es la que manda.
        guard current == generation else { return verdict }
        apply(response)
        return verdict
    }

    /// Si la app puede seguir con `intent` dado un veredicto. `.unknown` deja seguir (fail-open)
    /// salvo `.signup` con `strictSignup`.
    public func permits(_ verdict: DeviceGuardVerdict, for intent: CheckIntent) -> Bool {
        switch verdict {
        case .allowed: true
        case .blocked: false
        case .unknown: !(intent == .signup && configuration.strictSignup)
        }
    }

    // MARK: - Comprobación

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

    /// Dos tokens: uno para consultar los bits y otro para escribirlos (Apple pide no reutilizarlos).
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
        // Si vence el plazo, la lectura sigue y deja el hash listo para la siguiente comprobación.
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

    // MARK: - Marca local

    private static let installIdKey = "installId"
    private static let blockedRefKey = "blockedRef"
    private var cloudMarkKey: String { "deviceguard.\(configuration.appId).blockedRef" }

    /// Solo crea un `installId` nuevo si no existe; si el Keychain falla, lanza para no pisarlo.
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

    /// Bloquea en caliente si otro dispositivo con la misma cuenta de Apple pone la marca.
    /// El bucle termina en el siguiente cambio después de liberar `DeviceGuard`.
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

// MARK: - Dependencias

struct Dependencies {
    var secureStore: any SecureStore
    var cloudStore: (any CloudFlagStore)?
    var tokens: any DeviceTokenProvider
    var identity: any DeviceIdentity
    var transport: any CheckTransport
    var now: @MainActor () -> Date

    @MainActor
    static func system(_ configuration: DeviceGuardConfiguration) -> Dependencies {
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

// MARK: - Utilidades

extension Duration {
    var timeInterval: TimeInterval {
        let (seconds, attoseconds) = components
        return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
    }
}

/// Devuelve el resultado de `operation` o `nil` si vence `timeout`. La operación no se cancela:
/// sigue en segundo plano (por ejemplo, CloudKit no siempre atiende la cancelación).
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
