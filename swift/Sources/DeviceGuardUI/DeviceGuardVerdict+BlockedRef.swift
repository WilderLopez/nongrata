import DeviceGuard

extension DeviceGuardVerdict {
    /// El `ref` solo con `.blocked`. `.unknown` no bloquea: es el fail-open del SDK.
    var blockedRef: String? {
        if case .blocked(let ref) = self { ref } else { nil }
    }
}
