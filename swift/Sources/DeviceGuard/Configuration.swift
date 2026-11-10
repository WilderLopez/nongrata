import Foundation

public struct DeviceGuardConfiguration: Sendable {
    public enum DeviceCheckEnvironment: String, Sendable {
        case development
        case production
    }

    /// URL completa de `POST /v1/device/check`.
    public var endpoint: URL
    /// Identificador de la app en el Worker, por ejemplo `"myapp"`.
    public var appId: String
    /// Igual que `HASH_PREFIX_<APP>` del Worker, por ejemplo `"myapp-ban-v1"`.
    public var hashPrefix: String
    /// Usa el ID de iCloud y la marca en `NSUbiquitousKeyValueStore`. Requiere CloudKit y el
    /// entitlement de key-value storage en el App ID.
    public var useICloud: Bool
    /// Con `intent = .signup`, crear la cuenta exige que la comprobación termine en `.allowed`.
    public var strictSignup: Bool
    /// Intervalo mínimo entre comprobaciones al volver a primer plano mientras no hay bloqueo.
    public var foregroundInterval: Duration
    /// Tiempo máximo de la petición al Worker y de la generación de tokens.
    public var timeout: Duration
    /// Tiempo máximo para leer el ID de iCloud; la primera consulta puede tardar.
    public var iCloudTimeout: Duration
    /// `kSecAttrService` de los ítems del SDK. La app no debe borrarlos en su limpieza de
    /// primera ejecución.
    public var keychainService: String
    /// Endpoint de DeviceCheck que usa el Worker. TestFlight y App Store usan producción
    /// (por verificar, docs/HANDOFF.md sección 16).
    public var deviceCheckEnvironment: DeviceCheckEnvironment

    public init(
        endpoint: URL,
        appId: String,
        hashPrefix: String,
        useICloud: Bool = false,
        strictSignup: Bool = true,
        foregroundInterval: Duration = .seconds(6 * 3600),
        timeout: Duration = .seconds(5),
        iCloudTimeout: Duration = .seconds(2),
        keychainService: String = "device-guard",
        deviceCheckEnvironment: DeviceCheckEnvironment = Self.defaultDeviceCheckEnvironment
    ) {
        self.endpoint = endpoint
        self.appId = appId
        self.hashPrefix = hashPrefix
        self.useICloud = useICloud
        self.strictSignup = strictSignup
        self.foregroundInterval = foregroundInterval
        self.timeout = timeout
        self.iCloudTimeout = iCloudTimeout
        self.keychainService = keychainService
        self.deviceCheckEnvironment = deviceCheckEnvironment
    }

    public static var defaultDeviceCheckEnvironment: DeviceCheckEnvironment {
        #if DEBUG
            .development
        #else
            .production
        #endif
    }
}

public enum CheckIntent: String, Sendable, CaseIterable {
    case launch
    case foreground
    case login
    case signup
}

public enum DeviceGuardVerdict: Sendable, Equatable {
    case allowed
    case blocked(ref: String)
    /// No se pudo comprobar y no hay marca local.
    case unknown
}
