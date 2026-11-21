# NonGrata Demo for Android

A minimal app to see the Kotlin SDK working against a real Worker, on the emulator or on a phone:
ban a user from the terminal, watch the verdict change, go offline, reinstall, unban with the
support code.

It consumes the SDK straight from this repo (`includeBuild("../../android")` in
`settings.gradle.kts`), as the [integration guide](../../docs/INTEGRATION-ANDROID.md) describes,
and creates its one `NonGrata` in `DemoApplication`, which checks with `LAUNCH` when the app
starts.

## What the screen shows

| Row | Meaning |
|---|---|
| Verdict | `Allowed`, `Blocked (<ref>)` or `Unknown (no answer, no local mark)`. It follows the SDK's listener. |
| Support code | The device's `ref`, the 8 characters to read out to support and to unban with. |
| installId | The SDK's own UUID, kept in `noBackupFilesDir`. |
| Worker | The URL, `appId` and `hashPrefix` the app was built with. |
| User ID | Optional. Whatever you type goes as `userId` with every button; empty sends no user. |
| Check buttons | One per intent: launch, foreground, login, sign-up and refresh. |
| Last check | The intent and the verdict its callback received. For sign-up, also whether `permits` lets the account be created. |

Coming back to the app from the background checks with `FOREGROUND`, which the SDK skips while the
device is allowed and was checked less than 6 hours ago. Every check the screen makes is printed to
logcat with the tag `NonGrataDemo`.

## Configure

You need a deployed Worker reachable over `https` (see the [Quick start](../../README.md#quick-start)). Use one
with `ENFORCE_<APP> = "true"`: in observation mode it answers `ok` whatever the list says.

```sh
cd Examples/NonGrataDemoAndroid
cp nongrata.local.properties.example nongrata.local.properties   # git ignores the copy
```

and fill in:

| Key | Value |
|---|---|
| `nongrata.workerUrl` | The Worker's base URL, such as `https://nongrata-myapp.example.workers.dev`. The app adds `/v1/device/check`. |
| `nongrata.appId` | The app's id in the Worker, such as `myapp`. |
| `nongrata.hashPrefix` | The same value as the Worker's `HASH_PREFIX_<APP>`, such as `myapp-ban-v1`. |

The values are compiled into the app (`BuildConfig`): build again after changing them. Without the
file the app builds with the placeholders of the example, and every check ends in `Unknown`.

A local `wrangler dev` does not work as is: it serves plain `http`, and Android blocks cleartext
traffic unless the app's network security config allows it, which the demo does not.

## Build and install

You need JDK 17 and the Android SDK with `platforms;android-36`, `build-tools;37.0.0` and
`platform-tools` (for `adb`), found through `ANDROID_HOME`. From the repo root:

```sh
make build-android   # or: cd Examples/NonGrataDemoAndroid && ./gradlew assembleDebug
```

The APK is `Examples/NonGrataDemoAndroid/app/build/outputs/apk/debug/app-debug.apk`.

An emulator is enough; the SDK uses no Google services, so an image without Google Play works.
To create and start one (on an Intel Mac or PC, `x86_64` instead of `arm64-v8a`):

```sh
sdkmanager "emulator" "system-images;android-36;default;arm64-v8a"
avdmanager create avd -n nongrata-36 -k "system-images;android-36;default;arm64-v8a"
"$ANDROID_HOME/emulator/emulator" -avd nongrata-36
```

Then install and open the app, and follow its log:

```sh
adb install -r Examples/NonGrataDemoAndroid/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.wilderlopez.nongrata.demo/.MainActivity
adb logcat -s NonGrataDemo
```

A phone with USB debugging works the same way.

## Try it

From the repo root, with `NONGRATA_URL_MYAPP` and `NONGRATA_ADMIN_TOKEN_MYAPP` in your environment
(use your own `appId` in place of `myapp`; see the [Admin API guide](../../docs/ADMIN-API.md)):

| Step | Do | Expect |
|---|---|---|
| 1 | Open the app | `Allowed` after the launch check, and a support code. `Unknown` means the Worker did not answer: check the URL and the `appId`. |
| 2 | Type a user ID and tap "Check: login". Then `pnpm ng ban app=myapp kind=user value=<that user ID>` and tap "Check: refresh" | `Blocked (<ref>)`, with the support code shown above. |
| 3 | Turn on airplane mode (`adb shell cmd connectivity airplane-mode enable`), close the app (`adb shell am force-stop io.github.wilderlopez.nongrata.demo`) and open it again | Still blocked: the SDK keeps the block mark on the device, and an error never clears it. |
| 4 | Turn airplane mode off. Uninstall (`adb uninstall io.github.wilderlopez.nongrata.demo`), install again, open it and leave the user ID empty | A new `installId` and support code, and still `Blocked`: the Worker stored the device's `ANDROID_ID` hash when it was blocked, and the reinstalled app sends the same one. |
| 5 | `pnpm ng unban app=myapp ref=<the code on screen>` and tap "Check: refresh" with the user ID empty | `Allowed`. |
| 6 | With airplane mode on, clear the app's data (`adb shell pm clear io.github.wilderlopez.nongrata.demo`), open it and tap "Check: sign-up" | `Unknown`: no answer and no mark lets the app through (fail-open), except sign-up, which is refused because `strictSignup` is on. |

The user from step 2 stays banned until you unban it too
(`pnpm ng unban app=myapp kind=user value=<that user ID>`): type it again and the device is blocked
again. When you finish, unban everything you banned.

Wiping the emulator's data (`emulator -avd nongrata-36 -wipe-data`) gives it a new `ANDROID_ID`,
like a factory reset: a quick way to see the limit of banning by device on Android, explained in
the guide's [differences with iOS](../../docs/INTEGRATION-ANDROID.md#7-differences-with-ios).

## License

[MIT](../../LICENSE).
