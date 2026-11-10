# Admin devices: pairing and signed requests

*Español: [EMPAREJAMIENTO.md](es/EMPAREJAMIENTO.md)*

> **Status: approved; implemented in the Worker (migration `0003`) and the CLI (`pnpm ng pair`,
> `pnpm ng devices`).** Not in a released version yet. The details settled while implementing it
> are folded in below; the client side (section 7) is the Dashboard app's.

Today every admin client authenticates with the Worker's `ADMIN_TOKEN` (see the
[Admin API guide](ADMIN-API.md)). That is fine for a terminal, but a phone app that administers
real bans needs something better than a pasted shared secret. This document specifies how an
**admin device** (for example the NonGrata Dashboard app on an iPhone, iPad or Mac) pairs with a
Worker once, keeps a private key that never leaves its Secure Enclave, and signs every request.

Nothing here is specific to one app: any client that can keep a P-256 key can use it.

## 1. Overview

```text
 terminal (ADMIN_TOKEN)              Worker                         device
 ──────────────────────              ──────                         ──────
 pnpm ng pair role=admin ──POST /v1/admin/pairings──▶ pairing (pending, 10 min)
 shows QR  ◀───────── id, secret, pair_url ─────────
                                                    ◀──POST /v1/pair/claim── scans QR, creates
                                                        id, secret, public    P-256 key in the
                                                        key, proof            Secure Enclave
                                     pairing claimed ──── device_id, code ──▶ shows code 123456
 polls, shows "iPhone · 123456" ──GET /v1/admin/pairings/{id}──▶
 admin compares codes, types y ───POST …/{id}/approve──▶ device active
                                                    ◀──signed GET /v1/admin/me── active
```

1. The admin runs `pnpm ng pair`. The Worker creates a one-time **pairing** that expires in
   10 minutes. The CLI shows it as a QR code (and as a link, for a Mac without a camera).
2. The device scans it, creates a P-256 key in its Secure Enclave and **claims** the pairing
   with the secret from the QR and its public key. The Worker stores the key as an inactive
   device.
3. Both the device and the CLI show the same 6-digit **verification code**, derived from the
   public key. The admin checks they match and approves in the terminal. Only then is the device
   active.
4. From then on, the device signs every request. The Worker verifies the signature, the
   timestamp and a one-time nonce, and applies the device's role.

The approval step is what makes a photographed QR harmless: whoever claims it first still needs
the admin, at the terminal, to approve a code that only the legitimate device shows.

**Conventions.** Every base64url value in this protocol (IDs, secret, public key, proof, nonce,
signature) is unpadded, and must be the canonical form: the text that decodes to the right
number of bytes and encodes back to itself. Anything else is rejected. Where a string is hashed
or signed (the proof, the verification code, the canonical string), it is the base64url text
as sent, not the decoded bytes. Lengths of `name` and `label` are counted in UTF-16 code units
(JavaScript's `length`, Swift's `utf16.count`).

## 2. Pairing

### 2.1 Create (`ADMIN_TOKEN` only)

`POST /v1/admin/pairings` with `{ "role": "read" | "admin", "label"?: string }`. The label is
a hint for the admin, for example "Ana's iPhone": 1 to 64 UTF-16 code units, or `null`; clients
truncate it before sending. Otherwise `400 invalid role` or `400 invalid label`.

The Worker generates `id` (16 random bytes) and `secret` (32 random bytes), both base64url
without padding, and stores **only `SHA-256(secret)`** (the hex SHA-256 of the secret's
base64url text), the role, the label and `expires_at = now + 10 min`. Answer:

```json
{
  "id": "q3V…",
  "secret": "Xk9…",
  "role": "admin",
  "expires_at": 1762790000000,
  "pair_url": "nongrata://pair?v=1&url=https%3A%2F%2Fnongrata-myapp.example.workers.dev&id=q3V…&secret=Xk9…&role=admin&exp=1762790000000"
}
```

The link is exactly
`nongrata://pair?v=1&url=<origin, percent-encoded>&id=<id>&secret=<secret>&role=<role>&exp=<expires_at>`.
`url` is the Worker's origin, taken from the request; it must be `https`, except
`http://localhost` and `http://127.0.0.1` (any port) for `wrangler dev`: from any other `http`
origin the Worker answers `400 https required`, and the CLI warns when it shows a local `http`
link. `role` and `exp` (Unix ms, the same as `expires_at`) are only for the device's screen: it
can say what it is being paired as, show a countdown and stop polling. The role that counts is
the one the Worker stored, which the claim and `me` return. The secret is returned once and never
again. Only `ADMIN_TOKEN` can create pairings, not an admin device: a stolen device must not be
able to enrol more devices.

### 2.2 Claim (the device, no other credential)

`POST /v1/pair/claim` (outside `/v1/admin/`, rate-limited like `/v1/device/check`: the same
`RATE_LIMITER` per client IP, `429 {"error":"rate_limited"}` before the body is read):

```json
{
  "id": "q3V…",
  "secret": "Xk9…",
  "public_key": "BHx…",
  "name": "iPhone 16 Pro",
  "platform": "ios",
  "proof": "MEU…"
}
```

- `public_key`: the uncompressed P-256 point (65 bytes, `0x04 || X || Y`), base64url. That is
  what `SecKeyCopyExternalRepresentation` returns for a Secure Enclave public key.
- `name`: 1 to 64 UTF-16 code units, shown in device lists; clients truncate it before sending.
  `platform`: `ios`, `ipados`, `macos` or `other`.
- `proof`: a signature with the new key (format in section 3.3) over
  `"NONGRATA-PAIR-V1\n" + id + "\n" + public_key`, with `id` and `public_key` as the base64url
  strings sent. It proves the claimant holds the private key.

The shape of `name` and `platform` is checked first, before the pairing is even looked up:
`400 {"error":"invalid name"}` (missing, not a string, empty or longer than 64) or
`400 {"error":"invalid platform"}`. These say what is wrong, since they reveal nothing about the
pairing, and they do not count as failed attempts. Then the Worker compares `SHA-256(secret)` in
constant time and checks the key and the proof; then one conditional `UPDATE` claims the pairing only if it still exists, has not expired,
has not been claimed and has not been burned, so two claims at once cannot both win. In the same
transaction it creates the device (16 random bytes as `device_id`) with `status = pending`, and
answers `{ "device_id": "…", "role": "admin", "verification_code": "123456" }`.

From there, every failed claim for an existing `id` increments a counter, whatever failed (the
secret, the key, the proof, or a pairing already claimed or expired); at 5 the pairing is burned.
Those errors are always `400 {"error":"invalid pairing"}`, without saying which check failed. A
body that is not a JSON object, or an `id` that is not 16 bytes of base64url or does not exist,
gives the same error and counts nothing.

### 2.3 Verification code

`verification_code` = the first 4 bytes of `SHA-256("NONGRATA-VERIFY-V1\n" + id + "\n" +
public_key)` (the base64url strings as sent) read as a big-endian unsigned integer, modulo
1 000 000, padded to 6 digits. The device computes it on its own from its key; it does not trust
the Worker's copy.

### 2.4 Approve (`ADMIN_TOKEN` only)

- `GET /v1/admin/pairings/{id}`: `{ status: "pending" | "claimed" | "approved" | "expired",
  role, label, expires_at, device?: { device_id, name, platform, verification_code } }`.
  `device` is there once claimed, while the device exists. `approved` wins over everything;
  otherwise a pairing is `expired` after `expires_at` (at that millisecond it still is not) or
  once burned. The CLI polls it every 2 seconds.
- `POST /v1/admin/pairings/{id}/approve`: only for `claimed` and not expired. The device becomes
  `active`, the approval goes to the admin log (section 4), and the answer is
  `{ device_id, name, platform, role, status: "active" }`. Otherwise `409` with
  `pairing not claimed`, `pairing already approved` or `pairing expired`.
- `DELETE /v1/admin/pairings/{id}`: cancels it (`{ "cancelled": true }`). If it was claimed, the
  pending device is deleted. An approved pairing cannot be cancelled (`409 pairing already
  approved`): revoke the device instead.

An unknown `{id}` gives `404 pairing not found`. A claimed pairing that is not approved before
`expires_at` expires: its pending device can no longer call anything, and the daily cron deletes
it along with the pairing. `pnpm ng pair` does all of this in one command:

```text
$ pnpm ng pair app=myapp role=admin label="Ana's iPhone"
Scan with NonGrata Dashboard (expires in 10 min):
  ▄▄▄▄▄▄▄ ▄ ▄▄ ▄▄▄▄▄▄▄
  …
Or open: nongrata://pair?v=1&url=…
Waiting for the device…
Claimed by "iPhone 16 Pro" (ios).
Verification code: 123 456. Does the device show the same code? [y/N] y
Paired: device 7sK… with role admin.
```

Pairings belong to a Worker, not to an app: `app=` only picks which Worker to talk to, through
`NONGRATA_URL_<APP>` and `NONGRATA_ADMIN_TOKEN_<APP>`, as in every other command. The QR code is
drawn by the CLI itself (byte mode, level M, up to version 10, so links of up to 213 bytes; a
longer one is printed only as a link), black on white so it scans from a dark terminal too.

**When the codes do not match.** The human compares the two codes; the prompt defaults to N, and
any answer other than `y` or `yes` (also an empty line or the end of the input) makes the CLI
send `DELETE /v1/admin/pairings/{id}`, which deletes the pending device. The device's next call
to `GET /v1/admin/me` then gets `401`: it deletes its key and tells the user that the pairing was
rejected. The same happens when the pairing expires before it is approved.

## 3. Signed requests

### 3.1 Headers

| Header | Value |
|---|---|
| `NonGrata-Device` | The `device_id`. |
| `NonGrata-Timestamp` | Unix milliseconds, as a decimal integer (digits only, at most 15). |
| `NonGrata-Nonce` | 16 random bytes, base64url. New for every request. |
| `NonGrata-Signature` | The signature (section 3.3) of the canonical string, base64url. |

Base64url values follow the conventions of section 1.

A request with `NonGrata-Device` and also `Authorization` is rejected (`400 {"error":"ambiguous
credentials"}`), whatever the token: each request has exactly one identity. Without
`NonGrata-Device`, `/v1/admin/*` works exactly as before with the token.

### 3.2 Canonical string

The lines below, joined with `\n` (no trailing newline), encoded as UTF-8:

```text
NONGRATA-SIG-V1
<METHOD, uppercase>
<host: new URL(request.url).host, lowercase, the default port dropped>
<path: new URL(request.url).pathname, exactly as given>
<canonical query>
<NonGrata-Timestamp>
<NonGrata-Nonce>
<NonGrata-Device>
<hex lowercase SHA-256 of the raw body bytes; of the empty string if there is no body>
```

Host and path are what the WHATWG URL parser gives for the request URL (`new URL(...)` in the
Worker): `host` with the scheme's default port dropped, and `pathname` exactly as given. Send the
path already normalized (no `.` or `..` segments), since the parser resolves those.

Canonical query: every `name=value` pair of the query string, decoded exactly as WHATWG
`URLSearchParams` does (a bare `+` is a space, a pair with no `=` becomes `name=` with an empty
value, empty pairs are skipped, an invalid `%` escape is kept literally), each name and value
encoded again from its UTF-8 bytes with RFC 3986 unreserved characters only (`A–Z a–z 0–9 - . _
~` stay, everything else as `%XX` uppercase, so a literal `%` becomes `%25`), sorted by the
re-encoded name and then by the re-encoded value in code-unit order (they are ASCII after
encoding, so this is byte order), and joined with `&`. Repeated pairs are kept. Empty if there is
no query. Note that `URLComponents` does not encode `+` in a query: send `%2B` for a plus.

Binding the host and the device means a captured signature is useless against another Worker or
as another device. [spec/device-signature-vectors.json](../spec/device-signature-vectors.json)
has canonical strings, body hashes, signatures (raw and DER) with a fixed test key, the claim
proof and verification codes, all computed with `openssl` and `shasum`.

### 3.3 Signature format

ECDSA P-256 with SHA-256, as **raw `r || s`** (64 bytes, each big-endian and left-padded to 32
bytes), base64url. That is what WebCrypto verifies. Apple's
`SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` returns DER, so the client converts it.
The Worker rejects anything that is not exactly 64 bytes.

### 3.4 What the Worker checks, in order

0. The four headers are present and well formed (section 3.1). Otherwise `401`, before reading
   anything from D1.
1. The device exists, is not revoked, and is `active`, or `pending` while its pairing has not
   expired or been cancelled.
2. `|now − timestamp| ≤ 5 minutes`. Otherwise `401 {"error":"unauthorized","reason":"clock",
   "server_time": <ms>}`, so the app can tell the user their clock is wrong. No other reason is
   ever given, and only a device that passed step 1 gets it.
3. The signature verifies with the device's public key.
4. The nonce is new: `INSERT INTO admin_nonces (device_id, nonce, expires_at)` with
   `expires_at = timestamp + 10 minutes`; a primary key conflict is a replay. Each insert also
   deletes that device's expired nonces, and the daily cron deletes everyone's, so the table only
   ever holds about ten minutes of requests.
5. The role allows the route (section 4). A pending device may call only `GET /v1/admin/me`.

Steps 0, 1, 3 and 4 fail with the same `401 {"error":"unauthorized"}`; step 5 with `403
{"error":"forbidden"}`. An unknown route answers `404 {"error":"not_found"}` only after steps 0
to 4, as with the token. The signature is verified before the nonce is stored, so an
unauthenticated request never writes to D1. A nonce is per device: two devices may use the same
one. On success the Worker updates the device's `last_used_at` (at most once a minute; a `403`
does not count).

A pending device may call only `GET /v1/admin/me`, which tells it when it has been approved;
anything else gives `403 {"error":"forbidden"}`. Once its pairing expires or is cancelled, it
gets `401` everywhere.

## 4. Roles

| Route | `read` device | `admin` device | `ADMIN_TOKEN` |
|---|---|---|---|
| `GET /v1/admin/me` | yes | yes | no (it is not a device) |
| `GET /v1/admin/apps`, `lookup`, `bans`, `checks`, `log` | yes | yes | yes |
| `POST /v1/admin/ban`, `unban` | no | yes | yes |
| `GET /v1/admin/devices` | no | yes | yes |
| `POST /v1/admin/devices/{id}/revoke` | only itself | yes | yes |
| `/v1/admin/pairings…` | no | no | yes |

A route that the caller's column says "no" to answers `403 {"error":"forbidden"}`, including
`me` with the token, and every route but `me` for a pending device.

New read routes:

- `GET /v1/admin/me`: `{ device_id, name, platform, role, status, created_at }`.
- `GET /v1/admin/apps`: the apps configured in this Worker, sorted, `{ apps: [{ app, enforce,
  devicecheck }] }` (`devicecheck` says whether the Apple key is set). Nothing secret. The Worker
  only sees the suffix of `HASH_PREFIX_<APP>`, so `app` is that suffix in lowercase: an app id
  with `-` (which the suffix writes as `_`) is listed with `_`. Use app ids without `-` if a
  client picks the app from this list.
- `GET /v1/admin/devices`: `{ devices: [{ device_id, name, platform, role, status, created_at,
  last_used_at, revoked_at }] }`, newest first, pending and revoked ones included. Never the
  public key.

`admin_log` gains an `actor` column (`token` or `device:<device_id>`) for every action, and new
actions `pair` (approved), `revoke`, alongside `ban` and `unban`. `pair` and `revoke` concern the
whole Worker, not one app, so their rows are stored with `app` NULL and carry the device in a new
`device_id` column (`pair` also keeps the pairing's label as `note`). `GET /v1/admin/log?app=…`
returns that app's `ban` and `unban`, as before; without `app` it returns the Worker-wide device
events, with the same pagination and `"app": null` in the page:
`{ "app": null, "items": [{ action, kind, hash, ref, note, device_id, actor, created_at }],
"next_cursor": … }`. A present but bad `app` still gives `invalid app` or `app not configured`.
Log items gain `device_id` and `actor` (`null` in rows older than migration `0003`).

## 5. Revocation and a lost device

`POST /v1/admin/devices/{id}/revoke` (from the CLI with `pnpm ng devices revoke app=… id=…`, or
from any other admin device) sets `revoked_at` and answers `200 { "device_id": "…",
"revoked_at": <ms> }`. It is idempotent: revoking again answers the same, with the original
`revoked_at`, and writes nothing. An unknown id gives `404 {"error":"not_found"}` (only the token
and admin devices can call it, so this leaks nothing). From the next request that device gets
`401`. Revocation is permanent: to use that phone again, pair it again. Any active device may
revoke itself, a `read` one too ("Remove this Worker" in the app does that and then deletes the
key).

The key is created with `.biometryCurrentSet` (section 7), so re-enrolling Face ID or Touch ID
invalidates it: the device must then be paired again (and the old entry revoked).

A lost or stolen device: its key is in the Secure Enclave and the app requires Face ID or
Touch ID to use it (section 7), so a thief with the locked phone can do nothing. Revoke it from
the terminal or from another device anyway.

## 6. Coexistence with `ADMIN_TOKEN`

The CLI and any existing integration keep working unchanged with `Authorization: Bearer`. The
token stays the root credential: it is the only way to create pairings. Once your devices are
paired, keep it out of daily use (for example only in a password manager) and rotate it with
`wrangler secret put ADMIN_TOKEN` if it might have leaked; rotating it does not affect paired
devices.

## 7. The client side (informative)

What a client must do for this to be as safe as described. The NonGrata Dashboard does it.

- Create the key with `kSecAttrTokenIDSecureEnclave`, `kSecAttrIsPermanent`, and an access
  control of `.privateKeyUsage` plus `.biometryCurrentSet` (or `.userPresence` where there is no
  biometry), `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. One key per paired Worker.
- Keep reads within a short session: the app keeps its own 5-minute session timer, which also
  ends when the app goes to the background (`touchIDAuthenticationAllowableReuseDuration` does
  not keep an `LAContext` alive on its own). Ask for Face ID again before every ban, unban or
  revoke.
- `.biometryCurrentSet` invalidates the key when Face ID or Touch ID is re-enrolled; the app then
  pairs again (section 5).
- On a `clock` error, explain it to the user. In v1, never retry automatically with an offset
  taken from `server_time`.
- Show the Worker's host prominently before claiming, so a malicious QR pointing to another
  Worker is noticed.
- Never log the secret from the QR; forget it after the claim.

## 8. App Attest (not in the first version)

App Attest would let the Worker check that the key belongs to the genuine Dashboard app on a
genuine Apple device. It does not help with the main risks here (a leaked QR is covered by the
approval code, a stolen phone by the Secure Enclave and biometry), it would tie every
self-hosted Worker to one app's Team ID, and verifying attestations means parsing CBOR and
Apple's certificate chain in the Worker. Left out of v1; the protocol has room for it as an
optional `attestation` field in the claim.

## 9. Threat model

| Threat | What happens | Mitigation |
|---|---|---|
| The QR is photographed or the link leaks | The attacker can claim the pairing first. | The admin must approve a 6-digit code that the legitimate device shows; a wrong or unexpected claim is cancelled. Pairings last 10 minutes and work once. |
| Someone guesses a pairing | — | 128-bit `id`, 256-bit secret, 5 failed attempts burn the pairing, rate limiting. |
| Stolen or lost device | The thief has the phone. | The key never leaves the Secure Enclave and needs biometry. Revoke it. |
| Replay of a captured request | An attacker resends a signed request. | One-time nonce stored for 10 minutes, timestamp window of 5 minutes. |
| Request modified in transit | The attacker changes the body or the query. | The signature covers method, host, path, query, body hash, time and nonce. Plus HTTPS. |
| Signature reused against another Worker or as another device | — | The host and the device ID are in the canonical string; keys are per Worker. |
| Clock skew on the device | Valid requests are rejected. | 5-minute window; the `clock` reason with `server_time` lets the app explain it. |
| Malicious QR pointing to a fake Worker | The device pairs with the attacker's Worker. | It can only show fake data: no secret leaves the device. The app shows the host before claiming. |
| `ADMIN_TOKEN` leaks | The attacker can do everything, including pairing their own device. | Same as today. Keep the token out of daily use, rotate it, and review `GET /v1/admin/devices` and the log (`actor`). |
| A `read` device is compromised | The attacker can read hashes, refs and checks. | No raw identifiers are ever stored. Revoke it. |
| Worker or Cloudflare account compromised | Everything. | Out of scope: the Worker is the trust anchor. |
| Flooding `/v1/pair/claim` or signed routes | D1 writes. | Rate limiting on claims; nothing is written before a signature verifies. |

## 10. Storage (migration `0003`)

```sql
CREATE TABLE admin_pairings (
  id               TEXT PRIMARY KEY,
  secret_hash      TEXT NOT NULL,        -- hex SHA-256 of the secret (its base64url text)
  role             TEXT NOT NULL CHECK (role IN ('read', 'admin')),
  label            TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  claimed_at       INTEGER,
  device_id        TEXT,
  approved_at      INTEGER
);

CREATE TABLE admin_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'ipados', 'macos', 'other')),
  role          TEXT NOT NULL CHECK (role IN ('read', 'admin')),
  public_key    TEXT NOT NULL,           -- base64url, 65-byte uncompressed P-256 point
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE admin_nonces (
  device_id   TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
) WITHOUT ROWID;
CREATE INDEX admin_nonces_expires_at ON admin_nonces (expires_at);

-- admin_log, rebuilt (see below), now:
CREATE TABLE admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT,                     -- NULL for pair and revoke
  action      TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'pair', 'revoke')),
  kind        TEXT CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  hash        TEXT,
  ref         TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  device_id   TEXT,                     -- the device of pair and revoke
  actor       TEXT CHECK (actor = 'token' OR actor LIKE 'device:%'),  -- NULL for older rows
  CHECK ((app IS NULL) = (action IN ('pair', 'revoke')))
);
```

`admin_log.action` had a `CHECK` limited to `ban` and `unban`; SQLite cannot change a `CHECK`
in place, so the migration rebuilds the table (copy, drop, rename, recreate the index), keeping
every row and its id, to allow `pair` and `revoke`, make `app` optional and add `device_id` and
`actor`. The daily cron deletes expired nonces, expired pairings (approved or not: an active
device no longer needs its pairing) and pending devices whose pairing expired, was burned or was
deleted.

**Upgrading a deployment.** Apply migration `0003_admin_devices.sql` before deploying the new
Worker (`wrangler d1 migrations apply DB --remote`, as in the README); until then `ban`,
`unban` and `log` fail with a `500`, because they write or read the log's new columns, while
`/v1/device/check` keeps working. Check that it really ran with `wrangler d1 migrations list DB --remote` (nothing
pending): from a script or another non-interactive shell, Wrangler may skip its confirmation
prompt without applying anything; prefix the command with `CI=1` so it answers yes.
