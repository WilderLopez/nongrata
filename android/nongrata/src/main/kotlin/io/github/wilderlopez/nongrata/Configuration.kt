package io.github.wilderlopez.nongrata

import java.net.URI
import java.net.URISyntaxException
import java.net.URL
import java.time.Duration

/**
 * How [NonGrata] talks to the Worker.
 *
 * @property endpoint Full URL of `POST /v1/device/check`, such as
 *   `https://nongrata-myapp.example.workers.dev/v1/device/check`. A string rather than a
 *   `java.net.URL`, whose `equals` and `hashCode` resolve the host over the network. Plain `http`
 *   is accepted, but Android blocks cleartext traffic unless the app's network security config
 *   allows it, and then every check ends in no answer.
 * @property appId The app's identifier in the Worker, for example `"myapp"`.
 * @property hashPrefix Same as the Worker's `HASH_PREFIX_<APP>`, for example `"myapp-ban-v1"`.
 * @property environment Sent as `env` on every check. The Worker uses it to pick the DeviceCheck
 *   endpoint, which an Android check never calls, so it only matters for the check log.
 * @property strictSignup With [CheckIntent.SIGNUP], creating the account requires the check to end
 *   in [NonGrataVerdict.Allowed].
 * @property foregroundInterval Minimum interval between [CheckIntent.FOREGROUND] checks while
 *   allowed. Zero or negative never skips one.
 * @property timeout The longest wait to open a connection to one of the Worker's addresses, and
 *   again the longest wait for its answer, rather than a limit on the whole check: the DNS lookup is
 *   not counted, and a host with several addresses can try each in turn. Zero or less counts as one
 *   millisecond.
 * @throws IllegalArgumentException if [endpoint] is not an absolute `http(s)` URL with a host.
 */
public data class NonGrataConfiguration @JvmOverloads constructor(
    val endpoint: String,
    val appId: String,
    val hashPrefix: String,
    val environment: Environment = Environment.PRODUCTION,
    val strictSignup: Boolean = true,
    val foregroundInterval: Duration = Duration.ofHours(6),
    val timeout: Duration = Duration.ofSeconds(5),
) {
    /** Throws `IllegalArgumentException` here, not on the first check, if [endpoint] is not an absolute http(s) URL. */
    internal val endpointUrl: URL = run {
        val uri = try {
            URI(endpoint)
        } catch (e: URISyntaxException) {
            throw IllegalArgumentException("endpoint is not a URL: $endpoint", e)
        }
        require((uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrEmpty()) {
            "endpoint must be an http(s) URL: $endpoint"
        }
        uri.toURL()
    }

    /** The `env` sent with each check, as [wireValue]. */
    public enum class Environment(public val wireValue: String) {
        DEVELOPMENT("development"),
        PRODUCTION("production"),
    }
}

/** Why the app checks; sent as `intent`, as [wireValue]. Only [FOREGROUND] is ever skipped. */
public enum class CheckIntent(public val wireValue: String) {
    /** The app started. */
    LAUNCH("launch"),

    /** The app came back to the foreground. Skipped while allowed and checked recently (`foregroundInterval`). */
    FOREGROUND("foreground"),

    /** A user signed in. Pass their `userId`. */
    LOGIN("login"),

    /** Before creating an account; decide with [NonGrata.permits], which applies `strictSignup`. */
    SIGNUP("signup"),

    /**
     * A check the app forces because something may have changed (its own push arrived, its
     * backend reported a blocked account, a timer while the app is open). Never throttled.
     * Needs a Worker that knows it: an older one answers `400`, which counts as no response.
     */
    REFRESH("refresh"),
}

/** What the SDK knows about this device. Use [NonGrata.permits] to decide with it. */
public sealed class NonGrataVerdict {
    /** The last check that decided got `ok` from the Worker. */
    public data object Allowed : NonGrataVerdict()

    /**
     * The Worker answered `blocked`, now or on an earlier launch (the local mark). [ref] is the
     * support code to show the user, as the Worker sent it.
     */
    public data class Blocked(val ref: String) : NonGrataVerdict()

    /** The check couldn't complete and there is no local mark. */
    public data object Unknown : NonGrataVerdict()
}

/** [Duration.toMillis], but a duration too long for a `Long` of milliseconds saturates instead of throwing. */
internal fun Duration.toMillisSaturated(): Long = try {
    toMillis()
} catch (e: ArithmeticException) {
    if (isNegative) Long.MIN_VALUE else Long.MAX_VALUE
}
