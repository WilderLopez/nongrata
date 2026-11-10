import NonGrata

extension NonGrataVerdict {
    /// The `ref`, only with `.blocked`. `.unknown` doesn't block: it is the SDK's fail-open.
    var blockedRef: String? {
        if case .blocked(let ref) = self { ref } else { nil }
    }
}
