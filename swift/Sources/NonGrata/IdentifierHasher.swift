import CryptoKit
import Foundation

/// Identifier kinds the iOS SDK sends. `android_id` only exists in the Worker.
public enum IdentifierKind: String, Sendable, CaseIterable {
    case idfv
    case install
    case icloud
    case user
}

/// Same formula as the Worker and the CLI: `SHA256(prefix + ":" + kind + ":" + normalized value)`
/// in lowercase hex. `spec/hash-vectors.json` pins the result.
public struct IdentifierHasher: Sendable {
    public let prefix: String

    public init(prefix: String) {
        self.prefix = prefix
    }

    public func hash(_ kind: IdentifierKind, _ value: String) -> String {
        let normalized = Self.normalize(kind, value)
        let digest = SHA256.hash(data: Data("\(prefix):\(kind.rawValue):\(normalized)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Same as the Worker's `normalizeValue`: trims space, `\t`, `\n` and `\r` from both ends
    /// and, for UUIDs (`idfv`, `install`), uppercases only a-z. Works on Unicode scalars because
    /// in Swift `"\r\n"` is a single `Character`.
    static func normalize(_ kind: IdentifierKind, _ value: String) -> String {
        let edge: Set<Unicode.Scalar> = [" ", "\t", "\n", "\r"]
        var scalars = Array(value.unicodeScalars)[...]
        while let first = scalars.first, edge.contains(first) { scalars = scalars.dropFirst() }
        while let last = scalars.last, edge.contains(last) { scalars = scalars.dropLast() }

        let uppercase = kind == .idfv || kind == .install
        var result = String.UnicodeScalarView()
        for scalar in scalars {
            let isLowerASCII = ("a"..."z").contains(scalar)
            result.append(uppercase && isLowerASCII ? Unicode.Scalar(scalar.value - 32)! : scalar)
        }
        return String(result)
    }

    /// Support code: the first 8 characters, uppercased, of the `installId` hash.
    public static func ref(installHash: String) -> String {
        String(installHash.prefix(8)).uppercased()
    }
}
