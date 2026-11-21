package io.github.wilderlopez.nongrata

import java.security.MessageDigest

/** Identifier kinds the Android SDK sends. `idfv` and `icloud` are iOS only. */
public enum class IdentifierKind(public val wireValue: String) {
    INSTALL("install"),
    USER("user"),
    ANDROID_ID("android_id"),
}

/**
 * Same formula as the Worker, the CLI and the Swift SDK:
 * `SHA256(prefix + ":" + kind + ":" + normalized value)` in lowercase hex, over UTF-8.
 * `spec/hash-vectors.json` pins the result.
 */
public class IdentifierHasher(public val prefix: String) {
    public fun hash(kind: IdentifierKind, value: String): String {
        val input = "$prefix:${kind.wireValue}:${normalize(kind, value)}"
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val b = byte.toInt() and 0xff
            hex.append(HEX[b ushr 4]).append(HEX[b and 0x0f])
        }
        return hex.toString()
    }

    public companion object {
        private const val HEX = "0123456789abcdef"

        /** Support code: the first 8 characters, uppercased, of the `installId` hash. */
        @JvmStatic
        public fun ref(installHash: String): String = installHash.take(8).uppercase()

        /**
         * Same as the Worker's `normalizeValue`: trims space, `\t`, `\n` and `\r` from both ends;
         * `install` (a UUID) uppercases only a-z; `user` and `android_id` lowercase only A-Z.
         * Those four characters and the ASCII letters are single UTF-16 units, so working on
         * `Char`s leaves every other character, surrogate pairs included, untouched.
         */
        internal fun normalize(kind: IdentifierKind, value: String): String {
            var start = 0
            var end = value.length
            while (start < end && isEdge(value[start])) start++
            while (end > start && isEdge(value[end - 1])) end--

            val uppercase = kind == IdentifierKind.INSTALL
            val lowercase = kind == IdentifierKind.USER || kind == IdentifierKind.ANDROID_ID
            val result = StringBuilder(end - start)
            for (i in start until end) {
                val c = value[i]
                result.append(
                    when {
                        uppercase && c in 'a'..'z' -> c - 32
                        lowercase && c in 'A'..'Z' -> c + 32
                        else -> c
                    },
                )
            }
            return result.toString()
        }

        private fun isEdge(c: Char): Boolean = c == ' ' || c == '\t' || c == '\n' || c == '\r'
    }
}
