package io.github.wilderlopez.nongrata

/**
 * The little JSON the SDK needs: write the check's body and read its `{status, ref}` answer.
 * Its own instead of `org.json` because that one is a stub in local JVM unit tests, where all the
 * logic is tested.
 *
 * Values read: `Map<String, Any?>` for objects, `List<Any?>` for arrays, `String`, `Double` for
 * numbers, `Boolean` and `null`.
 */
internal object Json {
    class ParseException(message: String) : Exception(message)

    /** Nesting limit, so a hostile body cannot overflow the stack. */
    private const val MAX_DEPTH = 32

    fun parse(text: String): Any? {
        val parser = Parser(text)
        parser.skipWhitespace()
        val value = parser.value(0)
        parser.skipWhitespace()
        if (!parser.atEnd()) throw ParseException("Unexpected text after the value")
        return value
    }

    /** A JSON string literal, quotes included. */
    fun quote(value: String): String {
        val out = StringBuilder(value.length + 2).append('"')
        for (c in value) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else ->
                    if (c < ' ') {
                        out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                    } else {
                        out.append(c)
                    }
            }
        }
        return out.append('"').toString()
    }

    /** A string literal, or `null` for a missing value. */
    fun quoteOrNull(value: String?): String = value?.let(::quote) ?: "null"

    private class Parser(private val text: String) {
        private var pos = 0

        fun atEnd() = pos >= text.length

        fun skipWhitespace() {
            while (!atEnd() && text[pos].let { it == ' ' || it == '\t' || it == '\n' || it == '\r' }) pos++
        }

        fun value(depth: Int): Any? {
            if (depth > MAX_DEPTH) throw ParseException("Nested too deep")
            if (atEnd()) throw ParseException("Unexpected end")
            return when (val c = text[pos]) {
                '{' -> obj(depth + 1)
                '[' -> array(depth + 1)
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') number() else throw ParseException("Unexpected '$c'")
            }
        }

        private fun obj(depth: Int): Map<String, Any?> {
            pos++ // {
            val result = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (peek('}')) return result.also { pos++ }
            while (true) {
                skipWhitespace()
                if (!peek('"')) throw ParseException("Expected a key")
                val key = string()
                skipWhitespace()
                expect(':')
                skipWhitespace()
                result[key] = value(depth)
                skipWhitespace()
                if (peek(',')) {
                    pos++
                } else {
                    expect('}')
                    return result
                }
            }
        }

        private fun array(depth: Int): List<Any?> {
            pos++ // [
            val result = ArrayList<Any?>()
            skipWhitespace()
            if (peek(']')) return result.also { pos++ }
            while (true) {
                skipWhitespace()
                result.add(value(depth))
                skipWhitespace()
                if (peek(',')) {
                    pos++
                } else {
                    expect(']')
                    return result
                }
            }
        }

        private fun string(): String {
            pos++ // "
            val out = StringBuilder()
            while (true) {
                if (atEnd()) throw ParseException("Unterminated string")
                val c = text[pos++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (atEnd()) throw ParseException("Unterminated escape")
                        when (val e = text[pos++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (pos + 4 > text.length) throw ParseException("Short \\u escape")
                                val hex = text.substring(pos, pos + 4)
                                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
                                    throw ParseException("Bad \\u escape")
                                }
                                out.append(hex.toInt(16).toChar())
                                pos += 4
                            }
                            else -> throw ParseException("Bad escape '\\$e'")
                        }
                    }
                    c < ' ' -> throw ParseException("Control character in a string")
                    else -> out.append(c)
                }
            }
        }

        private fun number(): Double {
            val start = pos
            if (peek('-')) pos++
            if (peek('0')) {
                pos++
            } else {
                digits()
            }
            if (peek('.')) {
                pos++
                digits()
            }
            if (peek('e') || peek('E')) {
                pos++
                if (peek('+') || peek('-')) pos++
                digits()
            }
            return text.substring(start, pos).toDouble()
        }

        private fun digits() {
            val start = pos
            while (!atEnd() && text[pos] in '0'..'9') pos++
            if (pos == start) throw ParseException("Expected a digit")
        }

        private fun literal(word: String, value: Any?): Any? {
            if (!text.startsWith(word, pos)) throw ParseException("Expected $word")
            pos += word.length
            return value
        }

        private fun peek(c: Char) = !atEnd() && text[pos] == c

        private fun expect(c: Char) {
            if (!peek(c)) throw ParseException("Expected '$c'")
            pos++
        }
    }
}
