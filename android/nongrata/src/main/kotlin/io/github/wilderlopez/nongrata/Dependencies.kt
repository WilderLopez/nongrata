package io.github.wilderlopez.nongrata

import java.io.IOException
import java.net.URL
import java.time.Duration
import java.util.concurrent.Executor

// Everything that touches the system sits behind these interfaces so `NonGrata` can be tested on
// the JVM without files, Settings, network or a main thread. The real implementations are in
// SystemDependencies.kt.

/**
 * Small values that must survive relaunches and stay on this device: files in
 * `Context.getNoBackupFilesDir()`, which Auto Backup never copies to another phone.
 */
internal interface LocalStore {
    /** `null` if it doesn't exist. Throws if it exists but couldn't be read. */
    @Throws(IOException::class)
    fun read(key: String): String?

    @Throws(IOException::class)
    fun write(key: String, value: String)

    @Throws(IOException::class)
    fun remove(key: String)
}

internal interface DeviceIdentity {
    /** `Settings.Secure.ANDROID_ID`; `null` if it can't be read. */
    fun androidId(): String?

    /** `versionName` from the `PackageManager`. */
    fun appVersion(): String?
}

internal interface CheckTransport {
    /** Throws on anything but a `200` with `{status, ref}`. */
    @Throws(Exception::class)
    fun send(payload: CheckPayload, endpoint: URL, timeout: Duration): CheckResponse
}

internal class Dependencies(
    val store: LocalStore,
    val identity: DeviceIdentity,
    val transport: CheckTransport,
    /** Monotonic milliseconds, for the foreground throttle. */
    val now: () -> Long,
    /** Runs the checks: storage, `ANDROID_ID` and network. */
    val background: Executor,
    /** Delivers results and changes to the app (the main thread in the real one). */
    val main: Executor,
) {
    /** `Dependencies.system(context)` lives in SystemDependencies.kt. */
    companion object
}

/** The body of `POST /v1/device/check` for an Android client (docs/CHECK-API.md). */
internal data class CheckPayload(
    val app: String,
    val env: String,
    val ref: String,
    val ids: Ids,
    val intent: String,
    val appVersion: String?,
) {
    /**
     * With `platform: "android"` the Worker rejects `dc_token`, `dc_token_update`, `ids.idfv` and
     * `ids.icloud` unless they are null, so they are never written at all.
     */
    data class Ids(
        val install: String,
        val user: String?,
        val androidId: String?,
    )

    val platform: String get() = PLATFORM

    /** Missing ids and `app_version` go as an explicit `null`, like the Swift SDK. */
    fun toJson(): String = buildString {
        append('{')
        append("\"app\":").append(Json.quote(app))
        append(",\"env\":").append(Json.quote(env))
        append(",\"ref\":").append(Json.quote(ref))
        append(",\"ids\":{")
        append("\"install\":").append(Json.quote(ids.install))
        append(",\"user\":").append(Json.quoteOrNull(ids.user))
        append(",\"android_id\":").append(Json.quoteOrNull(ids.androidId))
        append('}')
        append(",\"intent\":").append(Json.quote(intent))
        append(",\"platform\":").append(Json.quote(platform))
        append(",\"app_version\":").append(Json.quoteOrNull(appVersion))
        append('}')
    }

    companion object {
        const val PLATFORM = "android"
    }
}

internal data class CheckResponse(val status: Status, val ref: String) {
    enum class Status { OK, BLOCKED }

    companion object {
        /** Throws unless the body is an object with `status` (`ok` or `blocked`) and a string `ref`. */
        @Throws(Json.ParseException::class)
        fun parse(body: String): CheckResponse {
            val obj = Json.parse(body) as? Map<*, *> ?: throw Json.ParseException("Not an object")
            val status = when (obj["status"]) {
                "ok" -> Status.OK
                "blocked" -> Status.BLOCKED
                else -> throw Json.ParseException("Bad status")
            }
            val ref = obj["ref"] as? String ?: throw Json.ParseException("Bad ref")
            return CheckResponse(status, ref)
        }
    }
}
