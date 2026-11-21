---
tags: [concept]
aliases: [Hash, ref, Support code, Normalization, Prefix]
---

# Hash and ref

*Español: [hash-y-ref.md](../es/conceptos/hash-y-ref.md)*

## The hash

No identifier is stored raw. Its hash is stored instead:

```
SHA256(prefix + ":" + kind + ":" + normalized value)   → lowercase hex
```

Example: `myapp-ban-v1:idfv:5F3A…`.

- The **prefix** is different per app (`HASH_PREFIX_MYAPP = myapp-ban-v1`). That way the same
  `idfv` gives different hashes in two apps and the lists don't mix.
- The formula is **identical** in the SDK, the Worker and the CLI. `spec/hash-vectors.json` has
  examples that the tests of all three check.
- Changing the formula invalidates every list. That is why normalization was decided **before**
  the first real ban.

To compute a hash offline: `pnpm ng hash prefix=myapp-ban-v1 kind=idfv value=…`.

## The ref

The first 8 characters, uppercased, of the `install` hash. Example: `A1B2C3D4`.

- It is the **support code**: the suspended screen shows it and the user sends it.
- Support unbans with `pnpm ng unban app=myapp ref=A1B2C3D4`.
- The unban is complete: on that iPhone's next check, the Worker sets `bit0` to false and
  deletes from the list every hash the request carries.
- The last decision wins: a manual ban made after the unban, and before that check, cancels it.
- The admin listing of bans gives each ban's `ref` when the Worker knows it, so the bans of one
  device can be shown together.
- The Worker computes the `ref` itself; it never trusts the one the client sends.

## Normalization (decided on 2026-11-02)

Before hashing, the value is cleaned the same way in all three places:

- Spaces, tabs and line breaks are stripped from both ends (ASCII ones only).
- In `idfv` and `install`, which are UUIDs, the letters a-z are uppercased.
- In `user`, the letters A-Z are lowercased (since 2026-11-19; see below).
- In `android_id`, the letters A-Z are lowercased too (since 2026-11-21), for the same reason.
- `icloud` is left as it is: it is opaque and case-sensitive.

Why: the SDK sends UUIDs in uppercase (`uuidString`), but an `idfv` copied from another tool may
come in lowercase or with a trailing space. Without normalization, that ban would never match
and nothing would warn about it.

Rejected alternatives: not normalizing and having only the CLI warn (a ban made without the CLI
would still fail), and lowercasing everything (it would alter `icloud`).

### `user` in lowercase (2026-11-19)

Until then `user` kept its case, like `icloud`. Support bans by the user ID it copies from a
back office, and one capital letter was enough for the ban to match nothing, with no warning.
Now `A1b2` and `a1B2` are the same user.

- **What it costs:** two users whose IDs differ only in capitals become one. With UUIDs, numbers
  or long random IDs that does not happen. If your IDs are short and case-sensitive, a ban by
  `user` could reach the wrong person: ban those by `install` instead.
- **Who it changes:** nothing for an ID that was already lowercase. For an ID with capitals, an
  app on SDK `0.2.0` or earlier still sends the old hash until it updates, and a ban of it by
  `value` only matches the new one; a ban stored by `hash` keeps matching what it matched.
- Only A-Z, like the uppercase rule for UUIDs: other letters (`Ñ`, `ß`) are left alone, so
  Swift and JavaScript always agree.

In code: `normalizeValue` in `worker/src/hash.ts` (also used by the CLI) and
`IdentifierHasher.normalize` in Swift. The vectors with a `note` in `spec/hash-vectors.json`
cover each rule.

Design: sections 8.2 and 16 (open item 9) of [DESIGN.md](../DESIGN.md).
