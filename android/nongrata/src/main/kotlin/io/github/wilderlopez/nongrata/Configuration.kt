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
 *   `java.net.URL`, whose `equals` and `hashCode` resolve the host over the network.
 * @property appId The app's identifier in the Worker, for example `"myapp"`.
 * @property hashPrefix Same as the Worker's `HASH_PREFIX_<APP>`, for example `"myapp-ban-v1"`.
 * @property environment Sent as `env` on every check. The Worker uses it to pick the DeviceCheck
 *   endpoint, which an Android check never calls, so it only matters for the check log.
 * @property strictSignup With [CheckIntent.SIGNUP], creating the account requires the check to end
 *   in [NonGrataVerdict.Allowed].
 * @property foregroundInterval Minimum interval between [CheckIntent.FOREGROUND] checks while
 *   allowed.
 * @property timeout Maximum time to connect to the Worker, and again to read its answer.
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

    public enum class Environment(public val wireValue: String) {
        DEVELOPMENT("development"),
        PRODUCTION("production"),
    }
}

public enum class CheckIntent(public val wireValue: String) {
    LAUNCH("launch"),
    FOREGROUND("foreground"),
    LOGIN("login"),
    SIGNUP("signup"),

    /**
     * A check the app forces because something may have changed (its own push arrived, its
     * backend reported a blocked account, a timer while the app is open). Never throttled.
     * Needs a Worker that knows it: an older one answers `400`, which counts as no response.
     */
    REFRESH("refresh"),
}

public sealed class NonGrataVerdict {
    public data object Allowed : NonGrataVerdict()

    public data class Blocked(val ref: String) : NonGrataVerdict()

    /** The check couldn't complete and there is no local mark. */
    public data object Unknown : NonGrataVerdict()
}
