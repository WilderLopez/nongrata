# API de comprobación de NonGrata

*English: [CHECK-API.md](../CHECK-API.md)*

`POST /v1/device/check` es el único endpoint al que llama una app para saber si su dispositivo
está bloqueado. El SDK de Swift y el SDK de Kotlin para Android ([guía de integración](INTEGRACION-ANDROID.md))
son clientes de él; el backend de tu app puede ser otro. Esta guía da el contrato exacto y las reglas que un cliente debe
cumplir por su cuenta. La especificación OpenAPI 3.1 está en [check-api.yaml](../check-api.yaml)
(en inglés). El algoritmo está en la [sección 6.1](DISENO.md#61-post-v1devicecheck) del
documento de diseño; la parte de administración, en la
[guía de la API de administración](API-ADMIN.md).

## 1. La petición

`POST https://<tu-worker>/v1/device/check`, con `Content-Type: application/json`. Sin
autenticación: el endpoint es público y lo único que toma del cliente son hashes. El Worker lo
limita por IP del cliente (sección 3).

| Campo | Obligatorio | Significado |
|---|---|---|
| `app` | sí | El id de la app en el Worker, como `myapp`. Minúsculas, dígitos, `_` y `-`; de 1 a 32 caracteres, empezando por letra o dígito. |
| `ids` | sí | Un objeto de hashes, ver abajo. |
| `ids.install` | sí | Hash del `installId` propio del SDK. Nombra al dispositivo. |
| `ids.idfv`, `ids.icloud`, `ids.user` | no | Más hashes. Ausente o `null` significa "no disponible". |
| `ids.android_id` | no | Hash de `Settings.Secure.ANDROID_ID`. Solo se lee con `platform: "android"`. |
| `platform` | no | `"android"` para un cliente Android; ver [Clientes Android](#clientes-android). Ausente, `"ios"` o cualquier otro valor es el camino de iOS, sin validar. |
| `env` | no | `"development"` o `"production"`. Por defecto `"production"`. Elige el endpoint de DeviceCheck que usa el Worker. |
| `intent` | no | `"launch"`, `"foreground"`, `"login"`, `"signup"` o `"refresh"`. Por defecto `"launch"`. Solo se registra. |
| `dc_token` | no | Token de DeviceCheck para consultar los bits. |
| `dc_token_update` | no | Un segundo token de DeviceCheck, para escribir los bits. |

Cualquier otro valor da `400`: un `app` con otro formato, un `env` o `intent` fuera de las
listas, un hash o token que no cumple su formato, un cuerpo que no es un objeto JSON. `null`
cuenta como ausente en `env`, `intent`, `dc_token`, `dc_token_update` y cada id.

**Los campos desconocidos se ignoran.** El SDK de Swift manda además `ref` y `app_version`; el
Worker no lee ninguno. El SDK de Swift manda `platform: "ios"`, que no cambia nada: solo
`"android"` lo cambia.

### Hashes

Un hash son 64 caracteres hexadecimales en minúscula (`^[0-9a-f]{64}$`); con mayúsculas es un
`400`. El cliente lo calcula como `SHA-256(prefix:kind:value)`. Ver la
[sección 4](#4-reglas-que-sigue-el-cliente).

Sin `platform: "android"`, los tipos que lee el check son `idfv`, `install`, `icloud` y `user`;
un `ids.android_id` se ignora. Con él, los tipos son `install`, `user` y `android_id`. Ver
[Clientes Android](#clientes-android).

### `ref`

El `ref` son los primeros 8 caracteres, en mayúsculas, del hash de `install`. **Lo deriva el
Worker y nunca usa el que mande el cliente.** Es el código de soporte que el usuario dicta y el
valor de un [desbaneo por `ref`](API-ADMIN.md).

### Tokens

`dc_token` y `dc_token_update` son tokens de DeviceCheck en base64 (el alfabeto de base64 y
base64url, con o sin `=`), de 16 a 8192 caracteres (`^[A-Za-z0-9+/=_-]{16,8192}$`). Un token que
no cumple es un `400`, no una omisión: manda `null` si no tienes.

Apple pide no reutilizar un token, así que el cliente genera dos en cada comprobación:

- `dc_token` sirve para **consultar** los bits del dispositivo.
- `dc_token_update` sirve para **escribirlos** (poner `bit0` tras un baneo, quitarlo tras un
  desbaneo).

Sin `dc_token_update` el Worker consulta y decide igual, pero no escribe nada en Apple ni
consume un desbaneo pendiente. Lo reintenta en la siguiente comprobación que traiga ambos. En
`update_two_bits` el Worker solo manda `bit0`.

### Clientes Android

Un cliente sin DeviceCheck manda `"platform": "android"`. La petición mínima:

```json
{
  "app": "myapp",
  "platform": "android",
  "ids": { "install": "<64 hex>" }
}
```

Con `platform: "android"`:

- Los ids que se leen son `install` (obligatorio), `user` y `android_id`.
- Da `400` si el cuerpo trae un `dc_token` o `dc_token_update` no nulo, o un `ids.idfv` o
  `ids.icloud` no nulo. `null` está bien.
- El Worker nunca llama a Apple para esa petición, aunque la app tenga clave de Apple: ni
  consulta ni escritura de `bit0`. Un desbaneo por `ref` pendiente se consume solo con D1, como
  en una app sin clave de Apple.
- La lista es la misma que la de iOS (mismo `app`): un baneo por `user` alcanza a la persona en
  las dos plataformas.
- La propagación incluye `android_id` como cualquier otro hash. Un dispositivo Android bloqueado
  propaga su `android_id`, así que reinstalar (un `install` nuevo y el mismo `ANDROID_ID`) sigue
  bloqueado.

## 2. La respuesta

`200` con `cache-control: no-store` y

```json
{ "status": "ok", "ref": "C1456573" }
```

`status` es `"ok"` o `"blocked"`; `ref` es el código de soporte del dispositivo.

| Código | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{status, ref}` | La comprobación se hizo. |
| `400` | `{"error":"bad_request"}` | El cuerpo no es JSON o un campo no cumple su formato (sección 1). |
| `404` | `{"error":"unknown_app"}` | El cuerpo es válido, pero el Worker no tiene `HASH_PREFIX_<APP>` para `app`. |
| `429` | `{"error":"rate_limited"}` | Se superó el límite (sección 3). Se comprueba antes de leer el cuerpo. |
| otro | | Un error de red o de plataforma (un `5xx`, una página de error de Cloudflare). |

El orden es: límite, luego JSON, luego formato (`400`), luego app (`404`). Por eso un cuerpo mal
formado para una app desconocida da `400`.

**Un cliente trata todo lo que no sea un `200` con `{status, ref}` como "sin respuesta"**, sea
cual sea la causa, y cae en fail-open (sección 4). Un `400` no es un veredicto. Un Worker
antiguo responde `400` a `intent: "refresh"`, porque no lo conoce.

## 3. Qué hace el servidor

- **Límite de peticiones.** Si el Worker tiene el binding `RATE_LIMITER`, cada IP de cliente
  tiene una cuota (`limit: 20` por `period: 60` segundos en el despliegue de ejemplo); el `429`
  va primero. Sin el binding no hay límite. Reintentar justo después de un `429` no sirve:
  trátalo como sin respuesta.
- **Modo observación.** Si `ENFORCE_<APP>` de la app no es exactamente `"true"`, el Worker
  responde `ok` incluso a un dispositivo bloqueado, registra `blocked` y no cambia nada más: no
  escribe `bit0` ni propaga. El cliente no puede distinguir el modo por la respuesta.
- **Sin clave de Apple.** Una app sin secretos `APPLE_*` decide solo con D1. `dc_token` y
  `dc_token_update` se aceptan y se ignoran.
- **Si Apple falla.** Si DeviceCheck da error, la decisión usa solo D1.
- **Android.** Con `platform: "android"` el Worker nunca pregunta a Apple, sea cual sea la
  configuración de la app (ver [Clientes Android](#clientes-android)).
- **Usuario vacío.** El hash de un `user` vacío (`""`, o solo espacios y saltos de línea antes de
  normalizar) es el mismo para todo dispositivo que lo mande. El Worker lo descarta antes de
  nada: no coincide, no se propaga y no se vincula. Un cliente no debería mandarlo (los dos SDK
  lo omiten, el de Swift desde la `0.3.0`); un baneo de ese hash nunca coincide.
- **Propagación.** Con `ENFORCE` activo, un dispositivo bloqueado (por hash o por `bit0`) guarda
  todos sus hashes como baneados, y así el bloqueo salta a otro dispositivo con el mismo hash
  `icloud`.
- **Vínculo usuario-dispositivo (opcional).** Con `LINK_USERS_<APP>=true`, el Worker recuerda qué
  hashes `user` ha mandado cada `install` y consulta también esos. Un baneo por `user` llega
  entonces al dispositivo aunque no haya sesión o cambie la cuenta. Sin la variable, solo cuenta
  el hash `user` de la petición. El cliente no hace nada distinto. Ver la
  [sección 6.5](DISENO.md#65-vínculo-usuario-dispositivo-opcional-por-app) del diseño.
- **Desbaneo por `ref`.** Cuando un administrador desbanea por `ref`, la siguiente comprobación de
  ese dispositivo responde `ok` y quita `bit0` y los hashes del dispositivo. Si Apple está caída,
  o la app tiene clave y la petición no trae `dc_token` o `dc_token_update`, el dispositivo entra
  y el desbaneo espera a la siguiente comprobación. Gana la última decisión: un baneo manual
  posterior cancela el desbaneo pendiente.
- **No se guarda nada en bruto.** El Worker guarda hashes, `ref` y el resultado de cada
  comprobación, nunca identificadores ni IP.

## 4. Reglas que sigue el cliente

Estas reglas viven en el SDK de Swift (`swift/Sources/NonGrata/`) y en el SDK de Kotlin
(`android/nongrata/`; [guía](INTEGRACION-ANDROID.md)), que se comportan igual salvo donde la
plataforma difiere. Un cliente de otra plataforma debe cumplirlas para que listas y baneos coincidan.

### Normalización y hash

`SHA-256(prefix + ":" + kind + ":" + valor normalizado)`, sobre UTF-8, en hex minúsculas. El
`prefix` es el `HASH_PREFIX_<APP>` de la app (como `myapp-ban-v1`); el cliente se configura con
el mismo. Normalización, antes de hashear:

1. Quitar espacio, tabulador, `\n` y `\r` de los dos extremos.
2. `idfv` e `install`: pasar `a-z` a mayúsculas (solo ASCII).
3. `user` y `android_id`: pasar `A-Z` a minúsculas (solo ASCII).
4. `icloud`: dejarlo como está.

Los vectores de [spec/hash-vectors.json](../../spec/hash-vectors.json) fijan el resultado; un
cliente nuevo debe pasarlos. Ver [hash y ref](conceptos/hash-y-ref.md). Código de referencia:
`IdentifierHasher.swift` y `worker/src/hash.ts`.

### El `installId`

Un UUID aleatorio que el cliente crea una vez (`UUID().uuidString`) y guarda en el Keychain con
el servicio `nongrata` y la cuenta `installId`, accesible tras el primer desbloqueo y sin
sincronizar con otros dispositivos (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). La
regla que importa: crea uno nuevo solo cuando sabe que no hay. Si el almacén falla al leer, el
cliente no lo sobrescribe, no envía la comprobación y reintenta en la siguiente. La app no debe
borrar ese ítem.

### Fail-open

Solo un `200` con `{status, ref}` es una respuesta. Cualquier otro resultado (sin red, timeout,
`400`, `404`, `429`, `5xx`, un cuerpo que no se puede leer) es "sin respuesta", y entonces:

- Con marca local de bloqueo, el dispositivo sigue bloqueado.
- Sin ella, el veredicto es desconocido y la app sigue, **salvo** `intent = signup` con modo
  estricto, donde la app no debe crear la cuenta. El modo estricto es el `strictSignup` del SDK,
  activo por defecto.

### La marca local de bloqueo

- Una respuesta `blocked` escribe el `ref` como marca. Una respuesta `ok` la borra. Un error no
  toca nada. La marca es el ítem de Keychain `blockedRef` y, si se usa iCloud, la clave
  `nongrata.<app>.blockedRef` del almacén clave-valor de iCloud, para que un dispositivo con la
  misma cuenta de Apple se bloquee en vivo.
- Al arrancar la app, una marca significa bloqueado desde el primer instante, antes de cualquier
  comprobación.
- Si dos comprobaciones se solapan, decide la que empezó la última.

### Cuándo comprobar y cada cuánto

- `launch`, `login`, `signup` y `refresh` se envían cada vez que se llaman.
- `foreground` se omite (sin petición) cuando el veredicto actual es `allowed` y la última
  respuesta permitida tiene menos de `foregroundInterval` (6 horas por defecto). Estando
  bloqueado o con veredicto desconocido, comprueba siempre, para enterarse de un desbaneo. Ese
  instante solo se guarda en memoria.
- **`refresh` nunca se limita.** Sirve para una comprobación que fuerza la app: llegó su propio
  push, su backend avisó de una cuenta bloqueada, un temporizador con la app abierta.
- Un baneo llega a un dispositivo en su siguiente comprobación, no cuando se hace. Ver
  [cuánto tarda en llegar un baneo](INTEGRACION-IOS.md#cuánto-tarda-en-llegar-un-baneo).

### Tiempos y tokens

El SDK espera como máximo 5 s a la petición y a cada token (`timeout`), y 2 s al ID de iCloud
(`iCloudTimeout`). Si el dispositivo no puede generar tokens (el simulador), manda los dos como
`null`; el Worker decide entonces solo con D1. Si solo consigue un token, ese va como `dc_token`
y `dc_token_update` va como `null`.

## 5. Ejemplo

Petición, para la app `myapp` con el prefijo `myapp-ban-v1`:

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

El cuerpo válido más pequeño es `{"app":"myapp","ids":{"install":"<64 hex>"}}`.

Respuesta:

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store

{"status":"ok","ref":"C1456573"}
```

El mismo dispositivo, ya baneado (con `ENFORCE_MYAPP` activo):
`{"status":"blocked","ref":"C1456573"}`.
