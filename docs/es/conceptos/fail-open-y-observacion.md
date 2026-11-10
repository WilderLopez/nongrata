---
tags: [concepto]
aliases: [Fail-open, Modo observación, ENFORCE, Modo estricto, strictSignup, check_log]
---

# Fail-open y modo observación

*English: [fail-open-and-observation.md](../../concepts/fail-open-and-observation.md)*

Dos mecanismos para que el sistema nunca eche a usuarios normales por un fallo o un error de
configuración.

## Fail-open

Si la comprobación falla (sin red, timeout, error del Worker, cuota agotada) **y no hay marca
local**, la app deja entrar. El veredicto es `unknown`.

- Quien ya estaba bloqueado sigue bloqueado: la marca local (Keychain e iCloud) se pone con
  `blocked` y solo la quita un `ok` del Worker. Un error no toca nada.
- Solo un `200` con `{ status, ref }` cuenta como respuesta válida.

### Excepción: modo estricto en el registro

Con `strictSignup`, crear una cuenta exige un `ok`. Si falla, la app dice "no se pudo completar
el registro" y no crea la cuenta. Cierra el truco de bloquear el dominio del Worker para
registrarse, sin molestar a quien ya tiene cuenta. En código: `permits(_:for:)` en
`NonGrata.swift`.

## Modo observación

`ENFORCE_<APP>` distinto de `"true"` ⇒ el Worker responde siempre `ok`, pero registra en
`check_log` lo que habría hecho (`blocked = 1`).

Es **observación pura** (decidido el 2026-11-02): mira D1 y consulta `bit0` en Apple, pero no
cambia nada fuera de `check_log`. Ni escribe `bit0` ni [propaga](propagacion.md). Así, un baneo
erróneo cargado durante la observación no deja huella en el iPhone de nadie. Al activar
`ENFORCE`, la primera comprobación de cada dispositivo bloqueado escribe `bit0` y propaga. Los
desbaneos por `ref` sí se aplican, porque los pide soporte a propósito.

Sirve para el despliegue seguro:

1. Desplegar con `ENFORCE` apagado.
2. Publicar la app con el SDK y cargar los baneos.
3. Mirar `check_log` unos días: ¿bloquearía a quien debe? ¿a alguien más?
4. Activar `ENFORCE`. No hace falta versión nueva de la app.

`check_log` solo guarda resultados (app, `ref`, bloqueado, bits, intent, fecha); nunca
identificadores ni IPs. Se purga a diario a los 30 días.

Diseño: secciones 6.2 y 14 de [DISENO.md](../DISENO.md).
