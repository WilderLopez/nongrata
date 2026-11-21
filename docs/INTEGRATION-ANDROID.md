# Integrating NonGrata into an Android app

*Español: [INTEGRACION-ANDROID.md](es/INTEGRACION-ANDROID.md)*

The Kotlin SDK lives in `android/` (module `nongrata`, package `io.github.wilderlopez.nongrata`).
It asks the same Worker as the iOS app, with the same list, whether the device is blocked. If you
have read the [iOS guide](INTEGRATION-IOS.md), most of this is the same; section 7 lists what
differs.

## 1. Requirements

- `minSdk 26` (Android 8.0). The SDK is built with JDK 17 and the Android Gradle Plugin and Gradle
  versions pinned in the repo (`android/gradle/libs.versions.toml` and
  `android/gradle/wrapper/gradle-wrapper.properties`); your app needs a toolchain that can read a
  module built with them.
- The `INTERNET` permission. The library's manifest declares it, so it is merged into your app
  and you add nothing.
- No runtime dependency besides the Kotlin standard library, and no UI.

## 2. Installation

NonGrata is not on Maven Central yet. For now an app consumes it from a checkout of this repo,
with a Gradle composite build, as `Examples/NonGrataDemoAndroid` does.

1. Put the repo where your app can see it: a clone next to your project, or a git submodule.
2. In the app's `settings.gradle.kts`, point at the `android/` directory:

   ```kotlin
   includeBuild("../path/to/nongrata/android")
   ```

3. In the app module, with no version (the included build provides it):

   ```kotlin
   dependencies {
       implementation("io.github.wilderlopez:nongrata")
   }
   ```

**Pin it.** A checkout of `main` changes under you. Check out a release tag (`0.3.0` or later: the first
with `android/`) or a commit, and in a submodule commit that pointer, so every build uses the same SDK.
Before 1.0 a minor bump may break the API.

**Dependency verification.** Gradle reads `gradle/verification-metadata.xml` only from the root
build, which is your app: the SDK's own file is ignored when it is included. If your app uses
verification, regenerate yours after adding the SDK
(`./gradlew --write-verification-metadata sha256 build`) and review the diff. The SDK pulls in
nothing at runtime; what appears are the Android Gradle Plugin's build artifacts. The
[Android README](../android/README.md) explains how the repo pins its own.

## 3. The Worker

The app talks to the **same Worker and the same list as iOS**: same `app` and same
`HASH_PREFIX_<APP>` in the configuration. A ban by `user` then reaches the person on both
platforms. If the app is new on the Worker, create it as in the iOS guide; there is nothing to
configure in Apple's portal for Android.

An existing Worker needs two things before an Android build checks against it:

- The code that understands `platform: "android"` (the [check API](CHECK-API.md#android-clients)).
  Without it the Worker takes the iOS path and ignores `android_id`.
- Migration `0006`, which adds `check_log.platform`. Without it **every check fails with a
  `500`**, and the apps fall into fail-open. See
  "Upgrading to the platform column" in the [Admin API guide](ADMIN-API.md) and apply it
  before deploying.

An Android check never reaches Apple, even if the app has a DeviceCheck key.

## 4. Configuration

Create **one instance** for the whole app, in your `Application`, and check right away:

```kotlin
class MyApplication : Application() {
    lateinit var nonGrata: NonGrata
        private set

    override fun onCreate() {
        super.onCreate()
        nonGrata = NonGrata(
            this,
            NonGrataConfiguration(
                endpoint = "https://<worker>/v1/device/check",
                appId = "myapp",
                hashPrefix = "myapp-ban-v1",   // same as the Worker's HASH_PREFIX_MYAPP
            ),
        )
        nonGrata.check(CheckIntent.LAUNCH)
    }
}
```

Declare it in the manifest (`android:name=".MyApplication"`). `endpoint` is the full URL of
`POST /v1/device/check`; the constructor throws `IllegalArgumentException` if it is not an
absolute `http(s)` URL, so a typo fails at startup and not on the first check. The other
parameters have defaults:

| Parameter | Default | |
|---|---|---|
| `environment` | `PRODUCTION` | Sent as `env`; for the check log only, because an Android check never calls Apple. |
| `strictSignup` | `true` | With `SIGNUP`, creating the account requires `Allowed`. |
| `foregroundInterval` | 6 hours | Minimum gap between `FOREGROUND` checks while allowed. |
| `timeout` | 5 seconds | To connect and, separately, to read the answer. |

The constructor reads two small files on the calling thread, so a device that was blocked is
`Blocked` from the first instant, before any check. The checks themselves run on a background
thread.

## 5. When to check

| Moment | Call |
|---|---|
| On launch | `nonGrata.check(CheckIntent.LAUNCH)` |
| On returning to the foreground | `nonGrata.check(CheckIntent.FOREGROUND)` (throttles itself to one every `foregroundInterval` while allowed) |
| After a successful login | `nonGrata.check(CheckIntent.LOGIN, userId)` |
| Before creating the account | see below |
| When something may have changed | `nonGrata.check(CheckIntent.REFRESH)` (never throttled) |

The SDK has no dependency on `androidx.lifecycle`, so it does not detect the foreground on its
own. Call `FOREGROUND` from where your app already knows it: `Activity.onStart`, or
`ProcessLifecycleOwner` if you use it.

Before creating an account:

```kotlin
nonGrata.check(CheckIntent.SIGNUP) { verdict ->
    if (nonGrata.permits(verdict, CheckIntent.SIGNUP)) {
        createAccount()
    } else {
        // Blocked: the suspended screen.
        // Unknown in strict mode: "Couldn't complete sign-up. Please try again."
    }
}
```

`permits(verdict, intent)` applies fail-open: `Unknown` lets everything through except `SIGNUP`
with `strictSignup`.

### The `userId`

Pass the user's ID on every check made with a session, not only on login: a ban by `user`
reaches a device on a check that carries that user. Capitals do not matter (the SDK and the Worker
lowercase A-Z before hashing). If your Worker has user links on, see
[Banning by user ID](INTEGRATION-IOS.md#banning-by-user-id).

**Never pass an empty `userId`.** The SDK drops a `userId` that is empty or only spaces and line
breaks, and sends the check without a user. The reason is that the hash of an empty user is the
same on every signed-out device: if that one hash were ever banned, and propagated, it would block
everyone who is signed out. Pass `null` (or nothing) when there is no session. The Worker drops it
too ([check API](CHECK-API.md#3-what-the-server-does), "Empty user"), but a client should not
count on that.

### How soon a ban takes effect

The same as on iOS: a ban reaches a device on its **next check**, not when you make it. Launch,
login and sign-up always check; `FOREGROUND` is skipped while the last allowed verdict is younger
than `foregroundInterval`. The three levers in
[the iOS guide](INTEGRATION-IOS.md#how-soon-a-ban-takes-effect) apply unchanged: lower
`foregroundInterval`, check on a short timer while the app is open, and call `REFRESH` when you
know something changed. A timer in Kotlin:

```kotlin
private val handler = Handler(Looper.getMainLooper())
private val tick = object : Runnable {
    override fun run() {
        nonGrata.check(CheckIntent.FOREGROUND)   // sends at most one per foregroundInterval
        handler.postDelayed(this, 60_000)
    }
}
// onStart: handler.post(tick)       onStop: handler.removeCallbacks(tick)
```

The Worker sends no push and stores no push token. An unban has no wait: a blocked device checks
on every `FOREGROUND`.

## 6. Blocking

`NonGrata.verdict` is `Allowed`, `Blocked(ref)` or `Unknown`. Listen to changes, and read the
current one when a screen starts:

```kotlin
private val listener = NonGrata.VerdictListener { verdict ->
    if (verdict is NonGrataVerdict.Blocked) showSuspended(verdict.ref)   // log out, show your screen
    else hideSuspended()
}

override fun onStart() {
    super.onStart()
    nonGrata.addListener(listener)
    listener.onVerdict(nonGrata.verdict)
}
override fun onStop() {
    nonGrata.removeListener(listener)
    super.onStop()
}
```

- Listeners and the `check` callback are called **on the main thread**. Add them from the main
  thread, and remove them when the screen goes away: the SDK holds them strongly.
- With `Blocked(ref)`, log the user out and show your suspended screen with the `ref` as the
  support code. **The SDK imposes no UI and never closes the app.** Do not close it
  programmatically either; the screen stays put.
- `nonGrata.supportCode` is the same 8-character `ref` for this device, available from any thread
  (`null` only if the storage could not be read). Show it in "Contact support" and ask for it.
  `nonGrata.installId` is the SDK's own UUID, for analytics: send it to your backend to
  cross-reference accounts.
- **The local block mark** is a file in `noBackupFilesDir`. A `blocked` answer writes the `ref`
  there; only an `ok` deletes it. A network error, a timeout or a `5xx` touches nothing: a blocked
  device stays blocked offline, and a device that was never blocked stays `Unknown` and gets in
  (fail-open). The block is lifted only when the Worker answers `ok`, for example after an unban by
  `ref`.

Do not delete the SDK's files (`<noBackupFilesDir>/nongrata/`) in any cleanup your app does after
a reinstall or an update. If you clear that directory, you lose the `installId` and the block mark.

## 7. Differences with iOS

- **No DeviceCheck and no `bit0`, no iCloud.** On iOS a ban survives a reinstall because Apple
  keeps a bit for the device. Android has no equivalent in this version. There are three
  identifiers: `install`, `user` and `android_id`.
- **The `installId` does not survive an uninstall.** It lives in `noBackupFilesDir`, which Auto
  Backup never copies, so a restore on a new phone does not clone the `ref`; the price is that
  uninstalling deletes it. What brings a banned device back is `ANDROID_ID`: when a blocked device
  checks, the Worker propagates its hash, so the reinstalled app (new `install`, same
  `ANDROID_ID`) stays blocked.
- **`ANDROID_ID` has limits.** It survives an uninstall and reinstall as long as the app is signed
  with the same key. It may change after a factory reset, and each user of a multi-user device
  sees a different value (as a separate device). Before Android 8 it was shared by every app, but
  `minSdk 26` rules that out. Google does not forbid it for abuse prevention, but it is not a
  guarantee: someone who resets the phone and changes accounts is a new device. See
  [design, section 15](DESIGN.md#15-android).
- **Callbacks on the main thread, not `async`.** `check` returns immediately and calls
  `onResult` (and the listeners) on the main thread. The Swift `await` has no Kotlin equivalent
  here.
- **Monotonic clock.** The `FOREGROUND` throttle uses `SystemClock.elapsedRealtime`, so changing
  the date on the phone does not skip or extend it. Like on iOS, it is kept in memory: when the
  process dies, the next `FOREGROUND` checks.
- **It does not follow redirects.** Only a `200` with `{status, ref}` is an answer; a `3xx` is no
  answer (fail-open), not a second request. Use the Worker's final URL, with no redirect in front.
- If two checks overlap, the one that started last decides, the same as on iOS.

## 8. Privacy

- **Play Console, "Data safety" form.** Declare "Device or other IDs" (the `install` ID and
  `ANDROID_ID`) and "User IDs" (the `user` ID, if you pass it), both **collected** and **not
  shared**, with the purpose "Fraud prevention, security, and compliance". Nothing in the form
  exempts an identifier because it is hashed, so declare them even though the Worker only keeps
  hashes.
- **Privacy policy.** Mention device identifiers used for fraud prevention. With
  `LINK_USERS_<APP>` on, the Worker keeps a hash of the user ID linked to a hash of the install ID
  for 180 days after the last time seen; say so.
- The Worker never stores raw identifiers or IPs. It checks that from its side; the SDK only sends
  hashes.

## 9. Trying it

- **The demo app**, `Examples/NonGrataDemoAndroid`, consumes the SDK with `includeBuild` and has a
  button for each kind of check, a field for the `userId` and the verdict and support code on
  screen. Copy `nongrata.local.properties.example` to `nongrata.local.properties` (git ignores
  the copy) and fill in your Worker's URL, `appId` and `hashPrefix`; without it the demo builds
  with placeholders and every check ends in `Unknown`. `make build-android` builds it.
- **The emulator** is enough: the SDK uses no Google services, so an AOSP image works as well as
  one with Google Play. The emulator has its own `ANDROID_ID`, and a wipe changes it, which is a
  quick way to try a "factory reset".
- **A ban end to end.** Run the demo, type a user ID and tap Login, ban it from the CLI
  (`pnpm ng ban app=myapp kind=user value=<that user ID>`, see the [Admin API](ADMIN-API.md)
  guide), tap a check, and the verdict becomes `Blocked`. Unban by the `ref` it shows
  (`pnpm ng unban app=myapp ref=<ref>`) and check again: `Allowed`. Use an `ENFORCE` Worker; in
  observation mode it answers `ok` whatever the list says.
- **The SDK's own tests**: `make test-android` runs them on the JVM, with no emulator and no
  network. They read the hash vectors in `spec/hash-vectors.json`.

## 10. Other platforms

The exact contract of the check, for a client that is not this SDK, is in the
[check API guide](CHECK-API.md).
