package io.github.wilderlopez.nongrata

import java.io.IOException
import java.net.URL
import java.time.Duration
import java.util.ArrayDeque
import java.util.concurrent.Executor

internal class MemoryStore : LocalStore {
    val values = mutableMapOf<String, String>()
    var unavailable = false

    /** Reads work, but writing or removing throws, like a full disk. */
    var readOnly = false
    var writes = 0
        private set

    override fun read(key: String): String? {
        if (unavailable) throw IOException("unavailable")
        return values[key]
    }

    override fun write(key: String, value: String) {
        if (unavailable || readOnly) throw IOException("unavailable")
        writes++
        values[key] = value
    }

    override fun remove(key: String) {
        if (unavailable || readOnly) throw IOException("unavailable")
        values.remove(key)
    }
}

internal class FakeIdentity : DeviceIdentity {
    var androidId: String? = "3f9a1c2b7d4e5f60"
    var version: String? = "1.2.3"

    override fun androidId(): String? = androidId

    override fun appVersion(): String? = version
}

internal class FakeTransport : CheckTransport {
    enum class Mode { OK, BLOCKED, FAILING }

    var mode = Mode.OK

    /** The `ref` the Worker answers with; `null` answers the one in the request. */
    var ref: String? = null
    val payloads = mutableListOf<CheckPayload>()

    override fun send(payload: CheckPayload, endpoint: URL, timeout: Duration): CheckResponse {
        payloads.add(payload)
        return when (mode) {
            Mode.OK -> CheckResponse(CheckResponse.Status.OK, ref ?: payload.ref)
            Mode.BLOCKED -> CheckResponse(CheckResponse.Status.BLOCKED, ref ?: payload.ref)
            Mode.FAILING -> throw IOException("timed out")
        }
    }
}

/**
 * An executor that runs nothing until the test says so. As the background executor it plays the
 * role of the Swift tests' `Gate`: the test decides when each check reaches the Worker and ends.
 */
internal class ManualExecutor : Executor {
    private val queue = ArrayDeque<Runnable>()

    val pending: Int get() = queue.size

    override fun execute(command: Runnable) {
        queue.addLast(command)
    }

    /** Runs the oldest pending task. */
    fun runNext() {
        queue.removeFirst().run()
    }

    /** Runs the most recent pending task, to make an older one finish later. */
    fun runLast() {
        queue.removeLast().run()
    }

    fun runAll() {
        while (queue.isNotEmpty()) queue.removeFirst().run()
    }
}

internal class TestClock {
    var now = 1_800_000_000_000L

    fun advance(by: Duration) {
        now += by.toMillis()
    }
}

/** A test "device": its storage survives creating another `NonGrata` (relaunching the app). */
internal class TestDevice {
    val store = MemoryStore()
    val identity = FakeIdentity()
    val transport = FakeTransport()
    val clock = TestClock()
    val background = ManualExecutor()
    val main = ManualExecutor()

    fun configuration(strictSignup: Boolean = true) = NonGrataConfiguration(
        endpoint = "https://guard.test/v1/device/check",
        appId = "myapp",
        hashPrefix = "myapp-ban-v1",
        strictSignup = strictSignup,
        foregroundInterval = Duration.ofSeconds(3600),
    )

    fun launch(configuration: NonGrataConfiguration = configuration()) = NonGrata(
        configuration,
        Dependencies(
            store = store,
            identity = identity,
            transport = transport,
            now = { clock.now },
            background = background,
            main = main,
        ),
    )

    /** Starts a check, lets it finish and returns what its callback received on the main thread. */
    fun check(guardian: NonGrata, intent: CheckIntent, userId: String? = null): NonGrataVerdict? {
        var result: NonGrataVerdict? = null
        guardian.check(intent, userId) { result = it }
        background.runAll()
        main.runAll()
        return result
    }
}
