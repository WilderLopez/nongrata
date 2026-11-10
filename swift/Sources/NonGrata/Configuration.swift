import Foundation

public struct NonGrataConfiguration: Sendable {
    public enum DeviceCheckEnvironment: String, Sendable {
        case development
        case production
    }

    /// Full URL of `POST /v1/device/check`.
    public var endpoint: URL
    /// The app's identifier in the Worker, for example `"myapp"`.
    public var appId: String
    /// Same as the Worker's `HASH_PREFIX_<APP>`, for example `"myapp-ban-v1"`.
    public var hashPrefix: String
    /// Uses the iCloud ID and the mark in `NSUbiquitousKeyValueStore`. Requires CloudKit and the
    /// key-value storage entitlement on the App ID.
    public var useICloud: Bool
    /// With `intent = .signup`, creating the account requires the check to end in `.allowed`.
    public var strictSignup: Bool
    /// Minimum interval between checks on returning to the foreground while not blocked.
    public var foregroundInterval: Duration
    /// Maximum time for the Worker request and for token generation.
    public var timeout: Duration
    /// Maximum time to read the iCloud ID; the first lookup can be slow.
    public var iCloudTimeout: Duration
    /// `kSecAttrService` of the SDK's Keychain items. The app must not delete them in its
    /// first-run cleanup.
    public var keychainService: String
    /// DeviceCheck endpoint the Worker uses. TestFlight and the App Store use production
    /// (to be verified, docs/DESIGN.md section 16).
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
        keychainService: String = "nongrata",
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

public enum NonGrataVerdict: Sendable, Equatable {
    case allowed
    case blocked(ref: String)
    /// The check couldn't complete and there is no local mark.
    case unknown
}
