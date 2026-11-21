package io.github.wilderlopez.nongrata

import android.content.Context

/**
 * Asks the Worker whether this device is blocked and remembers the verdict.
 *
 * - Fail-open: if the check fails and there is no local mark, the verdict is
 *   [NonGrataVerdict.Unknown] and the app carries on, except for signup in strict mode
 *   ([permits]).
 * - The local mark (a file in `noBackupFilesDir`) is only set by a `blocked` from the Worker and
 *   only cleared by an `ok`. An error leaves it untouched.
 * - The SDK shows no UI and never closes the app: the app draws its own blocking screen.
 *
 * Create one instance when the app starts and keep it for the life of the process. Checks run on a
 * background thread; results and changes arrive on the main thread. Every public member can be
 * called from any thread.
 */
public class NonGrata internal constructor(
    private val configuration: NonGrataConfiguration,
    private val dependencies: Dependencies,
) {
    /**
     * Reads the `installId` and the local mark on the calling thread, so a device with a mark is
     * [NonGrataVerdict.Blocked] from the first instant. On the first launch it also creates the
     * `installId` and writes it, synced to disk. On the main thread, a StrictMode policy that
     * detects disk reads or writes reports it. It never throws: if the `installId` can be neither
     * read nor created, [installId] is `null` (retried on the next check), and if the mark can't be
     * read, the verdict starts as [NonGrataVerdict.Unknown].
     *
     * Only the application context is kept, so passing an `Activity` does not leak it. Each
     * instance has its own verdict and listeners, but all of them share the same files: create one
     * per process, and if the app runs several processes, only in the one that checks
     * (`Application.onCreate` runs in every process).
     */
    public constructor(context: Context, configuration: NonGrataConfiguration) :
        this(configuration, Dependencies.system(context))

    /**
     * Receives a verdict on the main thread: from [check] as `onResult`, or as a listener added
     * with [addListener].
     */
    public fun interface VerdictListener {
        public fun onVerdict(verdict: NonGrataVerdict)
    }

    private val hasher = IdentifierHasher(configuration.hashPrefix)
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<VerdictListener>()

    // Guarded by `lock`. Every change happens inside it, and so does posting its notification to
    // `dependencies.main`, so listeners see changes in the order they happened.
    private val lock = Any()
    private var currentVerdict: NonGrataVerdict = NonGrataVerdict.Unknown
    private var currentInstallId: String? = null
    private var lastAllowedAt: Long? = null
    private var generation = 0L

    init {
        synchronized(lock) {
            currentInstallId = loadOrCreateInstallId()
            localMarkRef()?.let { currentVerdict = NonGrataVerdict.Blocked(it) }
        }
    }

    /**
     * The current verdict. At construction it is [NonGrataVerdict.Blocked] if there is a local mark
     * and [NonGrataVerdict.Unknown] otherwise; after that, only the check that started last changes
     * it. It changes before the listeners hear about it, so on the main thread it can be ahead of
     * the last verdict a listener received.
     */
    public val verdict: NonGrataVerdict
        get() = synchronized(lock) { currentVerdict }

    /**
     * The SDK's own UUID, stored in `noBackupFilesDir`, for analytics and support. `null` if it
     * could neither be read nor created (a storage error, or credential-encrypted storage still
     * locked in Direct Boot). The getter does not retry: the next [check] does, on its background
     * thread, and sends nothing while it stays `null`.
     */
    public val installId: String?
        get() = synchronized(lock) { currentInstallId }

    /**
     * This device's support code (`ref`): the first 8 characters, uppercased, of the hash of
     * [installId], the same `ref` the Worker derives. `null` exactly when [installId] is `null`.
     */
    public val supportCode: String?
        get() = installId?.let { IdentifierHasher.ref(hasher.hash(IdentifierKind.INSTALL, it)) }

    /**
     * Calls [listener] on the main thread with every change of [verdict] from now on; a check that
     * ends with the same verdict calls nothing. It does not get the current verdict: read [verdict]
     * after adding it. A change already queued for the main thread when it is added reaches it too,
     * so it may hear a verdict older than the one just read; the last call always carries the
     * current one. Adding the same listener twice calls it twice.
     *
     * The SDK keeps a strong reference until [removeListener]. A listener that captures an
     * `Activity` or its views leaks them if it is not removed: add it in `onStart` and remove it in
     * `onStop` (or `onCreate` and `onDestroy`).
     */
    public fun addListener(listener: VerdictListener) {
        listeners.add(listener)
    }

    /**
     * Removes one registration of [listener]; nothing happens if it was not added. Removed on the
     * main thread, it hears no later change, nor one already queued; removed from inside another
     * listener's call, it still hears that same change.
     */
    public fun removeListener(listener: VerdictListener) {
        listeners.remove(listener)
    }

    /**
     * Checks with the Worker on a background thread and returns at once; it can be called from any
     * thread. [userId] is the app's ID for the signed-in user, or `null` without a session; one
     * that is empty or only spaces, tabs and line breaks counts as `null`. [onResult], if given, is
     * called exactly once on the main thread, after the listeners hear any change. The SDK holds it
     * until then, even if the screen that passed it has gone, and that can take longer than
     * [NonGrataConfiguration.timeout].
     *
     * With [CheckIntent.FOREGROUND] it sends nothing if the last check that returned
     * [NonGrataVerdict.Allowed] was less than `foregroundInterval` ago, and [onResult] gets the
     * current verdict; while blocked or unknown it always checks, so it can detect an unban. If
     * another check starts before this one ends, the newer one decides and [onResult] gets the
     * verdict at the time this one ended.
     */
    @JvmOverloads
    public fun check(intent: CheckIntent, userId: String? = null, onResult: VerdictListener? = null) {
        val current: Long
        synchronized(lock) {
            val last = lastAllowedAt
            if (intent == CheckIntent.FOREGROUND && currentVerdict == NonGrataVerdict.Allowed && last != null &&
                dependencies.now() - last < configuration.foregroundInterval.toMillisSaturated()
            ) {
                deliver(onResult, currentVerdict)
                return
            }
            current = ++generation
        }
        dependencies.background.execute {
            val response = performCheck(intent, userId)
            synchronized(lock) {
                // If another check started in the meantime, that one wins.
                if (current == generation) apply(response)
                deliver(onResult, currentVerdict)
            }
        }
    }

    /**
     * Whether the app may proceed with [intent] given a verdict. [NonGrataVerdict.Unknown] lets it
     * proceed (fail-open), except [CheckIntent.SIGNUP] with `strictSignup`. A pure function of its
     * arguments and the configuration: it checks nothing.
     */
    public fun permits(verdict: NonGrataVerdict, intent: CheckIntent): Boolean = when (verdict) {
        NonGrataVerdict.Allowed -> true
        is NonGrataVerdict.Blocked -> false
        NonGrataVerdict.Unknown -> !(intent == CheckIntent.SIGNUP && configuration.strictSignup)
    }

    // Check

    /** Runs on the background executor. `null` means no answer. */
    private fun performCheck(intent: CheckIntent, userId: String?): CheckResponse? {
        val installId = synchronized(lock) {
            if (currentInstallId == null) currentInstallId = loadOrCreateInstallId()
            currentInstallId
        } ?: return null

        val installHash = hasher.hash(IdentifierKind.INSTALL, installId)
        val androidId = dependencies.identity.androidId()
            ?.takeIf { IdentifierHasher.normalize(IdentifierKind.ANDROID_ID, it).isNotEmpty() }
        // An empty user ID hashes the same for every signed-out device; one propagated ban of it
        // would block them all. Left out, like an empty ANDROID_ID (the Worker drops it as well).
        val user = userId?.takeIf { IdentifierHasher.normalize(IdentifierKind.USER, it).isNotEmpty() }
        val payload = CheckPayload(
            app = configuration.appId,
            env = configuration.environment.wireValue,
            ref = IdentifierHasher.ref(installHash),
            ids = CheckPayload.Ids(
                install = installHash,
                user = user?.let { hasher.hash(IdentifierKind.USER, it) },
                androidId = androidId?.let { hasher.hash(IdentifierKind.ANDROID_ID, it) },
            ),
            intent = intent.wireValue,
            appVersion = dependencies.identity.appVersion(),
        )

        return try {
            dependencies.transport.send(payload, configuration.endpointUrl, configuration.timeout)
        } catch (e: Exception) {
            null
        }
    }

    /** Called with `lock` held. */
    private fun apply(response: CheckResponse?) {
        when (response?.status) {
            CheckResponse.Status.OK -> {
                setLocalMark(null)
                lastAllowedAt = dependencies.now()
                setVerdict(NonGrataVerdict.Allowed)
            }
            CheckResponse.Status.BLOCKED -> {
                setLocalMark(response.ref)
                setVerdict(NonGrataVerdict.Blocked(response.ref))
            }
            null -> setVerdict(localMarkRef()?.let { NonGrataVerdict.Blocked(it) } ?: NonGrataVerdict.Unknown)
        }
    }

    /** Called with `lock` held. */
    private fun setVerdict(verdict: NonGrataVerdict) {
        if (verdict == currentVerdict) return
        currentVerdict = verdict
        dependencies.main.execute {
            for (listener in listeners) listener.onVerdict(verdict)
        }
    }

    /** Called with `lock` held. */
    private fun deliver(onResult: VerdictListener?, verdict: NonGrataVerdict) {
        if (onResult != null) dependencies.main.execute { onResult.onVerdict(verdict) }
    }

    // Local mark and installId. Called with `lock` held, so two checks can never both create an
    // installId.

    /**
     * Only creates a new `installId` when the store says there is none; if it can't be read or
     * written, returns `null` so the existing one is never overwritten. An empty file (it can only
     * come from outside the SDK, which writes atomically) counts as none.
     */
    private fun loadOrCreateInstallId(): String? = try {
        dependencies.store.read(INSTALL_ID_KEY)?.takeIf { it.isNotEmpty() }
            ?: java.util.UUID.randomUUID().toString().uppercase().also {
                dependencies.store.write(INSTALL_ID_KEY, it)
            }
    } catch (e: Exception) {
        null
    }

    private fun localMarkRef(): String? = try {
        dependencies.store.read(BLOCKED_REF_KEY)
    } catch (e: Exception) {
        null
    }

    private fun setLocalMark(ref: String?) {
        try {
            if (ref != null) {
                dependencies.store.write(BLOCKED_REF_KEY, ref)
            } else {
                dependencies.store.remove(BLOCKED_REF_KEY)
            }
        } catch (e: Exception) {
            // Like the Swift SDK: a mark that couldn't be written is retried on the next answer.
        }
    }

    private companion object {
        const val INSTALL_ID_KEY = "installId"
        const val BLOCKED_REF_KEY = "blockedRef"
    }
}
