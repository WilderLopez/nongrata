import NonGrata
import Foundation
import Testing

private struct Vector: Decodable, Sendable, CustomTestStringConvertible {
    let prefix: String
    let kind: String
    let value: String
    let hash: String
    let ref: String

    var testDescription: String { "\(prefix):\(kind):\(value)" }
}

private struct VectorFile: Decodable {
    let vectors: [Vector]
}

/// Vectors shared with the Worker (`spec/hash-vectors.json`, at the repo root).
private let vectors: [Vector] = {
    let url = URL(filePath: #filePath)
        .deletingLastPathComponent() // NonGrataTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // swift
        .deletingLastPathComponent() // repo root
        .appending(path: "spec/hash-vectors.json")
    do {
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).vectors
    } catch {
        fatalError("Couldn't read the vectors at \(url.path()): \(error)")
    }
}()

@Suite("IdentifierHasher")
struct IdentifierHasherTests {
    @Test("Matches the shared vectors", arguments: vectors)
    fileprivate func matchesSharedVectors(_ vector: Vector) throws {
        let kind = try #require(IdentifierKind(rawValue: vector.kind))
        let hash = IdentifierHasher(prefix: vector.prefix).hash(kind, vector.value)
        #expect(hash == vector.hash)
        #expect(IdentifierHasher.ref(installHash: hash) == vector.ref)
    }

    @Test("Different kinds give different hashes for the same value")
    func kindsAreSeparated() {
        let hasher = IdentifierHasher(prefix: "p")
        #expect(hasher.hash(.idfv, "X") != hasher.hash(.install, "X"))
    }
}
