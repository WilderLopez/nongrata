---
tags: [concepto]
aliases: [bit0, bit1, two bits, DCDevice, token de DeviceCheck]
---

# DeviceCheck

Servicio de Apple que guarda **dos bits por dispositivo** (`bit0` y `bit1`) en sus servidores,
asociados a tu cuenta de desarrollador. Es la pieza que hace que el bloqueo sobreviva a
reinstalar y a borrar el iPhone.

## Cómo funciona

1. La app pide un **token** a `DCDevice.generateToken()`. Es efímero y no sirve como
   identificador: dos tokens del mismo iPhone no se pueden comparar.
2. El Worker manda el token a Apple, firmado con un **JWT** hecho con tu clave `.p8`:
   - `query_two_bits` devuelve el estado de los bits.
   - `update_two_bits` los cambia.
3. Apple sabe a qué dispositivo pertenece el token; nosotros nunca lo sabemos.

## Cómo lo usamos

- `bit0 = true` significa "dispositivo baneado".
- `bit1` queda libre (por ejemplo, para "en revisión").
- Solo se manda `bit0` al escribir: omitir `bit1` no lo toca.
- Se piden **dos tokens** por comprobación (`dc_token` y `dc_token_update`) porque Apple pide no
  reutilizarlos. Si solo llega uno, el Worker consulta pero no escribe: el bit se escribe en la
  siguiente comprobación que traiga los dos. Mientras, el bloqueo lo sostiene D1.

## Limitaciones

- Solo se puede escribir con un token recién generado por **ese** dispositivo: no se puede
  banear un iPhone que no vuelve a abrir la app. El bit se marca en su siguiente comprobación.
- En el simulador no hay DeviceCheck: el Worker decide solo con D1.
- Si Apple falla, se decide solo con D1 (ver [Fail-open](fail-open-y-observacion.md)).
- Un iPhone baneado que se vende de segunda mano sigue baneado: para eso está el desbaneo por
  `ref` (ver [Hash y ref](hash-y-ref.md)).

## Dónde está en el código

- JWT ES256: `worker/src/apple/jwt.ts`.
- Cliente HTTP: `worker/src/apple/devicecheck.ts`.
- Tokens en el SDK: `deviceTokens()` en `swift/Sources/DeviceGuard/DeviceGuard.swift`.

Diseño: secciones 3 y 7.2 del [HANDOFF](../HANDOFF.md).
