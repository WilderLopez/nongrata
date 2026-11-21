package io.github.wilderlopez.nongrata

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration

class FileStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `missing is null, and a value survives a new store on the same directory`() {
        val dir = File(folder.root, "nongrata") // does not exist yet
        val store = FileStore(dir)
        assertNull(store.read("installId"))

        store.write("installId", "3F2504E0-4F89-11D3-9A0C-0305E82C3301")
        assertEquals("3F2504E0-4F89-11D3-9A0C-0305E82C3301", FileStore(dir).read("installId"))

        store.write("installId", "B")
        assertEquals("B", store.read("installId"))
        assertFalse("no temporary file left", File(dir, "installId.tmp").exists())

        store.remove("installId")
        assertNull(store.read("installId"))
        store.remove("installId") // removing what isn't there is fine
    }

    @Test
    fun `a value that exists but can't be read throws instead of looking missing`() {
        val dir = folder.newFolder("nongrata")
        File(dir, "installId").mkdir() // a directory where the file should be
        assertThrows(IOException::class.java) { FileStore(dir).read("installId") }
    }

    @Test
    fun `NonGrata does not replace an installId it couldn't read`() {
        val dir = folder.newFolder("nongrata")
        File(dir, "installId").mkdir()
        val device = TestDevice()
        val guardian = NonGrata(
            device.configuration(),
            Dependencies(FileStore(dir), device.identity, device.transport, { 0L }, device.background, device.main),
        )
        assertNull(guardian.installId)
        guardian.check(CheckIntent.LAUNCH)
        device.background.runAll()
        assertTrue(device.transport.payloads.isEmpty())
        assertTrue(File(dir, "installId").isDirectory)
    }
}

class HttpCheckTransportTest {
    private class FakeConnection(
        url: URL,
        private val status: Int,
        private val body: ByteArray,
        private val failOnWrite: Boolean = false,
    ) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        var disconnected = false
        var bodyRead = false

        override fun connect() {
            connected = true
        }

        override fun disconnect() {
            disconnected = true
        }

        override fun usingProxy() = false

        override fun getOutputStream(): OutputStream {
            if (failOnWrite) throw IOException("no network")
            return sent
        }

        override fun getResponseCode() = status

        override fun getInputStream(): InputStream {
            bodyRead = true
            return ByteArrayInputStream(body)
        }
    }

    private val endpoint = URL("https://guard.test/v1/device/check")
    private val payload = CheckPayload(
        app = "myapp", env = "production", ref = "C1456573",
        ids = CheckPayload.Ids("c1456573e3a96b15719a3522e962118ab1277207541d95b4ff72c2ea9de08b10", null, null),
        intent = "launch", appVersion = "1.2.3",
    )

    private fun send(status: Int, body: String, failOnWrite: Boolean = false): Pair<FakeConnection, Result<CheckResponse>> {
        var connection: FakeConnection? = null
        val transport = HttpCheckTransport { url ->
            FakeConnection(url, status, body.toByteArray(), failOnWrite).also { connection = it }
        }
        val result = runCatching { transport.send(payload, endpoint, Duration.ofSeconds(5)) }
        return connection!! to result
    }

    @Test
    fun `posts the JSON body and reads a 200 with status and ref`() {
        val (connection, result) = send(200, """{"status":"blocked","ref":"C1456573"}""")
        assertEquals(CheckResponse(CheckResponse.Status.BLOCKED, "C1456573"), result.getOrThrow())
        assertEquals(endpoint, connection.url)
        assertEquals("POST", connection.requestMethod)
        assertEquals("application/json", connection.getRequestProperty("Content-Type"))
        assertEquals(5000, connection.connectTimeout)
        assertEquals(5000, connection.readTimeout)
        assertFalse(connection.useCaches)
        assertFalse(connection.instanceFollowRedirects)
        assertArrayEquals(payload.toJson().toByteArray(), connection.sent.toByteArray())
        assertTrue(connection.disconnected)
    }

    @Test
    fun `anything but a 200 is no answer, and the body is not read`() {
        for (status in listOf(201, 204, 302, 400, 404, 429, 500, 503)) {
            val (connection, result) = send(status, """{"status":"ok","ref":"C1456573"}""")
            assertTrue("$status", result.isFailure)
            assertFalse("$status", connection.bodyRead)
            assertTrue("$status", connection.disconnected)
        }
    }

    @Test
    fun `a 200 whose body is not status and ref is no answer`() {
        for (body in listOf("", "<html>error</html>", """{"error":"bad_request"}""", """{"status":"ok"}""")) {
            assertTrue(body, send(200, body).second.isFailure)
        }
    }

    @Test
    fun `an oversized body is no answer`() {
        val huge = """{"status":"ok","ref":"C1456573","pad":"${"x".repeat(20_000)}"}"""
        assertTrue(send(200, huge).second.isFailure)
    }

    @Test
    fun `a network error is thrown and the connection is closed`() {
        val (connection, result) = send(200, "", failOnWrite = true)
        assertTrue(result.exceptionOrNull() is IOException)
        assertTrue(connection.disconnected)
    }
}
