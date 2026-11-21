# NonGrata for Android

The Kotlin SDK for Android: the `nongrata` library module, package `io.github.wilderlopez.nongrata`,
`minSdk 26`. It asks the Worker's `POST /v1/device/check` whether the device is blocked, with
`"platform": "android"` and the hashes of three identifiers: its own `installId`, the app's user ID
and `ANDROID_ID`. It behaves like the Swift SDK (`swift/Sources/NonGrata/`); the contract it follows
is in [CHECK-API.md](../docs/CHECK-API.md). It has no runtime dependency besides the Kotlin standard
library, and no UI: the app draws its own blocking screen.

It is not published to Maven Central yet. An app consumes it from a checkout of this repo.

## Build and test

You need JDK 17 and the Android SDK with `platforms;android-36` and `build-tools;37.0.0`, found
through `ANDROID_HOME` (or `sdk.dir` in a `local.properties`, which git ignores). Gradle comes from
the wrapper.

```sh
make test-android     # unit tests on the JVM: no emulator, no network
make build-android    # builds the demo app (assembleDebug)
```

Or directly: `cd android && ./gradlew :nongrata:testDebugUnitTest`. The tests read
`spec/hash-vectors.json` from the repo.

## Use it from an app

In the app's `settings.gradle.kts`, point at this directory:

```kotlin
includeBuild("../path/to/nongrata/android")
```

and in the app module, with no version (the included build provides it):

```kotlin
dependencies {
    implementation("io.github.wilderlopez:nongrata")
}
```

Create one instance when the app starts and check:

```kotlin
val nonGrata = NonGrata(
    context,
    NonGrataConfiguration(
        endpoint = "https://nongrata-myapp.example.workers.dev/v1/device/check",
        appId = "myapp",
        hashPrefix = "myapp-ban-v1",
    ),
)
nonGrata.check(CheckIntent.LAUNCH)
nonGrata.addListener { verdict -> /* main thread: show or hide the blocking screen */ }
nonGrata.check(CheckIntent.SIGNUP, userId) { verdict ->
    if (nonGrata.permits(verdict, CheckIntent.SIGNUP)) createAccount()
}
```

`Examples/NonGrataDemoAndroid` is a minimal app that does this. Its Worker values go in
`nongrata.local.properties` (copy `nongrata.local.properties.example`; git ignores the copy); its
[README](../Examples/NonGrataDemoAndroid/README.md) explains how to run it and what to try.

## Supply chain

- `gradle/wrapper/gradle-wrapper.properties` pins the Gradle distribution with
  `distributionSha256Sum`.
- `gradle/verification-metadata.xml` holds the SHA-256 of every artifact the build resolves,
  plugins included; a file that does not match fails the build. The demo has its own, because
  Gradle only reads the root build's file.
- Android's groups (`com.android.*`, `androidx.*`) come only from Google's repository and
  everything else only from Maven Central.
- Versions are exact, in `gradle/libs.versions.toml`.

After changing a version, regenerate both files and review the diff:

```sh
(cd android && ./gradlew --write-verification-metadata sha256 build)
(cd Examples/NonGrataDemoAndroid && ./gradlew --write-verification-metadata sha256 build)
```

`aapt2` is a different artifact for each host OS. Gradle only writes the one for the machine it
runs on, so the demo's file also lists the Linux and Windows `aapt2` jars by hand; add them again
when AGP changes.
