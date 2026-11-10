# NonGrata admin API

*Español: [API-ADMIN.md](es/API-ADMIN.md)*

Every NonGrata Worker has an HTTP admin API under `/v1/admin/`. The `nongrata` CLI is one client
of it; a web panel, a support bot or your app's backend can be others. This guide explains how
it works; the exact contract, with schemas and examples, is the OpenAPI 3.1 spec in
[admin-api.yaml](admin-api.yaml). The design behind it is in [section 6.4](DESIGN.md#64-administration)
of the design document.

## 1. Basics

- **One Worker per app.** Each deployment has its own URL, its own D1 database and its own
  `ADMIN_TOKEN`. Every request still says which `app` it is about, and the app must be configured
  in that Worker (`HASH_PREFIX_<APP>`): a typo in `app` gives `400 app not configured` instead of
  a `200` that does nothing.
- **Authentication.** `Authorization: Bearer <ADMIN_TOKEN>` on every request. Without it, or with
  the wrong token, any `/v1/admin/*` path answers `401 {"error":"unauthorized"}`, even one that
  does not exist; only then does an unknown route or method give `404 {"error":"not_found"}`.
  A Worker without `ADMIN_TOKEN` rejects everything.
- **Only hashes.** The Worker never stores raw identifiers or IPs. You can send a raw `value` to
  `ban`, `unban` and `lookup`: the Worker hashes it with the app's prefix
  (`SHA-256(prefix:kind:value)`, see [hash and ref](concepts/hash-and-ref.md)) and keeps only the
  hash. Listings return hashes and `ref`s, never values.
- **JSON in and out.** Bodies of `POST` are JSON; `GET` takes query string parameters. Every
  response is JSON with `cache-control: no-store`. Timestamps are Unix milliseconds.
- **Errors.** `400` with `{"error": "<reason>"}`. The reasons are short English strings meant to
  be shown as they are: `invalid app`, `app not configured`, `invalid kind`, `invalid hash`,
  `invalid value`, `invalid ref`, `missing value or hash`, `missing value, hash or ref`,
  `missing ref, value or hash`, `invalid reason`, `invalid blocked`, `invalid since`,
  `invalid limit`, `invalid cursor`. `app` is always checked first. Unknown query parameters are
  ignored.

## 2. Endpoints

| Method and route | What it does |
|---|---|
| `POST /v1/admin/ban` | Bans `{ app, kind, value or hash, note? }` as `manual`. Returns `{ app, kind, hash }`. |
| `POST /v1/admin/unban` | `{ app, kind, value or hash }` deletes that hash (`removed` says whether it was there); `{ app, ref }` schedules a full unban of that device on its next check (`unban_scheduled: true`). Both can go together. |
| `GET /v1/admin/lookup` | `?app&ref`: the device's pending or consumed unban and its last 20 checks. `?app&kind&(value or hash)`: the ban row, or `null`. |
| `GET /v1/admin/bans` | The list of banned hashes, newest first. Filters: `kind`, `reason` (`manual` or `propagated`). |
| `GET /v1/admin/checks` | The recent checks (`check_log`), newest first. Filters: `ref`, `blocked` (`0` or `1`), `since` (Unix ms, inclusive). |
| `GET /v1/admin/log` | The admin actions: every successful `ban` and `unban`, newest first. |

`kind` is one of `idfv`, `install`, `icloud`, `user`, `android_id`. A `ref` is the 8-character
uppercase support code the app shows on its block screen.

### Ban and unban

```sh
curl -sS https://nongrata-myapp.<your-subdomain>.workers.dev/v1/admin/ban \
  -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP" -H "content-type: application/json" \
  -d '{"app":"myapp","kind":"idfv","value":"E621E1F8-C36C-495A-93FC-0C247A3E6E5F","note":"spam"}'
# {"app":"myapp","kind":"idfv","hash":"9d2c…"}
```

Banning a hash that is already there as `propagated` turns it into `manual`, with the new note
(at most 500 characters) and time. Unbanning by `ref` is the complete unban: on that device's
next check the Worker sets `bit0` to false and deletes the hashes the check carries. Unbanning a
single hash is for removing one identifier, for example the `icloud` of a couple who share an
Apple account. The details are in [propagation](concepts/propagation.md) and in
[the check flow](concepts/check-flow.md).

### Listings

```sh
curl -sS "https://nongrata-myapp.<your-subdomain>.workers.dev/v1/admin/checks?app=myapp&blocked=1&limit=2" \
  -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP"
```

```json
{
  "app": "myapp",
  "items": [
    { "ref": "7F3A9C21", "blocked": 1, "matched": 0, "bit0": 1, "intent": "launch", "created_at": 1762786800000 },
    { "ref": "0B4E6D12", "blocked": 1, "matched": 1, "bit0": null, "intent": "signup", "created_at": 1762786200000 }
  ],
  "next_cursor": "MTc2Mjc4NjIwMDAwMC40Mg"
}
```

The items of each listing:

| Listing | Item |
|---|---|
| `bans` | `{ hash, kind, reason, note, created_at }` |
| `checks` | `{ ref, blocked, matched, bit0, intent, created_at }`: `blocked`, `matched` and `bit0` are `0` or `1` as in `lookup` (`bit0` is `null` when Apple was not asked or did not answer); `intent` as the SDK sent it |
| `log` | `{ action, kind, hash, ref, note, created_at }`: `action` is `ban` or `unban`; the fields that do not apply are `null` |

In observation mode (`ENFORCE_<APP>` off) a check's `blocked` is what would have been blocked,
which is what makes `checks?blocked=1` useful before turning blocking on.

## 3. Pagination

The three listings work the same way:

- Newest first, by `created_at` and then by an internal key (the hash, or the row id), so the
  order is total even when several rows share a millisecond.
- `limit` from 1 to 100; 50 by default.
- Each page carries `next_cursor`. To get the next page, repeat the same request with
  `cursor=<next_cursor>`. On the last page `next_cursor` is `null`.
- The cursor is opaque: do not build or parse it, and use it only with the listing and filters
  that produced it. It is a keyset position, not an offset, so rows added while you page do not
  shift what comes next: new rows go at the start, which you have already passed (so does a
  ban that is banned again, since it takes the new time).

```sh
cursor=""
while :; do
  page=$(curl -sS "$URL/v1/admin/bans?app=myapp&limit=100${cursor:+&cursor=$cursor}" \
    -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP")
  echo "$page" | jq -c '.items[]'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
```

## 4. What is kept, and for how long

| Data | Kept | Why |
|---|---|---|
| Bans (`banned_ids`) | Until unbanned | The list itself. An unban deletes the row. |
| Checks (`check_log`) | 30 days | The daily cron deletes older rows. `checks` cannot see further back. |
| Admin log (`admin_log`) | Forever | Not purged, see below. |

The admin log is not purged because bans never expire: a hash banned two years ago still blocks,
and the record of who banned it, when and with what note must outlive it. It grows by one row per
human action (a `ban` or an `unban`), so it stays tiny next to `check_log`, which grows with
every app launch; purging it would save nothing and would add a second statement to the cron.
It records what the endpoints already store: the hash (never the raw `value`), the `ref` and the
note. It records that an unban by `ref` was scheduled; whether the device has consumed it shows
in `lookup` by `ref`. If you ever need to trim it, a one-off
`DELETE FROM admin_log WHERE created_at < …` with Wrangler is enough.

**Upgrading a deployment from 0.2.0.** The listings and the log need migration
`0002_admin_log.sql`. Apply the migrations (`wrangler d1 migrations apply DB --remote`, as in the
README) before deploying the new Worker: until then, `ban` and `unban` fail with a `500`, because
the log row is written in the same transaction, while `/v1/device/check` keeps working.
Check that it really ran with `wrangler d1 migrations list DB --remote` (nothing pending): from a
script or another non-interactive shell, Wrangler may skip its confirmation prompt without
applying anything; prefix the command with `CI=1` so it answers yes.

## 5. From the CLI

```sh
pnpm ng bans   app=myapp reason=manual limit=20
pnpm ng checks app=myapp ref=7f3a9c21          # the ref may be lowercase
pnpm ng checks app=myapp blocked=1 since=1762704000000
pnpm ng log    app=myapp
pnpm ng bans   app=myapp cursor=<next_cursor>  # the next page
```

The CLI prints the Worker's JSON as it comes, one page per call. It reads
`NONGRATA_URL_<APP>` and `NONGRATA_ADMIN_TOKEN_<APP>`; see [section 9](DESIGN.md#9-admin-cli) of
the design.

## 6. Building a client

- Keep `ADMIN_TOKEN` on a server. It can ban and unban anyone in that app, so it does not belong
  in a browser, a mobile app or a chat bot's client side. A web panel calls its own backend,
  which calls the Worker.
- Treat any non-`200` as an error and show the `error` string. A `5xx` without JSON (D1 down) can
  happen; retry `GET`s, and for `POST`s check with `lookup` or `log` before retrying.
- `ban` and `unban` are idempotent in their effect (banning twice leaves one row; scheduling a
  `ref` twice leaves one pending unban), but each successful call adds a row to the log.

## 7. Next steps (not built)

- **Web panel.** A small admin UI on top of this API (bans, checks of a `ref`, the log).
- **CORS.** The Worker sends no CORS headers, so a browser cannot call it directly; that is on
  purpose while there is a single all-powerful token.
- **Per-operator tokens.** Today there is one `ADMIN_TOKEN` per Worker, and the log cannot say
  who acted. Named tokens (or Cloudflare Access in front of `/v1/admin/`) would let the log record
  the operator and allow read-only access.
