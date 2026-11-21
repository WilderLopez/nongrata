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
        Json.parse("[".repeat(33) + "]".repeat(33))
        assertThrows(Json.ParseException::class.java) { Json.parse("[".repeat(34) + "]".repeat(34)) }
        Json.parse("""{"a":""".repeat(32) + "1" + "}".repeat(32))
        assertThrows(Json.ParseException::class.java) { Json.parse("""{"a":""".repeat(33) + "1" + "}".repeat(33)) }
    }

    @Test
    fun `edge cases - numbers, escapes, duplicate keys and whitespace`() {
        for ((text, number) in listOf("-0" to -0.0, "0" to 0.0, "1E+2" to 100.0, "0.5e-3" to 0.0005, "-12.25" to -12.25)) {
            assertEquals(text, number, Json.parse(text))
        }
        assertEquals("\u0000Aé", Json.parse("\"\\u0000\\u0041\\u00E9\""))
        assertEquals("\u007f", Json.parse("\"\u007f\""))
        // The last of a repeated key wins, as in JavaScript's JSON.parse.
        assertEquals(CheckResponse(CheckResponse.Status.OK, "B"), CheckResponse.parse("""{"status":"blocked","ref":"A","status":"ok","ref":"B"}"""))
        assertEquals(CheckResponse(CheckResponse.Status.OK, "C1456573"), CheckResponse.parse(" \r\n\t{\"status\" : \"\\u006fk\" , \"ref\":\"C1456573\"}\n"))
        for (text in listOf(" ", "\uFEFF{}", "\u00A0{}", "+1", ".5", "1.e2", "--1", "[1 2]", "{\"a\":1 \"b\":2}", "\"a\"\"b\"")) {
            assertThrows(text, Json.ParseException::class.java) { Json.parse(text) }
        }
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
