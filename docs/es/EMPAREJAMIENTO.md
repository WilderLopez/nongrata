# Dispositivos de administración: emparejamiento y peticiones firmadas

*English: [DEVICE-PAIRING.md](../DEVICE-PAIRING.md)*

> **Estado: aprobado; implementado en el Worker (migración `0003`) y en la CLI (`pnpm ng pair`,
> `pnpm ng devices`).** Todavía no está en ninguna versión publicada. Los detalles que se
> decidieron al implementarlo están incorporados abajo; el lado del cliente (sección 7) es cosa de
> la app Dashboard.

Hoy todo cliente de administración se autentica con el `ADMIN_TOKEN` del Worker (ver la
[guía de la API de administración](API-ADMIN.md)). Eso vale para una terminal, pero una app de
móvil que administra baneos reales necesita algo mejor que un secreto compartido pegado a mano.
Este documento especifica cómo un **dispositivo de administración** (por ejemplo la app NonGrata
Dashboard en un iPhone, un iPad o un Mac) se empareja una vez con un Worker, guarda una clave
privada que nunca sale de su Secure Enclave y firma cada petición.

Nada de esto es específico de una app: lo puede usar cualquier cliente capaz de guardar una clave
P-256.

## 1. Visión general

```text
 terminal (ADMIN_TOKEN)              Worker                         dispositivo
 ──────────────────────              ──────                         ───────────
 pnpm ng pair role=admin ──POST /v1/admin/pairings──▶ emparejamiento (pendiente, 10 min)
 muestra QR ◀──────── id, secret, pair_url ─────────
                                                    ◀──POST /v1/pair/claim── escanea el QR, crea
                                                        id, secret, clave     una clave P-256 en el
                                                        pública, proof        Secure Enclave
                                reclamado ─────────── device_id, código ──▶ muestra el código 123456
 consulta, muestra "iPhone · 123456" ──GET /v1/admin/pairings/{id}──▶
 el admin compara, escribe y ───POST …/{id}/approve──▶ dispositivo activo
                                                    ◀──GET /v1/admin/me firmado── activo
```

1. El admin ejecuta `pnpm ng pair`. El Worker crea un **emparejamiento** de un solo uso que
   caduca en 10 minutos. La CLI lo muestra como código QR (y como enlace, para un Mac sin
   cámara).
2. El dispositivo lo escanea, crea una clave P-256 en su Secure Enclave y **reclama** el
   emparejamiento con el secreto del QR y su clave pública. El Worker guarda la clave como un
   dispositivo inactivo.
3. El dispositivo y la CLI muestran el mismo **código de verificación** de 6 cifras, derivado de
   la clave pública. El admin comprueba que coinciden y aprueba en la terminal. Solo entonces el
   dispositivo queda activo.
4. A partir de ahí, el dispositivo firma cada petición. El Worker comprueba la firma, la marca de
   tiempo y un nonce de un solo uso, y aplica el rol del dispositivo.

El paso de aprobación es lo que hace inofensivo un QR fotografiado: quien lo reclame primero
sigue necesitando que el admin, en la terminal, apruebe un código que solo muestra el dispositivo
legítimo.

**Convenciones.** Todo valor en base64url de este protocolo (IDs, secreto, clave pública,
prueba, nonce, firma) va sin relleno y en su forma canónica: el texto que decodifica al número de
bytes correcto y vuelve a codificarse en sí mismo. Cualquier otra cosa se rechaza. Donde se hace
hash o se firma una cadena (la prueba, el código de verificación, la cadena canónica), es el
texto base64url tal como se envía, no los bytes decodificados. Las longitudes de `name` y `label`
se cuentan en unidades de código UTF-16 (el `length` de JavaScript, el `utf16.count` de Swift).

## 2. Emparejamiento

### 2.1 Crear (solo `ADMIN_TOKEN`)

`POST /v1/admin/pairings` con `{ "role": "read" | "admin", "label"?: string }`. La etiqueta es
una pista para el admin, por ejemplo "iPhone de Ana": de 1 a 64 unidades de código UTF-16, o
`null`; los clientes la recortan antes de enviarla. Si no, `400 invalid role` o
`400 invalid label`.

El Worker genera `id` (16 bytes aleatorios) y `secret` (32 bytes aleatorios), los dos en
base64url sin relleno, y guarda **solo `SHA-256(secret)`** (el SHA-256 en hex del texto
base64url del secreto), el rol, la etiqueta y `expires_at = ahora + 10 min`. Respuesta:

```json
{
  "id": "q3V…",
  "secret": "Xk9…",
  "role": "admin",
  "expires_at": 1762790000000,
  "pair_url": "nongrata://pair?v=1&url=https%3A%2F%2Fnongrata-myapp.example.workers.dev&id=q3V…&secret=Xk9…&role=admin&exp=1762790000000"
}
```

El enlace es exactamente
`nongrata://pair?v=1&url=<origen, con codificación porcentual>&id=<id>&secret=<secret>&role=<role>&exp=<expires_at>`.
`url` es el origen del Worker, sacado de la petición; tiene que ser `https`, salvo
`http://localhost` y `http://127.0.0.1` (con cualquier puerto) para `wrangler dev`: desde
cualquier otro origen `http` el Worker responde `400 https required`, y la CLI avisa cuando
muestra un enlace `http` local. `role` y `exp` (ms Unix, el mismo valor que `expires_at`) son
solo para la pantalla del dispositivo: puede decir como qué se está emparejando, mostrar una
cuenta atrás y dejar de consultar. El rol que vale es el que guardó el Worker, que devuelven la
reclamación y `me`. El secreto se devuelve una vez y nunca más. Solo `ADMIN_TOKEN` puede crear emparejamientos, no un dispositivo de administración: un
dispositivo robado no debe poder dar de alta más dispositivos.

### 2.2 Reclamar (el dispositivo, sin otra credencial)

`POST /v1/pair/claim` (fuera de `/v1/admin/`, con el mismo límite de peticiones que
`/v1/device/check`: el mismo `RATE_LIMITER` por IP del cliente, `429 {"error":"rate_limited"}`
antes de leer el cuerpo):

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

- `public_key`: el punto P-256 sin comprimir (65 bytes, `0x04 || X || Y`), en base64url. Es lo
  que devuelve `SecKeyCopyExternalRepresentation` para la clave pública de un Secure Enclave.
- `name`: de 1 a 64 unidades de código UTF-16, se muestra en las listas de dispositivos; los
  clientes lo recortan antes de enviarlo. `platform`: `ios`, `ipados`, `macos` u `other`.
- `proof`: una firma con la clave nueva (formato en la sección 3.3) sobre
  `"NONGRATA-PAIR-V1\n" + id + "\n" + public_key`, con `id` y `public_key` como las cadenas
  base64url enviadas. Demuestra que quien reclama tiene la clave privada.

La forma de `name` y `platform` se comprueba primero, antes incluso de buscar el
emparejamiento: `400 {"error":"invalid name"}` (falta, no es texto, está vacío o pasa de 64) o
`400 {"error":"invalid platform"}`. Estos sí dicen qué está mal, porque no revelan nada del
emparejamiento, y no cuentan como intentos fallidos. Después el Worker compara `SHA-256(secret)`
en tiempo constante y comprueba la clave y la prueba; después, un único `UPDATE` condicional reclama el emparejamiento solo si sigue existiendo,
no ha caducado, no se ha reclamado y no está quemado, así que dos reclamaciones a la vez no pueden
ganar las dos. En la misma transacción crea el dispositivo (16 bytes aleatorios como
`device_id`) con `status = pending`, y responde
`{ "device_id": "…", "role": "admin", "verification_code": "123456" }`.

A partir de ahí, cada reclamación fallida de un `id` que existe suma uno a un contador, sea cual
sea el fallo (el secreto, la clave, la prueba, o un emparejamiento ya reclamado o caducado); al
llegar a 5 el emparejamiento queda quemado. Esos errores son siempre
`400 {"error":"invalid pairing"}`, sin decir qué comprobación falló. Un cuerpo que no es un objeto
JSON, o un `id` que no son 16 bytes en base64url o que no existe, da el mismo error y no suma
nada.

### 2.3 Código de verificación

`verification_code` = los 4 primeros bytes de `SHA-256("NONGRATA-VERIFY-V1\n" + id + "\n" +
public_key)` (las cadenas base64url tal como se envían) leídos como entero sin signo big-endian,
módulo 1 000 000, rellenado a 6 cifras. El dispositivo lo calcula por su cuenta a partir de su
clave; no se fía de la copia del Worker.

### 2.4 Aprobar (solo `ADMIN_TOKEN`)

- `GET /v1/admin/pairings/{id}`: `{ status: "pending" | "claimed" | "approved" | "expired",
  role, label, expires_at, device?: { device_id, name, platform, verification_code } }`.
  `device` aparece una vez reclamado, mientras el dispositivo exista. `approved` gana a todo; si
  no, un emparejamiento está `expired` después de `expires_at` (en ese mismo milisegundo todavía
  no) o una vez quemado. La CLI lo consulta cada 2 segundos.
- `POST /v1/admin/pairings/{id}/approve`: solo para `claimed` y sin caducar. El dispositivo pasa
  a `active`, la aprobación va al registro de administración (sección 4) y la respuesta es
  `{ device_id, name, platform, role, status: "active" }`. Si no, `409` con
  `pairing not claimed`, `pairing already approved` o `pairing expired`.
- `DELETE /v1/admin/pairings/{id}`: lo cancela (`{ "cancelled": true }`). Si estaba reclamado,
  se borra el dispositivo pendiente. Un emparejamiento aprobado no se puede cancelar
  (`409 pairing already approved`): revoca el dispositivo.

Un `{id}` desconocido da `404 pairing not found`. Un emparejamiento reclamado que no se aprueba
antes de `expires_at` caduca: su dispositivo pendiente ya no puede llamar a nada, y el cron diario
lo borra junto con el emparejamiento. `pnpm ng pair` hace todo esto en un solo comando:

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

Los emparejamientos son de un Worker, no de una app: `app=` solo elige con qué Worker hablar, con
`NONGRATA_URL_<APP>` y `NONGRATA_ADMIN_TOKEN_<APP>`, como en todos los demás comandos. El código
QR lo dibuja la propia CLI (modo byte, nivel M, hasta la versión 10, así que enlaces de hasta 213
bytes; uno más largo se imprime solo como enlace), en negro sobre blanco para que también se
pueda escanear desde una terminal oscura.

**Cuando los códigos no coinciden.** Es la persona quien compara los dos códigos; la pregunta
tiene N por defecto, y cualquier respuesta que no sea `y` o `yes` (también una línea vacía o el
final de la entrada) hace que la CLI mande `DELETE /v1/admin/pairings/{id}`, que borra el
dispositivo pendiente. La siguiente llamada del dispositivo a `GET /v1/admin/me` recibe entonces
`401`: borra su clave y le dice al usuario que el emparejamiento fue rechazado. Lo mismo pasa si
el emparejamiento caduca antes de aprobarse.

## 3. Peticiones firmadas

### 3.1 Cabeceras

| Cabecera | Valor |
|---|---|
| `NonGrata-Device` | El `device_id`. |
| `NonGrata-Timestamp` | Milisegundos Unix, como entero decimal (solo cifras, como mucho 15). |
| `NonGrata-Nonce` | 16 bytes aleatorios, en base64url. Uno nuevo en cada petición. |
| `NonGrata-Signature` | La firma (sección 3.3) de la cadena canónica, en base64url. |

Los valores en base64url siguen las convenciones de la sección 1.

Una petición con `NonGrata-Device` y además `Authorization` se rechaza (`400 {"error":"ambiguous
credentials"}`), sea cual sea el token: cada petición tiene exactamente una identidad. Sin
`NonGrata-Device`, `/v1/admin/*` funciona exactamente como antes con el token.

### 3.2 Cadena canónica

Las líneas de abajo, unidas con `\n` (sin salto de línea final), codificadas en UTF-8:

```text
NONGRATA-SIG-V1
<MÉTODO, en mayúsculas>
<host: new URL(request.url).host, en minúsculas, sin el puerto por defecto>
<ruta: new URL(request.url).pathname, exactamente como viene>
<query canónica>
<NonGrata-Timestamp>
<NonGrata-Nonce>
<NonGrata-Device>
<SHA-256 en hex minúsculas de los bytes del cuerpo tal cual; de la cadena vacía si no hay cuerpo>
```

El host y la ruta son lo que da el parser de URL de WHATWG para la URL de la petición
(`new URL(...)` en el Worker): `host` sin el puerto por defecto del esquema, y `pathname`
exactamente como viene. Manda la ruta ya normalizada (sin segmentos `.` ni `..`), porque el
parser los resuelve.

Query canónica: cada par `nombre=valor` de la query string, decodificado exactamente como lo
hace `URLSearchParams` de WHATWG (un `+` suelto es un espacio, un par sin `=` queda como
`nombre=` con valor vacío, los pares vacíos se saltan, un escape `%` no válido se conserva
literal), cada nombre y valor codificado de nuevo a partir de sus bytes UTF-8 dejando solo los
caracteres no reservados de RFC 3986 (`A–Z a–z 0–9 - . _ ~` se quedan, todo lo demás como `%XX`
en mayúsculas, así que un `%` literal pasa a `%25`), ordenados por el nombre recodificado y
después por el valor recodificado en orden de unidades de código (tras codificar son ASCII, así
que es orden de bytes), y unidos con `&`. Los pares repetidos se conservan. Vacía si no hay
query. Ojo: `URLComponents` no codifica `+` en una query; manda `%2B` para un signo más.

Atar el host y el dispositivo hace que una firma capturada no sirva contra otro Worker ni como
otro dispositivo.
[spec/device-signature-vectors.json](../../spec/device-signature-vectors.json) tiene cadenas
canónicas, hashes de cuerpos, firmas (en bruto y DER) con una clave de prueba fija, la prueba de
la reclamación y códigos de verificación, todo calculado con `openssl` y `shasum`.

### 3.3 Formato de la firma

ECDSA P-256 con SHA-256, como **`r || s` en bruto** (64 bytes, cada uno big-endian y rellenado
por la izquierda a 32 bytes), en base64url. Es lo que verifica WebCrypto. El
`SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` de Apple devuelve DER, así que el
cliente lo convierte. El Worker rechaza todo lo que no tenga exactamente 64 bytes.

### 3.4 Qué comprueba el Worker, en orden

0. Las cuatro cabeceras están y tienen el formato correcto (sección 3.1). Si no, `401`, antes de
   leer nada de D1.
1. El dispositivo existe, no está revocado, y está `active`, o `pending` mientras su
   emparejamiento no haya caducado ni se haya cancelado.
2. `|ahora − timestamp| ≤ 5 minutos`. Si no, `401 {"error":"unauthorized","reason":"clock",
   "server_time": <ms>}`, para que la app pueda decirle al usuario que su reloj va mal. Nunca se
   da otro motivo, y solo lo recibe un dispositivo que pasó el paso 1.
3. La firma se verifica con la clave pública del dispositivo.
4. El nonce es nuevo: `INSERT INTO admin_nonces (device_id, nonce, expires_at)` con
   `expires_at = timestamp + 10 minutos`; un conflicto de clave primaria es una repetición. Cada
   inserción borra además los nonces caducados de ese dispositivo, y el cron diario borra los de
   todos, así que la tabla nunca guarda más de unos diez minutos de peticiones.
5. El rol permite la ruta (sección 4). Un dispositivo pendiente solo puede llamar a
   `GET /v1/admin/me`.

Los pasos 0, 1, 3 y 4 fallan con el mismo `401 {"error":"unauthorized"}`; el paso 5 con `403
{"error":"forbidden"}`. Una ruta desconocida responde `404 {"error":"not_found"}` solo después de
los pasos 0 a 4, como con el token. La firma se verifica antes de guardar el nonce, así que una
petición sin autenticar nunca escribe en D1. Un nonce es de un dispositivo: dos dispositivos
pueden usar el mismo. Si todo va bien, el Worker actualiza el `last_used_at` del dispositivo
(como mucho una vez por minuto; un `403` no cuenta).

Un dispositivo pendiente solo puede llamar a `GET /v1/admin/me`, que le dice cuándo lo han
aprobado; cualquier otra cosa da `403 {"error":"forbidden"}`. Cuando su emparejamiento caduca o
se cancela, recibe `401` en todas partes.

## 4. Roles

| Ruta | Dispositivo `read` | Dispositivo `admin` | `ADMIN_TOKEN` |
|---|---|---|---|
| `GET /v1/admin/me` | sí | sí | no (no es un dispositivo) |
| `GET /v1/admin/apps`, `lookup`, `bans`, `checks`, `log` | sí | sí | sí |
| `POST /v1/admin/ban`, `unban` | no | sí | sí |
| `GET /v1/admin/devices` | no | sí | sí |
| `POST /v1/admin/devices/{id}/revoke` | solo a sí mismo | sí | sí |
| `/v1/admin/pairings…` | no | no | sí |

Una ruta a la que la columna de quien llama dice "no" responde `403 {"error":"forbidden"}`,
también `me` con el token, y todas menos `me` para un dispositivo pendiente.

Rutas de lectura nuevas:

- `GET /v1/admin/me`: `{ device_id, name, platform, role, status, created_at }`.
- `GET /v1/admin/apps`: las apps configuradas en este Worker, ordenadas, `{ apps: [{ app,
  enforce, devicecheck }] }` (`devicecheck` dice si está puesta la clave de Apple). Nada
  secreto. El Worker solo ve el sufijo de `HASH_PREFIX_<APP>`, así que `app` es ese sufijo en
  minúsculas: un id de app con `-` (que el sufijo escribe como `_`) aparece con `_`. Usa ids de
  app sin `-` si un cliente elige la app de esta lista.
- `GET /v1/admin/devices`: `{ devices: [{ device_id, name, platform, role, status, created_at,
  last_used_at, revoked_at }] }`, de más reciente a más antiguo, con los pendientes y los
  revocados. Nunca la clave pública.

`admin_log` gana una columna `actor` (`token` o `device:<device_id>`) en cada acción, y las
acciones nuevas `pair` (aprobado) y `revoke`, junto a `ban` y `unban`. `pair` y `revoke` afectan
a todo el Worker, no a una app, así que sus filas se guardan con `app` NULL y llevan el
dispositivo en una columna nueva, `device_id` (`pair` guarda además la etiqueta del
emparejamiento como `note`). `GET /v1/admin/log?app=…` devuelve los `ban` y `unban` de esa app,
como antes; sin `app` devuelve los eventos de dispositivos de todo el Worker, con la misma
paginación y `"app": null` en la página:
`{ "app": null, "items": [{ action, kind, hash, ref, note, device_id, actor, created_at }],
"next_cursor": … }`. Un `app` presente pero incorrecto sigue dando `invalid app` o
`app not configured`. Los elementos del registro ganan `device_id` y `actor` (`null` en las filas
anteriores a la migración `0003`).

## 5. Revocación y dispositivo perdido

`POST /v1/admin/devices/{id}/revoke` (desde la CLI con `pnpm ng devices revoke app=… id=…`, o
desde cualquier otro dispositivo de administración) pone `revoked_at` y responde
`200 { "device_id": "…", "revoked_at": <ms> }`. Es idempotente: revocar otra vez responde lo
mismo, con el `revoked_at` original, y no escribe nada. Un id desconocido da
`404 {"error":"not_found"}` (solo el token y los dispositivos admin pueden llamarlo, así que no
filtra nada). Desde la siguiente petición ese dispositivo recibe `401`. La revocación es
permanente: para volver a usar ese teléfono, hay que emparejarlo otra vez. Cualquier dispositivo
activo puede revocarse a sí mismo, también uno `read` ("Quitar este Worker" en la app hace eso y
después borra la clave).

La clave se crea con `.biometryCurrentSet` (sección 7), así que volver a registrar Face ID o
Touch ID la invalida: el dispositivo tiene que emparejarse de nuevo (y conviene revocar la
entrada antigua).

Un dispositivo perdido o robado: su clave está en el Secure Enclave y la app pide Face ID o
Touch ID para usarla (sección 7), así que un ladrón con el teléfono bloqueado no puede hacer
nada. Revócalo de todos modos desde la terminal o desde otro dispositivo.

## 6. Convivencia con `ADMIN_TOKEN`

La CLI y cualquier integración existente siguen funcionando igual con `Authorization: Bearer`.
El token sigue siendo la credencial raíz: es la única forma de crear emparejamientos. Una vez
emparejados tus dispositivos, sácalo del uso diario (por ejemplo, solo en un gestor de
contraseñas) y rótalo con `wrangler secret put ADMIN_TOKEN` si puede haberse filtrado; rotarlo no
afecta a los dispositivos emparejados.

## 7. El lado del cliente (informativo)

Lo que debe hacer un cliente para que esto sea tan seguro como se describe. NonGrata Dashboard
lo hace.

- Crear la clave con `kSecAttrTokenIDSecureEnclave`, `kSecAttrIsPermanent` y un control de acceso
  `.privateKeyUsage` más `.biometryCurrentSet` (o `.userPresence` donde no haya biometría),
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Una clave por cada Worker emparejado.
- Mantener las lecturas dentro de una sesión corta: la app lleva su propio temporizador de 5
  minutos, que también termina cuando la app pasa a segundo plano
  (`touchIDAuthenticationAllowableReuseDuration` no mantiene vivo un `LAContext` por sí solo).
  Volver a pedir Face ID antes de cada baneo, desbaneo o revocación.
- `.biometryCurrentSet` invalida la clave cuando se vuelve a registrar Face ID o Touch ID; la app
  se empareja de nuevo (sección 5).
- Ante un error `clock`, explicárselo al usuario. En la v1, nunca reintentar automáticamente con
  un desfase sacado de `server_time`.
- Mostrar bien visible el host del Worker antes de reclamar, para que se note un QR malicioso
  que apunte a otro Worker.
- No registrar nunca el secreto del QR; olvidarlo después de reclamar.

## 8. App Attest (no en la primera versión)

App Attest permitiría al Worker comprobar que la clave pertenece a la app Dashboard auténtica en
un dispositivo de Apple auténtico. No ayuda con los riesgos principales de aquí (un QR filtrado lo
cubre el código de aprobación; un teléfono robado, el Secure Enclave y la biometría), ataría todo
Worker autoalojado al Team ID de una app, y verificar atestaciones obliga a analizar CBOR y la
cadena de certificados de Apple en el Worker. Fuera de la v1; el protocolo deja sitio para ello
como un campo `attestation` opcional en la reclamación.

## 9. Modelo de amenazas

| Amenaza | Qué pasa | Mitigación |
|---|---|---|
| Fotografían el QR o se filtra el enlace | El atacante puede reclamar el emparejamiento primero. | El admin tiene que aprobar un código de 6 cifras que muestra el dispositivo legítimo; una reclamación equivocada o inesperada se cancela. Los emparejamientos duran 10 minutos y valen una vez. |
| Alguien adivina un emparejamiento | — | `id` de 128 bits, secreto de 256 bits, 5 intentos fallidos queman el emparejamiento, límite de peticiones. |
| Dispositivo robado o perdido | El ladrón tiene el teléfono. | La clave nunca sale del Secure Enclave y necesita biometría. Revócalo. |
| Repetición de una petición capturada | Un atacante reenvía una petición firmada. | Nonce de un solo uso guardado 10 minutos, ventana de 5 minutos para la marca de tiempo. |
| Petición modificada por el camino | El atacante cambia el cuerpo o la query. | La firma cubre método, host, ruta, query, hash del cuerpo, hora y nonce. Además de HTTPS. |
| Firma reutilizada contra otro Worker o como otro dispositivo | — | El host y el ID del dispositivo están en la cadena canónica; las claves son por Worker. |
| Reloj desfasado en el dispositivo | Se rechazan peticiones válidas. | Ventana de 5 minutos; el motivo `clock` con `server_time` permite a la app explicarlo. |
| QR malicioso que apunta a un Worker falso | El dispositivo se empareja con el Worker del atacante. | Solo puede mostrar datos falsos: ningún secreto sale del dispositivo. La app muestra el host antes de reclamar. |
| Se filtra `ADMIN_TOKEN` | El atacante puede hacerlo todo, incluso emparejar su propio dispositivo. | Igual que hoy. Saca el token del uso diario, rótalo y revisa `GET /v1/admin/devices` y el registro (`actor`). |
| Se compromete un dispositivo `read` | El atacante puede leer hashes, refs y comprobaciones. | Nunca se guardan identificadores en bruto. Revócalo. |
| Se compromete el Worker o la cuenta de Cloudflare | Todo. | Fuera de alcance: el Worker es el ancla de confianza. |
| Inundar `/v1/pair/claim` o las rutas firmadas | Escrituras en D1. | Límite de peticiones en las reclamaciones; nada se escribe antes de que una firma se verifique. |

## 10. Almacenamiento (migración `0003`)

```sql
CREATE TABLE admin_pairings (
  id               TEXT PRIMARY KEY,
  secret_hash      TEXT NOT NULL,        -- SHA-256 en hex del secreto (de su texto base64url)
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
  public_key    TEXT NOT NULL,           -- base64url, punto P-256 sin comprimir de 65 bytes
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

-- admin_log, reconstruida (ver abajo), queda así:
CREATE TABLE admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT,                     -- NULL en pair y revoke
  action      TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'pair', 'revoke')),
  kind        TEXT CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  hash        TEXT,
  ref         TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  device_id   TEXT,                     -- el dispositivo de pair y revoke
  actor       TEXT CHECK (actor = 'token' OR actor LIKE 'device:%'),  -- NULL en filas antiguas
  CHECK ((app IS NULL) = (action IN ('pair', 'revoke')))
);
```

`admin_log.action` tenía un `CHECK` limitado a `ban` y `unban`; SQLite no puede cambiar un
`CHECK` en su sitio, así que la migración reconstruye la tabla (copiar, borrar, renombrar,
recrear el índice), conservando todas las filas y sus ids, para admitir `pair` y `revoke`, hacer
`app` opcional y añadir `device_id` y `actor`. El cron diario borra los nonces caducados, los
emparejamientos caducados (aprobados o no: un dispositivo activo ya no necesita su
emparejamiento) y los dispositivos pendientes cuyo emparejamiento caducó, se quemó o se borró.

**Actualizar un despliegue.** Aplica la migración `0003_admin_devices.sql` antes de desplegar el
Worker nuevo (`wrangler d1 migrations apply DB --remote`, como en el README); hasta entonces
`ban`, `unban` y `log` fallan con un `500`, porque escriben o leen las columnas nuevas del
registro, mientras que `/v1/device/check` sigue funcionando. Comprueba que se aplicó de verdad con
`wrangler d1 migrations list DB --remote` (nada pendiente): desde un script u otra terminal no
interactiva, Wrangler puede saltarse su pregunta de confirmación sin aplicar nada; antepón `CI=1`
para que responda que sí.
