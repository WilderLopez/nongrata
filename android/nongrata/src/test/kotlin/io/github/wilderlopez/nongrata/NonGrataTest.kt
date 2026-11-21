package io.github.wilderlopez.nongrata

import io.github.wilderlopez.nongrata.FakeTransport.Mode
import io.github.wilderlopez.nongrata.NonGrataVerdict.Allowed
import io.github.wilderlopez.nongrata.NonGrataVerdict.Blocked
import io.github.wilderlopez.nongrata.NonGrataVerdict.Unknown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URL
import java.time.Duration
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NonGrataTest {
    private val device = TestDevice()

    // installId

    @Test
    fun `installId is stable across calls and relaunches`() {
        val first = device.launch().installId
        assertNotNull(first)
        assertEquals(first, device.launch().installId)
        assertEquals(first, device.store.values["installId"])
    }

    @Test
    fun `installId is an uppercase UUID`() {
        val installId = device.launch().installId!!
        assertTrue(installId, Regex("^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$").matches(installId))
    }

    @Test
    fun `storage unavailable - doesn't invent an installId, doesn't call the Worker and doesn't block`() {
        device.store.unavailable = true
        val guardian = device.launch()
        assertNull(guardian.installId)

        assertEquals(Unknown, device.check(guardian, CheckIntent.LAUNCH))
        assertTrue(device.transport.payloads.isEmpty())
        assertEquals(0, device.store.writes)

        // Once the storage can be read again, the next check creates the installId.
        device.store.unavailable = false
        assertEquals(Allowed, device.check(guardian, CheckIntent.LAUNCH))
        assertNotNull(guardian.installId)
        assertEquals(guardian.installId, device.store.values["installId"])
    }

    @Test
    fun `an existing installId is never replaced`() {
        device.store.values["installId"] = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        assertEquals("3F2504E0-4F89-11D3-9A0C-0305E82C3301", guardian.installId)
        assertEquals(0, device.store.writes)
        // Vector from spec/hash-vectors.json.
        assertEquals("c1456573e3a96b15719a3522e962118ab1277207541d95b4ff72c2ea9de08b10", device.transport.payloads[0].ids.install)
        assertEquals("C1456573", guardian.supportCode)
    }

    @Test
    fun `an empty installId file counts as none`() {
        device.store.values["installId"] = ""
        val installId = device.launch().installId
        assertNotNull(installId)
        assertNotEquals("", installId)
        assertEquals(installId, device.store.values["installId"])
    }

    // Request

    @Test
    fun `the request carries hashes with the app's prefix, the ref and no iOS fields`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LOGIN, "user_12345")

        val payload = device.transport.payloads.single()
        val installHash = IdentifierHasher("myapp-ban-v1").hash(IdentifierKind.INSTALL, guardian.installId!!)

        assertEquals("myapp", payload.app)
        assertEquals("production", payload.env)
        assertEquals("login", payload.intent)
        assertEquals("android", payload.platform)
        assertEquals("1.2.3", payload.appVersion)
        // Vectors from spec/hash-vectors.json.
        assertEquals("83b1273587f3f4c91e0dcab9c6952765dfb2b00f743d0979cb9679d82f493854", payload.ids.user)
        assertEquals("4689a028b9610e455979dd12871c77850feaaa4e9745da8f1f9189d30667a128", payload.ids.androidId)
        assertEquals(installHash, payload.ids.install)
        assertEquals(IdentifierHasher.ref(installHash), payload.ref)
        assertEquals(guardian.supportCode, payload.ref)

        val json = payload.toJson()
        for (field in listOf("dc_token", "dc_token_update", "idfv", "icloud")) {
            assertFalse(field, json.contains("\"$field\""))
        }
    }

    @Test
    fun `the user ID is normalized before hashing`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LOGIN, " User_12345\n")
        assertEquals("83b1273587f3f4c91e0dcab9c6952765dfb2b00f743d0979cb9679d82f493854", device.transport.payloads[0].ids.user)
    }

    @Test
    fun `without a user ID, user is null`() {
        device.check(device.launch(), CheckIntent.LAUNCH)
        assertNull(device.transport.payloads[0].ids.user)
    }

    @Test
    fun `a null, empty or blank ANDROID_ID is left out`() {
        for (value in listOf(null, "", " \n")) {
            device.identity.androidId = value
            device.check(device.launch(), CheckIntent.LAUNCH)
            assertNull(value.toString(), device.transport.payloads.last().ids.androidId)
        }
    }

    // The hash of "" is the same for every signed-out device: sent and propagated after one ban,
    // it would block all of them. The Worker drops it too.
    @Test
    fun `an empty or blank userId is left out`() {
        for (value in listOf("", "  ", "\t\r\n")) {
            device.check(device.launch(), CheckIntent.LOGIN, userId = value)
            assertNull(value, device.transport.payloads.last().ids.user)
        }
    }

    @Test
    fun `the environment from the configuration goes as env`() {
        val configuration = device.configuration().copy(environment = NonGrataConfiguration.Environment.DEVELOPMENT)
        device.check(device.launch(configuration), CheckIntent.LAUNCH)
        assertEquals("development", device.transport.payloads[0].env)
    }

    @Test
    fun `a configuration with an endpoint that is not an http(s) URL fails at once`() {
        for (endpoint in listOf("", "guard.test/v1/device/check", "ftp://guard.test/x", "https://", "https://bad host/x")) {
            assertThrows(endpoint, IllegalArgumentException::class.java) {
                device.configuration().copy(endpoint = endpoint)
            }
        }
        assertEquals(java.net.URL("https://guard.test/v1/device/check"), device.configuration().endpointUrl)
    }

    @Test
    fun `the JSON follows the Worker contract, with explicit nulls`() {
        val payload = CheckPayload(
            app = "myapp", env = "production", ref = "ABCDEF12",
            ids = CheckPayload.Ids(install = "a", user = null, androidId = null),
            intent = "launch", appVersion = null,
        )
        assertEquals(
            """{"app":"myapp","env":"production","ref":"ABCDEF12","ids":{"install":"a","user":null,"android_id":null},""" +
                """"intent":"launch","platform":"android","app_version":null}""",
            payload.toJson(),
        )
        val parsed = Json.parse(payload.copy(appVersion = "1.0 \"beta\"").toJson()) as Map<*, *>
        assertEquals(setOf("app", "env", "ref", "ids", "intent", "platform", "app_version"), parsed.keys)
        assertEquals("1.0 \"beta\"", parsed["app_version"])
        assertEquals(setOf("install", "user", "android_id"), (parsed["ids"] as Map<*, *>).keys)
    }

    // Persistent verdict

    @Test
    fun `blocked sets the mark and blocks on relaunch without network`() {
        device.transport.mode = Mode.BLOCKED
        val guardian = device.launch()
        val ref = guardian.supportCode!!
        assertEquals(Blocked(ref), device.check(guardian, CheckIntent.LAUNCH))
        assertEquals(ref, device.store.values["blockedRef"])

        device.transport.mode = Mode.FAILING
        val relaunched = device.launch()
        assertEquals(Blocked(ref), relaunched.verdict)
        assertEquals(Blocked(ref), device.check(relaunched, CheckIntent.LAUNCH))
    }

    @Test
    fun `ok clears the mark - it is the only way out of a block`() {
        device.transport.mode = Mode.BLOCKED
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)

        device.transport.mode = Mode.OK
        assertEquals(Allowed, device.check(guardian, CheckIntent.FOREGROUND))
        assertNull(device.store.values["blockedRef"])
        assertEquals(Unknown, device.launch().verdict)
    }

    @Test
    fun `an error touches neither the mark nor the blocked verdict`() {
        device.transport.mode = Mode.BLOCKED
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)

        device.transport.mode = Mode.FAILING
        val ref = guardian.supportCode!!
        assertEquals(Blocked(ref), device.check(guardian, CheckIntent.FOREGROUND))
        assertEquals(ref, device.store.values["blockedRef"])
    }

    @Test
    fun `an error after ok goes back to unknown, not to allowed`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        device.transport.mode = Mode.FAILING
        assertEquals(Unknown, device.check(guardian, CheckIntent.LOGIN))
    }

    @Test
    fun `the mark keeps the ref the Worker sent`() {
        device.store.values["blockedRef"] = "ABCDEF12"
        assertEquals(Blocked("ABCDEF12"), device.launch().verdict)
    }

    @Test
    fun `blocked keeps the ref the Worker answers with, not the one computed here`() {
        device.transport.mode = Mode.BLOCKED
        device.transport.ref = "0BADC0DE"
        val guardian = device.launch()
        assertEquals(Blocked("0BADC0DE"), device.check(guardian, CheckIntent.LAUNCH))
        assertEquals("0BADC0DE", device.store.values["blockedRef"])
        assertNotEquals("0BADC0DE", guardian.supportCode)
    }

    @Test
    fun `a mark that can't be written still blocks now, and the next answer writes it`() {
        val guardian = device.launch()
        val ref = guardian.supportCode!!
        device.store.readOnly = true
        device.transport.mode = Mode.BLOCKED
        assertEquals(Blocked(ref), device.check(guardian, CheckIntent.LAUNCH))
        assertNull(device.store.values["blockedRef"])

        device.store.readOnly = false
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(ref, device.store.values["blockedRef"])
    }

    @Test
    fun `a mark that can't be deleted still allows now, and blocks the next launch until an ok deletes it`() {
        device.store.values["blockedRef"] = "ABCDEF12"
        val guardian = device.launch()
        device.store.readOnly = true
        assertEquals(Allowed, device.check(guardian, CheckIntent.LAUNCH))
        assertEquals(Blocked("ABCDEF12"), device.launch().verdict)

        device.store.readOnly = false
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(Unknown, device.launch().verdict)
    }

    @Test
    fun `fail-open - with no mark and an error, unknown lets the app through except strict signup`() {
        device.transport.mode = Mode.FAILING
        val strict = device.launch()
        val verdict = device.check(strict, CheckIntent.SIGNUP)!!
        assertEquals(Unknown, verdict)
        for (intent in listOf(CheckIntent.LAUNCH, CheckIntent.FOREGROUND, CheckIntent.LOGIN, CheckIntent.REFRESH)) {
            assertTrue(strict.permits(verdict, intent))
        }
        assertFalse(strict.permits(verdict, CheckIntent.SIGNUP))
        assertTrue(strict.permits(Allowed, CheckIntent.SIGNUP))

        val lenient = device.launch(device.configuration(strictSignup = false))
        assertTrue(lenient.permits(Unknown, CheckIntent.SIGNUP))
        assertFalse(lenient.permits(Blocked("ABCDEF12"), CheckIntent.LAUNCH))
    }

    // Foreground

    @Test
    fun `in the foreground, doesn't repeat the check before foregroundInterval`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        assertEquals(Allowed, device.check(guardian, CheckIntent.FOREGROUND))
        assertEquals(1, device.transport.payloads.size)

        device.clock.advance(Duration.ofSeconds(3599))
        device.check(guardian, CheckIntent.FOREGROUND)
        assertEquals(1, device.transport.payloads.size)

        device.clock.advance(Duration.ofSeconds(1))
        device.check(guardian, CheckIntent.FOREGROUND)
        assertEquals(2, device.transport.payloads.size)

        // Other intents always check.
        device.check(guardian, CheckIntent.LOGIN, "u")
        assertEquals(3, device.transport.payloads.size)
    }

    @Test
    fun `a foregroundInterval too long for milliseconds throttles instead of throwing`() {
        val guardian = device.launch(device.configuration().copy(foregroundInterval = Duration.ofSeconds(Long.MAX_VALUE)))
        device.check(guardian, CheckIntent.LAUNCH)
        device.clock.advance(Duration.ofDays(3650))
        assertEquals(Allowed, device.check(guardian, CheckIntent.FOREGROUND))
        assertEquals(1, device.transport.payloads.size)
    }

    @Test
    fun `a zero or negative foregroundInterval never skips a foreground check`() {
        for (interval in listOf(Duration.ZERO, Duration.ofSeconds(-1), Duration.ofSeconds(Long.MIN_VALUE))) {
            val guardian = device.launch(device.configuration().copy(foregroundInterval = interval))
            val before = device.transport.payloads.size
            device.check(guardian, CheckIntent.LAUNCH)
            device.check(guardian, CheckIntent.FOREGROUND)
            assertEquals(interval.toString(), before + 2, device.transport.payloads.size)
        }
    }

    @Test
    fun `a refresh always checks, even right after an allowed verdict`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        device.check(guardian, CheckIntent.REFRESH, "u")
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(3, device.transport.payloads.size)
        assertEquals("refresh", device.transport.payloads.last().intent)
    }

    @Test
    fun `while blocked, checks on every return to the foreground to detect an unban`() {
        device.transport.mode = Mode.BLOCKED
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        device.check(guardian, CheckIntent.FOREGROUND)
        device.check(guardian, CheckIntent.FOREGROUND)
        assertEquals(3, device.transport.payloads.size)
    }

    @Test
    fun `while unknown, checks on every return to the foreground`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        device.transport.mode = Mode.FAILING
        device.check(guardian, CheckIntent.LOGIN)
        device.check(guardian, CheckIntent.FOREGROUND)
        assertEquals(3, device.transport.payloads.size)
    }

    // Threads and delivery

    @Test
    fun `the check runs on the background executor and the result arrives on the main one`() {
        val guardian = device.launch()
        var result: NonGrataVerdict? = null
        guardian.check(CheckIntent.LAUNCH) { result = it }
        assertTrue(device.transport.payloads.isEmpty())

        device.background.runAll()
        assertEquals(1, device.transport.payloads.size)
        assertNull(result)

        device.main.runAll()
        assertEquals(Allowed, result)
    }

    @Test
    fun `a throttled foreground check still answers, on the main executor`() {
        val guardian = device.launch()
        device.check(guardian, CheckIntent.LAUNCH)
        var result: NonGrataVerdict? = null
        guardian.check(CheckIntent.FOREGROUND) { result = it }
        assertEquals(0, device.background.pending)
        assertNull(result)
        device.main.runAll()
        assertEquals(Allowed, result)
    }

    @Test
    fun `listeners hear each change once, in order, and stop when removed`() {
        val guardian = device.launch()
        val heard = mutableListOf<NonGrataVerdict>()
        val listener = NonGrata.VerdictListener { heard.add(it) }
        guardian.addListener(listener)

        device.check(guardian, CheckIntent.LAUNCH)
        device.check(guardian, CheckIntent.REFRESH) // still allowed: no change
        device.transport.mode = Mode.BLOCKED
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(listOf(Allowed, Blocked(guardian.supportCode!!)), heard)

        guardian.removeListener(listener)
        device.transport.mode = Mode.OK
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(2, heard.size)
        assertEquals(Allowed, guardian.verdict)
    }

    @Test
    fun `listeners hear a change before the callback of the check that made it`() {
        val guardian = device.launch()
        val order = mutableListOf<String>()
        guardian.addListener { order.add("listener") }
        guardian.check(CheckIntent.LAUNCH) { order.add("callback") }
        device.background.runAll()
        device.main.runAll()
        assertEquals(listOf("listener", "callback"), order)
    }

    @Test
    fun `a listener added while a change is queued hears it`() {
        val guardian = device.launch()
        guardian.check(CheckIntent.LAUNCH)
        device.background.runAll() // the change to allowed is queued on the main executor
        val heard = mutableListOf<NonGrataVerdict>()
        guardian.addListener { heard.add(it) }
        device.main.runAll()
        assertEquals(listOf<NonGrataVerdict>(Allowed), heard)
    }

    @Test
    fun `a listener removed on the main thread doesn't hear a change already queued`() {
        val guardian = device.launch()
        val heard = mutableListOf<NonGrataVerdict>()
        val listener = NonGrata.VerdictListener { heard.add(it) }
        guardian.addListener(listener)
        guardian.check(CheckIntent.LAUNCH)
        device.background.runAll()
        guardian.removeListener(listener)
        device.main.runAll()
        assertTrue(heard.isEmpty())
        assertEquals(Allowed, guardian.verdict)
    }

    @Test
    fun `a listener removed by another during a notification still hears that change, not the next`() {
        val guardian = device.launch()
        val heard = mutableListOf<NonGrataVerdict>()
        val removed = NonGrata.VerdictListener { heard.add(it) }
        guardian.addListener { guardian.removeListener(removed) }
        guardian.addListener(removed)

        device.check(guardian, CheckIntent.LAUNCH)
        device.transport.mode = Mode.BLOCKED
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(listOf<NonGrataVerdict>(Allowed), heard)
    }

    @Test
    fun `a listener added twice is called twice, and removing it once leaves one`() {
        val guardian = device.launch()
        val heard = mutableListOf<NonGrataVerdict>()
        val listener = NonGrata.VerdictListener { heard.add(it) }
        guardian.addListener(listener)
        guardian.addListener(listener)
        device.check(guardian, CheckIntent.LAUNCH)
        assertEquals(2, heard.size)

        guardian.removeListener(listener)
        device.transport.mode = Mode.BLOCKED
        device.check(guardian, CheckIntent.REFRESH)
        assertEquals(3, heard.size)
        guardian.removeListener(listener)
        guardian.removeListener(listener) // not there any more: nothing happens
    }

    @Test
    fun `a listener can start a check from its own call`() {
        val guardian = device.launch()
        var rechecked = false
        guardian.addListener {
            if (it is Blocked && !rechecked) {
                rechecked = true
                guardian.check(CheckIntent.REFRESH)
            }
        }
        device.transport.mode = Mode.BLOCKED
        device.check(guardian, CheckIntent.LAUNCH)
        assertEquals(1, device.background.pending)

        device.transport.mode = Mode.OK
        device.background.runAll()
        device.main.runAll()
        assertEquals(Allowed, guardian.verdict)
        assertEquals(2, device.transport.payloads.size)
    }

    // Concurrency

    @Test
    fun `an older check that finishes late doesn't overwrite the most recent one`() {
        val guardian = device.launch()
        val results = mutableListOf<Pair<String, NonGrataVerdict>>()
        guardian.check(CheckIntent.LAUNCH) { results.add("stale" to it) }
        guardian.check(CheckIntent.LOGIN) { results.add("latest" to it) }

        device.transport.mode = Mode.OK
        device.background.runLast() // the newer check ends first
        assertEquals(Allowed, guardian.verdict)

        device.transport.mode = Mode.BLOCKED
        device.background.runNext() // the older one answers blocked, too late
        device.main.runAll()

        assertEquals(Allowed, guardian.verdict)
        assertNull(device.store.values["blockedRef"])
        assertEquals(listOf("latest" to Allowed, "stale" to Allowed), results)
    }

    @Test
    fun `the check that started last decides even if the older one ends first`() {
        val guardian = device.launch()
        guardian.check(CheckIntent.LAUNCH)
        guardian.check(CheckIntent.REFRESH)

        device.transport.mode = Mode.BLOCKED
        device.background.runNext() // the older one: ignored
        assertEquals(Unknown, guardian.verdict)
        assertNull(device.store.values["blockedRef"])

        device.transport.mode = Mode.OK
        device.background.runNext()
        assertEquals(Allowed, guardian.verdict)
    }

    @Test
    fun `two pending checks with no installId yet create a single one`() {
        device.store.unavailable = true
        val guardian = device.launch()
        guardian.check(CheckIntent.LAUNCH)
        guardian.check(CheckIntent.LOGIN)
        device.store.unavailable = false
        device.background.runAll()

        assertEquals(1, device.store.writes)
        val (first, second) = device.transport.payloads
        assertEquals(first.ids.install, second.ids.install)
    }

    @Test
    fun `checks started on many threads at once create one installId and all send it`() {
        device.store.unavailable = true
        val payloads = Collections.synchronizedList(mutableListOf<CheckPayload>())
        val transport = object : CheckTransport {
            override fun send(payload: CheckPayload, endpoint: URL, timeout: Duration): CheckResponse {
                payloads.add(payload)
                return CheckResponse(CheckResponse.Status.OK, payload.ref)
            }
        }
        val background = Executors.newFixedThreadPool(8)
        val callers = Executors.newFixedThreadPool(8)
        try {
            val guardian = NonGrata(
                device.configuration(),
                Dependencies(device.store, device.identity, transport, { device.clock.now }, background, Executor { it.run() }),
            )
            device.store.unavailable = false
            val start = CountDownLatch(1)
            val delivered = CountDownLatch(CHECKS)
            repeat(CHECKS) {
                callers.execute {
                    start.await()
                    guardian.check(CheckIntent.REFRESH) { delivered.countDown() }
                }
            }
            start.countDown()
            assertTrue("every callback ran", delivered.await(30, TimeUnit.SECONDS))

            assertEquals(1, device.store.writes)
            assertEquals(CHECKS, payloads.size)
            assertEquals(device.store.values["installId"], guardian.installId)
            assertEquals(1, payloads.map { it.ids.install }.toSet().size)
            assertEquals(guardian.supportCode, payloads.first().ref)
            assertEquals(Allowed, guardian.verdict)
        } finally {
            background.shutdownNow()
            callers.shutdownNow()
        }
    }

    private companion object {
        const val CHECKS = 200
    }
}
