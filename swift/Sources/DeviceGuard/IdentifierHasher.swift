import CryptoKit
import Foundation

/// Tipos de identificador que manda el SDK de iOS. `android_id` solo existe en el Worker.
public enum IdentifierKind: String, Sendable, CaseIterable {
    case idfv
    case install
    case icloud
    case user
}

/// Misma fórmula que el Worker y la CLI: `SHA256(prefix + ":" + kind + ":" + valor normalizado)`
/// en hex minúsculas. `spec/hash-vectors.json` fija el resultado.
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

    /// Igual que `normalizeValue` del Worker: quita espacio, `\t`, `\n` y `\r` de los extremos y,
    /// en los UUID (`idfv`, `install`), pasa a mayúsculas solo a-z. Va por escalares Unicode
    /// porque en Swift `"\r\n"` es un único `Character`.
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

    /// Código de soporte: primeros 8 caracteres, en mayúsculas, del hash de `installId`.
    public static func ref(installHash: String) -> String {
        String(installHash.prefix(8)).uppercased()
    }
}
