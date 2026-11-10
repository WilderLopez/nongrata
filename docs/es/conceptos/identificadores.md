---
tags: [concepto]
aliases: [idfv, installId, install, icloud, userRecordID]
---

# Identificadores

*English: [identifiers.md](../../concepts/identifiers.md)*

Cuatro identificadores, cada uno tapa un truco distinto del actor. Ninguno basta solo; juntos
forman capas.

| Tipo (`kind`) | Qué es | Sobrevive a… | No sobrevive a… |
|---|---|---|---|
| `idfv` | `identifierForVendor` de iOS | cerrar sesión y crear otra cuenta | reinstalar (si borra todas tus apps) |
| `install` | UUID propio guardado en el Keychain | reinstalar | borrar el iPhone |
| `icloud` | ID del usuario de iCloud (`userRecordID`) | borrar el iPhone, cambiar de iPhone | cambiar de cuenta de Apple |
| `user` | ID de la cuenta en tu app | — | crear otra cuenta |

Y por encima de todos, `bit0` de [DeviceCheck](devicecheck.md), que vive en los servidores de
Apple y sobrevive incluso a borrar el iPhone y cambiar de cuenta de Apple.

## Qué atrapa a quién

| Qué hace el actor | Qué lo atrapa |
|---|---|
| Cierra sesión y crea otra cuenta | `idfv`, `install` |
| Reinstala la app | `install`, `bit0` |
| Borra el iPhone y entra con la misma cuenta de Apple | `bit0`, `icloud`, marca en iCloud |
| Otro iPhone con la misma cuenta de Apple | `icloud`, marca en iCloud |
| Borra el iPhone y usa otra cuenta de Apple | `bit0` |

## Lo que se aprendió del caso real

- El `idfv` se repetía en varias cuentas del mismo actor (solo cerraba sesión), pero cambió al
  reinstalar. Por eso hace falta `install`.
- La IP y el correo no sirven para banear: IPs compartidas de operador y Gmail normales.
- En Amplitude para iOS, `device_id` es el `idfv`: sirve para encontrar qué banear.

## Notas

- `install` no se debe borrar en la limpieza de primera ejecución de la app.
- `icloud` solo si la app activa `useICloud` (necesita CloudKit en el App ID).

Diseño: secciones 1, 5 y 8.2 de [DISENO.md](../DISENO.md).
