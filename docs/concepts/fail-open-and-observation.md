---
tags: [concept]
aliases: [Fail-open, Observation mode, ENFORCE, Strict mode, strictSignup, check_log]
---

# Fail-open and observation mode

*Español: [fail-open-y-observacion.md](../es/conceptos/fail-open-y-observacion.md)*

Two mechanisms so that the system never kicks out normal users because of a failure or a
configuration mistake.

## Fail-open

If the check fails (no network, timeout, Worker error, quota exhausted) **and there is no local
flag**, the app lets the user in. The verdict is `unknown`.

- Whoever was already blocked stays blocked: the local flag (Keychain and iCloud) is set on
  `blocked` and only an `ok` from the Worker clears it. An error touches nothing.
- Only a `200` with `{ status, ref }` counts as a valid response.

### Exception: strict mode on sign-up

With `strictSignup`, creating an account requires an `ok`. If it fails, the app says "sign-up
could not be completed" and does not create the account. It closes the trick of blocking the
Worker's domain to sign up, without bothering people who already have an account. In code:
`permits(_:for:)` in `NonGrata.swift`.

## Observation mode

`ENFORCE_<APP>` other than `"true"` ⇒ the Worker always responds `ok`, but records in
`check_log` what it would have done (`blocked = 1`).

It is **pure observation** (decided on 2026-11-02): it looks at D1 and queries `bit0` at Apple,
but changes nothing outside `check_log`. It neither writes `bit0` nor
[propagates](propagation.md). That way, a wrong ban loaded during observation leaves no trace on
anyone's iPhone. When `ENFORCE` is turned on, the first check of each blocked device writes
`bit0` and propagates. Unbans by `ref` are applied, because support requests them on purpose.

It enables a safe rollout:

1. Deploy with `ENFORCE` off.
2. Release the app with the SDK and load the bans.
3. Watch `check_log` for a few days: would it block the right people? Anyone else?
4. Turn on `ENFORCE`. No new app version is needed.

`check_log` only stores results (app, `ref`, blocked, bits, intent, date); never identifiers or
IPs. It is purged daily after 30 days.

Design: sections 6.2 and 14 of [DESIGN.md](../DESIGN.md).
