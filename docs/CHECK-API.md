# NonGrata check API

*Español: [API-CHECK.md](es/API-CHECK.md)*

`POST /v1/device/check` is the one endpoint an app calls to ask whether its device is blocked.
The Swift SDK and the Kotlin SDK for Android ([integration guide](INTEGRATION-ANDROID.md)) are
clients of it; your app's backend can be another.
This guide gives the exact contract and the rules a client has to follow on its own side. The
OpenAPI 3.1 spec is in [check-api.yaml](check-api.yaml). The algorithm behind it is in
[section 6.1](DESIGN.md#61-post-v1devicecheck) of the design document; the admin side, in the
[Admin API guide](ADMIN-API.md).

## 1. The request

`POST https://<your-worker>/v1/device/check`, with `Content-Type: application/json`. No
authentication: the endpoint is public, and the only thing it takes from the client is hashes.
The Worker limits it per client IP (section 3).

| Field | Required | Meaning |
|---|---|---|
| `app` | yes | The app's id in the Worker, such as `myapp`. Lowercase letters, digits, `_` and `-`; 1 to 32 characters, starting with a letter or digit. |
| `ids` | yes | An object of hashes, see below. |
| `ids.install` | yes | Hash of the SDK's own `installId`. It names the device. |
| `ids.idfv`, `ids.icloud`, `ids.user` | no | More hashes. Absent or `null` means "not available". |
| `ids.android_id` | no | Hash of `Settings.Secure.ANDROID_ID`. Read only with `platform: "android"`. |
| `platform` | no | `"android"` for an Android client; see [Android clients](#android-clients). Absent, `"ios"` or any other value is the iOS path, not validated. |
| `env` | no | `"development"` or `"production"`. Default `"production"`. It picks the DeviceCheck endpoint the Worker uses. |
| `intent` | no | `"launch"`, `"foreground"`, `"login"`, `"signup"` or `"refresh"`. Default `"launch"`. Only logged. |
| `dc_token` | no | DeviceCheck token to query the bits. |
| `dc_token_update` | no | A second DeviceCheck token, to write the bits. |

Any other value is a `400`: an `app` that does not match the format, an `env` or `intent` outside
the lists, a hash or token that does not match its format, a body that is not a JSON object.
`null` counts as absent for `env`, `intent`, `dc_token`, `dc_token_update` and each id.

**Unknown fields are ignored.** The Swift SDK also sends `ref` and `app_version`; the Worker reads
neither. The Swift SDK sends `platform: "ios"`, which changes nothing: only `"android"` does.

### Hashes

A hash is 64 lowercase hexadecimal characters (`^[0-9a-f]{64}$`); uppercase is a `400`. The
client computes it as `SHA-256(prefix:kind:value)`. See [section 4](#4-rules-the-client-follows).

Without `platform: "android"`, the kinds the check reads are `idfv`, `install`, `icloud` and
`user`; an `ids.android_id` is ignored. With it, the kinds are `install`, `user` and `android_id`.
See [Android clients](#android-clients).

### `ref`

The `ref` is the first 8 characters, uppercased, of the `install` hash. **The Worker derives it
and never uses the one the client sends.** It is the support code the user reads out and the
value for an [unban by `ref`](ADMIN-API.md).

### Tokens

`dc_token` and `dc_token_update` are DeviceCheck tokens in base64 (the alphabet of base64 and
base64url, with or without `=`), 16 to 8192 characters (`^[A-Za-z0-9+/=_-]{16,8192}$`). A token
that does not match is a `400`, not an omission: send `null` if you have none.

Apple asks not to reuse a token, so the client generates two for each check:

- `dc_token` is used to **query** the device's bits.
- `dc_token_update` is used to **write** them (set `bit0` after a ban, clear it after an unban).

Without `dc_token_update` the Worker still queries and decides, but it writes nothing to Apple
and does not consume a pending unban. It tries again on the next check that carries both. In
`update_two_bits` the Worker only sends `bit0`.

### Android clients

A client without DeviceCheck sends `"platform": "android"`. The minimum request:

```json
{
  "app": "myapp",
  "platform": "android",
  "ids": { "install": "<64 hex>" }
}
```

With `platform: "android"`:

- The ids read are `install` (required), `user` and `android_id`.
- It is a `400` if the body carries a non-null `dc_token` or `dc_token_update`, or a non-null
  `ids.idfv` or `ids.icloud`. `null` is fine.
- The Worker never calls Apple for the request, even if the app has an Apple key: no query and no
  `bit0` write. A pending unban by `ref` is consumed with D1 alone, as in an app without an Apple
  key.
- The list is the same as iOS's (same `app`): a ban by `user` reaches the person on both
  platforms.
- Propagation includes `android_id` like any other hash. A blocked Android device propagates its
  `android_id`, so a reinstall (a new `install` and the same `ANDROID_ID`) stays blocked.

## 2. The response

`200` with `cache-control: no-store` and

```json
{ "status": "ok", "ref": "C1456573" }
```

`status` is `"ok"` or `"blocked"`; `ref` is the device's support code.

| Code | Body | When |
|---|---|---|
| `200` | `{status, ref}` | The check ran. |
| `400` | `{"error":"bad_request"}` | Body is not JSON, or a field fails its format (section 1). |
| `404` | `{"error":"unknown_app"}` | The body is valid, but the Worker has no `HASH_PREFIX_<APP>` for `app`. |
| `429` | `{"error":"rate_limited"}` | Over the rate limit (section 3). Checked before the body is read. |
| other | | A network or platform error (a `5xx`, a Cloudflare error page). |

The order is: rate limit, then JSON, then format (`400`), then app (`404`). So a malformed body
for an unknown app is a `400`.

**A client treats anything but a `200` with `{status, ref}` as "no answer"**, whatever the cause,
and falls into fail-open (section 4). A `400` is not a verdict. An older Worker answers `400` to
`intent: "refresh"`, because it does not know it.

## 3. What the server does

- **Rate limit.** If the Worker has the `RATE_LIMITER` binding, each client IP gets a quota
  (`limit: 20` per `period: 60` seconds in the example deployment); the `429` comes first. Without
  the binding there is no limit. Retrying immediately after a `429` is useless: treat it as no
  answer.
- **Observation mode.** If the app's `ENFORCE_<APP>` is not exactly `"true"`, the Worker answers
  `ok` even for a blocked device, logs `blocked`, and changes nothing else: it does not write
  `bit0` and does not propagate. A client cannot tell the mode apart from the response.
- **No Apple key.** An app without `APPLE_*` secrets decides from D1 alone. `dc_token` and
  `dc_token_update` are then accepted and ignored.
- **Apple fails.** If DeviceCheck errors, the decision uses D1 alone.
- **Android.** With `platform: "android"` the Worker never asks Apple, whatever the app has
  configured (see [Android clients](#android-clients)).
- **Empty user.** The hash of an empty `user` (`""`, or only spaces and line breaks before
  normalizing) is the same for every device that sends it. The Worker drops it before anything
  else: it does not match, is not propagated and is not linked. A client should not send it (the
  Kotlin SDK leaves it out); a ban of that hash never matches.
- **Propagation.** With `ENFORCE` on, a blocked device (by hash or by `bit0`) has all its hashes
  stored as banned, so the block jumps to another device with the same `icloud` hash.
- **User links (optional).** With `LINK_USERS_<APP>=true`, the Worker remembers which `user`
  hashes each `install` has sent and also checks those. A ban by `user` then reaches the device
  even when it is signed out or the account changed. Without it, only the `user` hash in the
  request counts. The client does nothing different. See
  [section 6.5](DESIGN.md#65-user-device-links-optional-per-app) of the design.
- **Unban by `ref`.** When an admin unbans by `ref`, the next check from that device answers `ok`
  and clears `bit0` and the device's hashes. If Apple is down, or the app has a key and the
  request lacks `dc_token` or `dc_token_update`, the device is let in and the unban waits for the
  next check. The last decision wins: a manual ban made afterwards cancels the pending unban.
- **Nothing raw is stored.** The Worker keeps hashes, `ref`s and the verdict of each check, never
  identifiers or IPs.

## 4. Rules the client follows

These rules live in the Swift SDK (`swift/Sources/NonGrata/`) and the Kotlin SDK
(`android/nongrata/`; [guide](INTEGRATION-ANDROID.md)), which have the same behavior except where
the platform differs. A client for another platform has to follow them for lists and bans to agree.

### Normalization and hash

`SHA-256(prefix + ":" + kind + ":" + normalized value)`, over UTF-8, as lowercase hex. The
`prefix` is the app's `HASH_PREFIX_<APP>` (such as `myapp-ban-v1`); the client is configured
with the same one. Normalization, before hashing:

1. Strip space, tab, `\n` and `\r` from both ends.
2. `idfv` and `install`: turn `a-z` into uppercase (ASCII only).
3. `user` and `android_id`: turn `A-Z` into lowercase (ASCII only).
4. `icloud`: keep as it is.

The vectors in [spec/hash-vectors.json](../spec/hash-vectors.json) pin the result; a new client
should pass them. See [hash and ref](concepts/hash-and-ref.md). Reference code:
`IdentifierHasher.swift` and `worker/src/hash.ts`.

### The `installId`

A random UUID the client creates once (`UUID().uuidString`) and keeps in the Keychain under the
service `nongrata`, account `installId`, accessible after first unlock and not synced to other
devices (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). The rule that matters: it creates
a new one only when it knows there is none. If the store fails to read, the client does not
overwrite it, sends no check, and retries on the next one. The app must not delete that item.

### Fail-open

Only a `200` with `{status, ref}` is an answer. Any other outcome (no network, timeout, `400`,
`404`, `429`, `5xx`, a body that does not parse) is "no answer", and then:

- With a local block mark, the device stays blocked.
- Without one, the verdict is unknown and the app carries on, **except** `intent = signup` with
  strict mode, where the app must not create the account. Strict mode is the SDK's
  `strictSignup`, on by default.

### The local block mark

- A `blocked` answer writes the `ref` as a mark. An `ok` answer deletes it. An error touches
  nothing. The mark is the Keychain item `blockedRef`, plus, if iCloud is used, the key
  `nongrata.<app>.blockedRef` in the iCloud key-value store, so a device signed in to the same
  Apple account blocks live.
- When the app starts, a mark means blocked from the first instant, before any check.
- If two checks overlap, the one that started last decides.

### When to check and how often

- `launch`, `login`, `signup` and `refresh` are sent every time they are called.
- `foreground` is skipped (no request) when the current verdict is `allowed` and the last allowed
  answer is younger than `foregroundInterval` (6 hours by default). While blocked or unknown, it
  always checks, so it finds out about an unban. That time is kept in memory only.
- **`refresh` is never limited.** It is for a check the app forces: its own push arrived, its
  backend reported a blocked account, a timer while the app is open.
- A ban reaches a device on its next check, not when it is made. See
  [how soon a ban takes effect](INTEGRATION-IOS.md#how-soon-a-ban-takes-effect).

### Timeouts and tokens

The SDK waits at most 5 s for the request and for each token (`timeout`), and 2 s for the iCloud
ID (`iCloudTimeout`). If the device cannot make tokens (the simulator), it sends both as `null`;
the Worker then decides from D1 alone. If it gets only one token, that one goes as `dc_token` and
`dc_token_update` is `null`.

## 5. Example

Request, for the app `myapp` with the prefix `myapp-ban-v1`:

```http
POST /v1/device/check HTTP/1.1
Host: nongrata-myapp.your-subdomain.workers.dev
Content-Type: application/json

{
  "app": "myapp",
  "env": "production",
  "intent": "launch",
  "dc_token": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/",
  "dc_token_update": "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3",
  "ids": {
    "idfv": "b55ea8ae1f1ece0d1fd58ce1ebdf9c6573beedb75ef78b13335904980c55c408",
    "install": "c1456573e3a96b15719a3522e962118ab1277207541d95b4ff72c2ea9de08b10",
    "icloud": null,
    "user": null
  }
}
```

The smallest valid body is `{"app":"myapp","ids":{"install":"<64 hex>"}}`.

Response:

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store

{"status":"ok","ref":"C1456573"}
```

The same device, once banned (with `ENFORCE_MYAPP` on): `{"status":"blocked","ref":"C1456573"}`.
