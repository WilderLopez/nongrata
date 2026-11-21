package io.github.wilderlopez.nongrata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class IdentifierHasherTest {
    private data class Vector(val prefix: String, val kind: IdentifierKind, val value: String, val hash: String, val ref: String)

    /**
     * Vectors shared with the Worker, the CLI and the Swift SDK, read from `spec/hash-vectors.json`
     * in the repo (the build passes its directory). From `vectors`, the kinds Android sends
     * (`install`, `user`); every one of `android_vectors`.
     */
    private val vectors: List<Vector> by lazy {
        val dir = System.getProperty("nongrata.specDir") ?: error("nongrata.specDir is not set")
        val root = Json.parse(File(dir, "hash-vectors.json").readText(Charsets.UTF_8)) as Map<*, *>
        val android = root["android_vectors"] as List<*>
        val shared = (root["vectors"] as List<*>).filter { (it as Map<*, *>)["kind"] in setOf("install", "user") }
        (shared + android).map {
            val v = it as Map<*, *>
            Vector(
                prefix = v["prefix"] as String,
                kind = IdentifierKind.entries.single { kind -> kind.wireValue == v["kind"] },
                value = v["value"] as String,
                hash = v["hash"] as String,
                ref = v["ref"] as String,
            )
        }
    }

    @Test
    fun `matches the shared vectors`() {
        // Guards against reading nothing: the file has 2 install, 7 user and 2 android_id vectors today.
        assertTrue(vectors.count { it.kind == IdentifierKind.INSTALL } >= 2)
        assertTrue(vectors.count { it.kind == IdentifierKind.USER } >= 7)
        assertTrue(vectors.count { it.kind == IdentifierKind.ANDROID_ID } >= 2)
        for (vector in vectors) {
            val hash = IdentifierHasher(vector.prefix).hash(vector.kind, vector.value)
            assertEquals(vector.toString(), vector.hash, hash)
            assertEquals(vector.toString(), vector.ref, IdentifierHasher.ref(hash))
        }
    }

    @Test
    fun `different kinds give different hashes for the same value`() {
        val hasher = IdentifierHasher("p")
        assertNotEquals(hasher.hash(IdentifierKind.USER, "x"), hasher.hash(IdentifierKind.ANDROID_ID, "x"))
        assertNotEquals(hasher.hash(IdentifierKind.USER, "X"), hasher.hash(IdentifierKind.INSTALL, "X"))
    }

    @Test
    fun `normalization trims only the four edge characters and maps only ASCII letters`() {
        assertEquals("ABC-ß", IdentifierHasher.normalize(IdentifierKind.INSTALL, " \t abc-ß\r\n"))
        assertEquals("josé Ñ", IdentifierHasher.normalize(IdentifierKind.USER, "JOSé Ñ"))
        assertEquals(" x ", IdentifierHasher.normalize(IdentifierKind.USER, " X "))
        assertEquals("3f9a", IdentifierHasher.normalize(IdentifierKind.ANDROID_ID, "\n3F9A "))
        assertEquals("", IdentifierHasher.normalize(IdentifierKind.ANDROID_ID, " \r\n\t"))
        assertEquals("😎a", IdentifierHasher.normalize(IdentifierKind.USER, "😎A"))
    }
}
