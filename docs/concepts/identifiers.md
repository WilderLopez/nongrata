---
tags: [concept]
aliases: [idfv, installId, install, icloud, userRecordID]
---

# Identifiers

*Español: [identificadores.md](../es/conceptos/identificadores.md)*

Four identifiers, each one plugs a different trick of the actor. None is enough on its own;
together they form layers.

| Kind (`kind`) | What it is | Survives… | Doesn't survive… |
|---|---|---|---|
| `idfv` | iOS `identifierForVendor` | logging out and creating another account | reinstalling (if all your apps are deleted) |
| `install` | Own UUID stored in the Keychain | reinstalling | erasing the iPhone |
| `icloud` | iCloud user ID (`userRecordID`) | erasing the iPhone, switching iPhones | switching Apple accounts |
| `user` | Account ID in your app | — | creating another account |

And on top of all of them, `bit0` from [DeviceCheck](devicecheck.md), which lives on Apple's
servers and survives even erasing the iPhone and switching Apple accounts.

## What catches whom

| What the actor does | What catches them |
|---|---|
| Logs out and creates another account | `idfv`, `install` |
| Reinstalls the app | `install`, `bit0` |
| Erases the iPhone and signs in with the same Apple account | `bit0`, `icloud`, iCloud flag |
| Another iPhone with the same Apple account | `icloud`, iCloud flag |
| Erases the iPhone and uses another Apple account | `bit0` |

## What the real case taught us

- The `idfv` repeated across several accounts of the same actor (who only logged out), but it
  changed on reinstall. That is why `install` is needed.
- IP and email are useless for banning: carrier-shared IPs and regular Gmail accounts.
- In Amplitude for iOS, `device_id` is the `idfv`: useful to find what to ban.

## Notes

- `install` must not be deleted in the app's first-launch cleanup.
- `icloud` only if the app turns on `useICloud` (needs CloudKit in the App ID).

Design: sections 1, 5 and 8.2 of [DESIGN.md](../DESIGN.md).
