package io.github.wilderlopez.nongrata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class JsonTest {
    @Test
    fun `parses every kind of value`() {
        val value = Json.parse(""" { "a" : [1, -2.5e2, true, false, null, {}], "b": "x\"\\\/\n\u00e9\ud83d\ude0e" } """)
        assertEquals(
            mapOf("a" to listOf(1.0, -250.0, true, false, null, emptyMap<String, Any?>()), "b" to "x\"\\/\né😎"),
            value,
        )
        assertEquals(emptyList<Any?>(), Json.parse("[]"))
        assertEquals("", Json.parse("\"\""))
    }

    @Test
    fun `rejects what is not JSON`() {
        val bad = listOf(
            "", "{", "{\"a\":1", "{\"a\" 1}", "{a:1}", "[1,]", "{\"a\":1,}", "\"open", "\"bad \\x escape\"",
            "\"\\u12\"", "\"\\u12zz\"", "tru", "nul", "01", "-", "1.", "1e", "{} {}", "\"tab\there\"", "<html>",
        )
        for (text in bad) {
            assertThrows(text, Json.ParseException::class.java) { Json.parse(text) }
        }
    }

    @Test
    fun `refuses very deep nesting instead of overflowing the stack`() {
        assertThrows(Json.ParseException::class.java) { Json.parse("[".repeat(10_000)) }
        Json.parse("[".repeat(30) + "]".repeat(30))
    }

    @Test
    fun `quote escapes what JSON requires and round-trips`() {
        val tricky = "a\"b\\c\nd\re\tf\bg\u000Ch\u0001i/é😎"
        assertEquals("\"a\\\"b\\\\c\\nd\\re\\tf\\bg\\fh\\u0001i/é😎\"", Json.quote(tricky))
        assertEquals(tricky, Json.parse(Json.quote(tricky)))
        assertEquals("null", Json.quoteOrNull(null))
    }

    @Test
    fun `reads only a 200 body with status and ref as a response`() {
        assertEquals(CheckResponse(CheckResponse.Status.OK, "C1456573"), CheckResponse.parse("""{"status":"ok","ref":"C1456573"}"""))
        assertEquals(
            CheckResponse(CheckResponse.Status.BLOCKED, "C1456573"),
            CheckResponse.parse("""{"ref":"C1456573","status":"blocked","extra":[1]}"""),
        )
        val bad = listOf(
            """{"status":"ok"}""", """{"ref":"C1456573"}""", """{"status":"OK","ref":"C1456573"}""",
            """{"status":"denied","ref":"C1456573"}""", """{"status":"ok","ref":12}""", """{"status":null,"ref":"x"}""",
            """["ok","C1456573"]""", """{"error":"bad_request"}""", "null", "",
        )
        for (body in bad) {
            assertThrows(body, Json.ParseException::class.java) { CheckResponse.parse(body) }
        }
    }
}
