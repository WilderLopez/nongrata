---
tags: [glosario]
aliases: [Glosario, Términos]
---

# Glosario

Los términos del proyecto, en orden alfabético, explicados para quien programa en iOS pero no
conoce Cloudflare. Cuando hay una nota que lo explica a fondo, va enlazada.

## A

- **App Attest**: servicio de Apple que prueba que una petición viene de tu app sin modificar.
  Aquí es opcional y está pendiente: cerraría el hueco de una app modificada que no llama al
  Worker (sección 6.3 del [HANDOFF](HANDOFF.md)).
- **ATT** (App Tracking Transparency): el permiso "¿Permitir que la app rastree…?". El uso
  solo antifraude **no es tracking**, así que no hace falta pedirlo. Sí hay que declarar
  "Device ID" (y "User ID") en la etiqueta de privacidad, con propósito "App Functionality".

## B

- **Binding**: la forma en que un Worker recibe un recurso de Cloudflare. Se declara en
  `wrangler.jsonc` y aparece en el código como `env.<NOMBRE>`, como una dependencia inyectada.
  Aquí: `DB` (la base D1) y `RATE_LIMITER`. Ver [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
- **`bit0` / `bit1`**: los dos bits por dispositivo que guarda DeviceCheck en Apple.
  `bit0 = true` significa "baneado"; `bit1` está libre. Ver [DeviceCheck](conceptos/devicecheck.md).

## C

- **`check_log`**: tabla de D1 con el resultado de cada comprobación (app, `ref`, bloqueado,
  bits, intent, fecha). Nunca identificadores ni IPs. Sirve para el modo observación y se purga
  a los 30 días. Ver [Fail-open y modo observación](conceptos/fail-open-y-observacion.md).
- **Clave `.p8`**: el fichero de clave privada que descargas del portal de Apple al crear una
  clave con DeviceCheck activado. El Worker la guarda como secreto (`APPLE_DC_KEY_P8_<APP>`) y
  firma con ella los JWT.
- **Cron Trigger**: tarea programada de un Worker, como un cron de Unix. Aquí purga
  `check_log` cada día. Ver [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).

## D

- **D1**: base de datos SQLite gestionada por Cloudflare. Guarda la lista de baneados, los
  desbaneos pendientes y `check_log`; una base por app. Ver
  [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
- **DeviceCheck**: servicio de Apple que guarda dos bits por dispositivo en sus servidores.
  Sobrevive a reinstalar y a borrar el iPhone. Ver [DeviceCheck](conceptos/devicecheck.md).

## E

- **`ENFORCE`**: ver *Modo observación*.
- **ES256**: el algoritmo de firma que pide Apple para el JWT: ECDSA con la curva P-256 y
  SHA-256. El Worker firma con Web Crypto, sin librerías.

## F

- **Fail-open**: si la comprobación falla y no hay marca local, la app deja entrar (veredicto
  `unknown`). Un fallo nunca echa a usuarios normales. Ver
  [Fail-open y modo observación](conceptos/fail-open-y-observacion.md).

## H

- **Hash**: huella SHA-256 de un identificador: `SHA256(prefijo:kind:valor)`. Es lo único que
  se guarda; nunca el valor. Ver [Hash y ref](conceptos/hash-y-ref.md).

## I

- **`idfv`**: `UIDevice.identifierForVendor`. Igual en todas tus apps del mismo iPhone; cambia
  si se borran todas y se reinstala. Ver [Identificadores](conceptos/identificadores.md).
- **`installId`**: UUID que el SDK crea una vez y guarda en el Keychain. Sobrevive a
  reinstalar; en la lista es el tipo `install`. La app no debe borrarlo. Ver
  [Identificadores](conceptos/identificadores.md).

## J

- **JWT** (JSON Web Token): cabecera, datos y firma, en base64url y separados por puntos. El
  Worker crea uno con la clave `.p8` para identificarse ante Apple en cada llamada a
  DeviceCheck, y lo reutiliza durante 30 minutos.

## K

- **Key ID**: identificador de 10 caracteres de tu clave de Apple. Va en la cabecera del JWT
  (`kid`). En el Worker, `APPLE_KEY_ID_<APP>`.
- **Keychain**: el almacén seguro de iOS. El SDK guarda ahí el `installId` y la marca de
  bloqueado. Sus ítems sobreviven a reinstalar la app (es lo observado; Apple no lo garantiza).
- **KVS**: ver *`NSUbiquitousKeyValueStore`*.

## M

- **Modo estricto**: con `strictSignup` (activado por defecto), crear una cuenta exige un `ok`
  del Worker; si la comprobación falla, no se crea. Ver
  [Fail-open y modo observación](conceptos/fail-open-y-observacion.md).
- **Modo observación** (`ENFORCE_<APP>`): si no vale `"true"`, el Worker responde siempre `ok`
  y anota en `check_log` lo que habría bloqueado, sin escribir `bit0` ni propagar. Ver
  [Fail-open y modo observación](conceptos/fail-open-y-observacion.md).
- **Mutation testing**: medir si los tests vigilan el código cambiándolo a propósito y viendo
  si algún test falla. Ver [Mutation testing](conceptos/mutation-testing.md).

## N

- **`NSUbiquitousKeyValueStore`** (KVS): pequeño almacén clave-valor de iCloud que se
  sincroniza entre los dispositivos con la misma cuenta de Apple. Con `useICloud`, el SDK guarda
  ahí la marca de bloqueado para que salte a otros iPhones.

## P

- **Prefijo**: texto distinto por app (`HASH_PREFIX_<APP>`, por ejemplo `myapp-ban-v1`) que se
  pone delante del valor antes del hash. Separa las listas de cada app. Ver
  [Hash y ref](conceptos/hash-y-ref.md).
- **Propagación**: cuando un dispositivo sale bloqueado, el Worker añade a la lista sus hashes
  nuevos (`propagated`). Así el bloqueo salta solo a otros iPhones. Ver
  [Propagación](conceptos/propagacion.md).

## R

- **Rate limiting**: límite de peticiones por IP en `check` (20 por minuto con el binding
  `RATE_LIMITER`); al pasarse, `429`. Falta confirmar que funcione en el plan gratuito.
- **`ref`**: los 8 primeros caracteres, en mayúsculas, del hash de `install`. Es el código de
  soporte que ve el usuario bloqueado y con el que se le desbanea. Ver
  [Hash y ref](conceptos/hash-y-ref.md).

## S

- **Secreto** (`wrangler secret`): valor cifrado del Worker que no va en `wrangler.jsonc` ni en
  git. Se carga con `wrangler secret put` y se lee como `env.<NOMBRE>`. Aquí:
  `APPLE_DC_KEY_P8_<APP>` y `ADMIN_TOKEN`. Ver [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
- **SPM** (Swift Package Manager): las apps añaden `NonGrata` por SPM con la URL del repo
  privado, fijado a una etiqueta de versión.
- **Stryker**: la herramienta de mutation testing de `worker/` y `cli/`. Ver
  [Mutation testing](conceptos/mutation-testing.md).

## T

- **Team ID**: identificador de tu equipo de desarrollo en Apple. Va en el JWT como `iss`. En
  el Worker, `APPLE_TEAM_ID_<APP>`.
- **TestFlight**: la distribución de builds beta de Apple. El SDK pide el entorno `development`
  de DeviceCheck solo en builds `DEBUG`, así que TestFlight usa producción. Falta confirmarlo con
  una build real.
- **Token de DeviceCheck**: dato efímero que genera `DCDevice.generateToken()` y que el Worker
  manda a Apple. No sirve como identificador y es de un solo uso: por eso se piden dos
  (`dc_token` y `dc_token_update`). Ver [DeviceCheck](conceptos/devicecheck.md).

## U

- **`userRecordID`**: el ID del usuario de iCloud en el contenedor de CloudKit de la app. En la
  lista es el tipo `icloud`. Falta confirmar que no cambie entre dispositivos. Ver
  [Identificadores](conceptos/identificadores.md).

## W

- **Worker**: programa que Cloudflare ejecuta en sus servidores con cada petición HTTP, sin
  servidor que mantener. Decide `ok` o `blocked`. Ver
  [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
- **workers.dev**: el subdominio de Cloudflare donde queda publicado un Worker sin dominio
  propio. Ver [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
- **wrangler**: la herramienta de línea de comandos de Cloudflare para probar y desplegar
  Workers, y para gestionar D1 y los secretos. Aquí se usa siempre con `pnpm`. Ver
  [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md).
