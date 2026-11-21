package io.github.wilderlopez.nongrata

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Duration
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

// Real implementations of the interfaces in Dependencies.kt.

internal fun Dependencies.Companion.system(context: Context): Dependencies {
    val app = context.applicationContext ?: context
    val mainHandler = Handler(Looper.getMainLooper())
    return Dependencies(
        store = FileStore(File(app.noBackupFilesDir, "nongrata")),
        identity = AndroidDeviceIdentity(app),
        transport = HttpCheckTransport(),
        now = SystemClock::elapsedRealtime,
        background = checkExecutor,
        main = Executor { mainHandler.post(it) },
    )
}

/** Shared by every instance; idle threads end after a minute. Daemon threads never keep a JVM alive. */
private val checkExecutor: ExecutorService by lazy {
    Executors.newCachedThreadPool { runnable -> Thread(runnable, "NonGrata").apply { isDaemon = true } }
}

/**
 * One file per key in [directory]. A missing file is `null`; any other failure throws, so the
 * caller can tell "there is none" from "couldn't read it". Writes go to a temporary file that is
 * synced and then renamed over the old one, so a crash never leaves half a value. Each write has
 * its own temporary file: two writers of the same key (two instances, two processes) can never
 * rename a file the other one is still filling.
 */
internal class FileStore(directory: File) : LocalStore {
    private val directory: Path = directory.toPath()

    override fun read(key: String): String? = try {
        String(Files.readAllBytes(path(key)), Charsets.UTF_8)
    } catch (e: NoSuchFileException) {
        null
    }

    override fun write(key: String, value: String) {
        Files.createDirectories(directory)
        val temporary = Files.createTempFile(directory, "$key.", ".tmp")
        try {
            Files.write(
                temporary,
                value.toByteArray(Charsets.UTF_8),
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE,
                StandardOpenOption.SYNC,
            )
            Files.move(temporary, path(key), StandardCopyOption.ATOMIC_MOVE)
        } catch (e: Throwable) {
            try {
                Files.deleteIfExists(temporary)
            } catch (cleanup: IOException) {
                e.addSuppressed(cleanup)
            }
            throw e
        }
    }

    override fun remove(key: String) {
        Files.deleteIfExists(path(key))
    }

    private fun path(key: String): Path = directory.resolve(key)
}

internal class AndroidDeviceIdentity(private val context: Context) : DeviceIdentity {
    // ANDROID_ID is one of the identifiers NonGrata bans by; it only leaves the device hashed.
    @SuppressLint("HardwareIds")
    override fun androidId(): String? = try {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    } catch (e: Exception) {
        null
    }

    override fun appVersion(): String? = try {
        val packageManager = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(context.packageName, 0)
        }
        info.versionName
    } catch (e: Exception) {
        null
    }
}

/**
 * `HttpURLConnection`, so the SDK needs no HTTP library. [open] is injectable for the tests.
 * The timeout applies to connecting and again to reading, like `URLRequest.timeoutInterval`
 * applies to each wait rather than to the whole request. It does not bound the DNS lookup, and the
 * platform may try each of the host's addresses with its own connect timeout.
 */
internal class HttpCheckTransport(
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) : CheckTransport {
    override fun send(payload: CheckPayload, endpoint: URL, timeout: Duration): CheckResponse {
        val body = payload.toJson().toByteArray(Charsets.UTF_8)
        // At least 1: for HttpURLConnection, 0 means no timeout at all.
        val millis = timeout.toMillisSaturated().coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
        val connection = open(endpoint)
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = millis
            connection.readTimeout = millis
            connection.useCaches = false
            // Contract: only a 200 counts, so a redirect is no answer rather than a second request.
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            if (status != 200) throw IOException("HTTP $status")
            val text = connection.inputStream.use { readAtMost(it, MAX_RESPONSE_BYTES) }
            return CheckResponse.parse(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun readAtMost(input: InputStream, limit: Int): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > limit) throw IOException("Response too large")
        }
        return out.toString("UTF-8")
    }

    private companion object {
        /** `{"status":"blocked","ref":"C1456573"}` is 37 bytes. */
        const val MAX_RESPONSE_BYTES = 16 * 1024
    }
}
