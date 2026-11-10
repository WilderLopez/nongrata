# Integrating NonGrata into an iOS app

*Español: [INTEGRACION-IOS.md](es/INTEGRACION-IOS.md)*

## 1. Dependency

Swift Package Manager, pinned to a version tag:

- In Xcode: File → Add Package Dependencies… → `https://github.com/WilderLopez/nongrata.git`,
  rule "Up to Next Minor Version" from `0.2.0` (before 1.0, a minor bump may break things).
- Products: `NonGrata` (required) and `NonGrataUI` (optional, the suspended screen).
- If you use a private fork, Xcode needs your GitHub account in Settings → Accounts and, if the
  app builds on Xcode Cloud, you have to grant it access to that repo from App Store Connect.

`Package.swift` is at the root of the repo (SPM does not resolve a remote package in a
subfolder); the code still lives in `swift/`.

## 2. App ID capabilities

- DeviceCheck needs no entitlement, but the app must belong to the developer team whose key
  the Worker uses. The key and the app have to be in the **same team**: an app from another
  team needs its own DeviceCheck key.
- **Register an explicit App ID for the bundle ID** (Certificates, IDs & Profiles → Identifiers,
  no capabilities needed). Observed on 2026-11-10: with an app signed only through the team's
  wildcard App ID, the device generates tokens but Apple answers the Worker with
  `400 Bad Authorization Token`, so the Worker never gets `bit0` and decides with its list only.
  A few minutes after registering the App ID, the same build worked. App Store apps always have
  one; this mostly bites test and demo apps.
- Only with `useICloud: true`: iCloud with CloudKit (default container) and key-value storage
  (`com.apple.developer.ubiquity-kvstore-identifier`). Without CloudKit, `useICloud` makes the
  app fail when reading the iCloud ID.

## 3. Configuration

```swift
let nonGrata = NonGrata(configuration: .init(
    endpoint: URL(string: "https://<worker>/v1/device/check")!,
    appId: "myapp",
    hashPrefix: "myapp-ban-v1",   // same as the Worker's HASH_PREFIX_MYAPP
    useICloud: true
))
```

Create a single instance for the whole app. It is `@MainActor` and `@Observable`, so the UI can
observe `verdict` directly.

## 4. When to check

| Moment | Call |
|---|---|
| On launch | `await nonGrata.check(intent: .launch)` |
| On returning to the foreground | `await nonGrata.check(intent: .foreground)` (throttles itself to one every `foregroundInterval` while not blocked) |
| After a successful login | `await nonGrata.check(intent: .login, userId: user.id)` |
| Before creating the account | see below |

```swift
let verdict = await nonGrata.check(intent: .signup)
guard nonGrata.permits(verdict, for: .signup) else {
    // .blocked: suspended screen.
    // .unknown in strict mode: "Couldn't complete sign-up. Please try again."
    return
}
createAccount()
```

`permits(_:for:)` applies fail-open: `.unknown` lets everything through except `.signup` with
`strictSignup`.

## 5. Blocking

- With `verdict == .blocked(ref:)`, log the user out and show your suspended screen with the
  `ref` as the support code. The SDK does not impose a UI.
- **Do not close the app programmatically.** The screen stays put; deliberately closing the app
  can be seen as a crash in App Store review.
- The block is lifted only when the Worker responds `ok` (for example, after an unban by `ref`),
  on the next return to the foreground.

### Default screen (optional)

If you don't want to design your own, also add the `NonGrataUI` product. It only draws: it does
not log out, does not navigate and does not close the app.

```swift
import NonGrataUI

RootView()
    .nonGrataBlockingOverlay(nonGrata) { ref in
        Button("Contact support") { openSupportMail(ref: ref) }
    }
```

- It covers the content only on `.blocked(ref:)` and removes itself when the Worker responds
  `ok`. On `.unknown` it does nothing (fail-open).
- Underneath, the content is disabled and hidden from VoiceOver.
- The support code is selectable so it can be copied, and VoiceOver spells it out.
- Default texts in English (base) and Spanish. To change them, pass `title:` and `message:` as
  a `LocalizedStringResource` from your own catalog.
- If you'd rather place it yourself (for example in another window or after logging out), use
  `NonGrataSuspendedView(ref:)` directly.

## 6. Keychain

The SDK stores `installId` and the block flag in the Keychain under the `keychainService`
service (`nongrata` by default). **Do not delete them** in the first-launch cleanup that some
apps do after a reinstall. If the app wipes its whole Keychain, exclude that service.

## 7. Analytics and support

- `nonGrata.installId`: own UUID, stable across reinstalls. Send it to the app's backend too,
  even as free text, to cross-reference accounts.
- `nonGrata.supportCode`: the 8-character `ref` to ask the user for in support.

## 8. Privacy

- App Store privacy label: "Device ID" and "User ID" for fraud prevention.
- Privacy policy: mention device identifiers used for fraud prevention.
- This use is not tracking, so no App Tracking Transparency prompt is needed (verified on
  2026-11-02; [design](DESIGN.md), section 16, item 5).
