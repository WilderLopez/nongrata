# NonGrata: diseño

*English: [DESIGN.md](../DESIGN.md)*

Fecha: 2026-10-15
Nombre: NonGrata, de *persona non grata* (alguien que ya no es bienvenido).
Estado (2026-11-10): implementado salvo App Attest y las pruebas de extremo a extremo en un iPhone.

Este documento recoge todo lo investigado y decidido para construir un sistema de baneo por
dispositivo y por cuenta de Apple, sin depender del backend de cada app, usando DeviceCheck de
Apple y un Cloudflare Worker. Es de código abierto y está pensado para reutilizarse en cualquier
app iOS: cada app tiene su propio despliegue del Worker y su propia lista.

## 0. Cómo usar este documento

Es el diseño completo: qué problema resuelve (sección 1), cómo está montado (secciones 5 a 9),
cómo se prueba (13) y qué queda por confirmar (16). Para integrarlo en una app basta con
[Integrar en una app iOS](INTEGRACION-IOS.md); los conceptos sueltos están en `conceptos/` y en
el [Glosario](glosario.md).

Las afirmaciones marcadas como "verificado" se comprobaron en la documentación oficial el
2026-10-15. Las marcadas como "por verificar" son conocimiento previo o inferencias y hay que
comprobarlas antes de apoyarse en ellas.

## 1. Problema y lo aprendido del caso real

Unos pocos actores crean cuentas en cadena para hacer spam en una app social. El caso
analizado: una persona, al menos 11 cuentas, 3 iPhones, una cuenta nueva cada pocos días,
correos Gmail desechables y, a ratos, una VPN.

Lo que enseñó el análisis de los datos de analítica:

- **El `idfv` funciona mientras no reinstalan.** En un iPhone se repetía en 5 cuentas y en otro
  en 3 o más, porque el actor solo cerraba sesión y abría otra cuenta.
- **El `idfv` cambia al reinstalar.** El mismo iPhone apareció con dos `idfv` distintos. Por
  sí solo es un freno, no un muro.
- **La IP no sirve para banear.** La IP principal del actor la compartían unas 30 cuentas, la
  mayoría legítimas (IP compartida de operador). La otra era una VPN.
- **El correo no sirve.** Son Gmail normales; no hay dominio que bloquear.
- **Los patrones de perfil delatan** (mismo género, edad, idioma, ciudad y prefijo de nombre de
  usuario, sin verificar, sin compras), pero banear por eso es una decisión manual.
- **En el SDK de Amplitude para iOS, `device_id` es igual al `idfv`.** Sirve para agrupar
  cuentas por dispositivo en la analítica.
- **Algunas cuentas no aparecían en la analítica** por no haberse llegado a identificar. Conviene
  que el identificador propio también llegue al backend de la app, aunque sea como texto libre.

## 2. Objetivos

Bloquear la app en un dispositivo marcado, antes del login y del registro, de forma que:

1. Cerrar sesión y crear otra cuenta no sirva.
2. Reinstalar la app no sirva.
3. Borrar el iPhone, o usar otro con la misma cuenta de Apple, no sirva.
4. Un error se pueda deshacer.
5. Un fallo de la infraestructura nunca bloquee a usuarios normales.

### No objetivos

- Proteger la API de cada app: el bloqueo lo aplica el cliente. Para eso, el backend de cada app
  tendría que exigir el veredicto (ver la sección 6.3 sobre App Attest, que lo acerca bastante).
- Detección automática: banear es una decisión manual.
- Android en la primera versión (sección 15).

## 3. Hechos verificados

### Apple

| Tema | Lo que dice la documentación | Fuente |
|---|---|---|
| `UIDevice.identifierForVendor` | Igual para las apps del mismo vendedor en el mismo dispositivo. Cambia cuando el usuario borra todas las apps del vendedor y reinstala. Puede ser `nil` tras reiniciar y antes de desbloquear. | developer.apple.com/documentation/uikit/uidevice/identifierforvendor |
| `DCDevice` | Token efímero que identifica el dispositivo. Comprobar `isSupported`. iOS 11+. La app debe estar asociada a la cuenta de desarrollador. Existe `generateToken() async throws -> Data`. | developer.apple.com/documentation/devicecheck/dcdevice |
| Token de DeviceCheck | Tratarlo como de un solo uso. Sirve para reintentar una petición concreta, no para reutilizarlo. **No sirve como identificador**: no se pueden comparar tokens. | developer.apple.com/documentation/devicecheck/dcdevice/generatetoken(completionhandler:) |
| Two bits | Dos bits por dispositivo en servidores de Apple. Endpoints `POST /v1/query_two_bits`, `POST /v1/update_two_bits` y `POST /v1/validate_device_token`. Cuerpo con `device_token`, `transaction_id` y `timestamp` (ms), más `bit0` y `bit1` al actualizar. La consulta devuelve `bit0`, `bit1` y `last_update_time` (`YYYY-MM`). `200 Bit State Not Found` si nunca se escribieron. | developer.apple.com/documentation/devicecheck/accessing-and-modifying-per-device-data |
| Entornos | `https://api.development.devicecheck.apple.com` solo para desarrollo; producción en `https://api.devicecheck.apple.com`. | Misma página |
| Persistencia de los bits | El desarrollador decide cuándo resetearlos, "por ejemplo, cuando el usuario vende el dispositivo". Sobreviven a reinstalar y al cambio de dueño. | developer.apple.com/documentation/devicecheck/dcdevice |
| Escritura de bits | Para escribir hace falta un token recién generado por **ese** dispositivo. No se puede banear un dispositivo que no vuelve a conectarse: el bit se marca en su siguiente comprobación. | Inferido de las dos páginas anteriores |
| JWT | Mismo procedimiento que el token de proveedor de APNs. Cabecera `alg: ES256` y `kid` (Key ID de 10 caracteres). Claims `iss` (Team ID) e `iat` (segundos). El `iat` no puede tener más de una hora. `Authorization: Bearer <JWT>`. Al crear la clave en el portal, activar el servicio DeviceCheck. | developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns |
| App Attest, métrica de riesgo | El recibo devuelto por `attestationData` trae en el campo 17 el número de claves certificadas para el dispositivo en los últimos 30 días. Crece al reinstalar, restaurar o transferir el dispositivo. Producción en `https://data.appattest.apple.com`, sandbox en `https://data-development.appattest.apple.com`. Refrescar después del "Not Before" (campo 19) y antes de la caducidad (campo 21). | developer.apple.com/documentation/devicecheck/assessing-fraud-risk |
| `CKContainer.userRecordID()` | ID del usuario de iCloud dentro del contenedor. Error `notAuthenticated` si no hay cuenta o iCloud está desactivado o restringido. La primera consulta puede tardar. **Por verificar**: que el ID sea estable entre dispositivos y reinstalaciones (es lo esperado, pero la página no lo dice). | developer.apple.com/documentation/cloudkit/ckcontainer/fetchuserrecordid(completionhandler:) |
| `publicCloudDatabase` | Disponible aunque el dispositivo no tenga cuenta de iCloud. Descartada como almacén de la lista (sección 4). | developer.apple.com/documentation/cloudkit/ckcontainer/publicclouddatabase |
| `NSUbiquitousKeyValueStore` | Se propaga a todos los dispositivos con la misma cuenta de Apple. Sin cuenta, queda en local hasta que se inicie sesión. Máximo 1024 claves y 1 MB. Avisa de que no se guarden datos sensibles (sin cifrar). Requiere el entitlement `com.apple.developer.ubiquity-kvstore-identifier` y distribución por App Store. | developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore |
| `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | Accesible tras el primer desbloqueo después de reiniciar. `ThisDeviceOnly`: no migra a otro dispositivo por copia de seguridad. | developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly |
| Keychain tras desinstalar | **Comportamiento observado, no documentado como garantía**: los ítems del Keychain sobreviven a la reinstalación. Muchas apps lo confirman en la práctica (de ahí el patrón de borrar tokens en la primera ejecución). | Sin fuente oficial |

### Cloudflare (developers.cloudflare.com)

| Tema | Dato | Fuente |
|---|---|---|
| Workers, plan gratuito | 100.000 peticiones al día, reinicio a medianoche UTC; al pasarse, error 1027. 10 ms de CPU por petición HTTP. 50 subpeticiones por petición. | /workers/platform/limits/ |
| D1, plan gratuito | 5 millones de filas leídas y 100.000 escritas al día. 5 GB en total, 500 MB por base, 10 bases por cuenta, 50 consultas por invocación. Al pasarse, las consultas fallan hasta el reinicio. | /d1/platform/pricing/ y /d1/platform/limits/ |
| KV, plan gratuito | 100.000 lecturas y 1.000 escrituras a claves distintas al día. Un cambio puede tardar 60 s o más en verse en otras ubicaciones. | /kv/platform/limits/ y /kv/concepts/how-kv-works/ |
| Secretos | `wrangler secret put <KEY>` (en este repo, con `pnpm exec`), se leen en `env.<KEY>`. En local, `.dev.vars` (fuera de git). | /workers/configuration/secrets/ |
| Web Crypto | ECDSA soportado para `importKey` y `sign`. La página no detalla curvas ni formatos. **Por verificar** en la prueba de concepto: P-256 con `pkcs8` (es Web Crypto estándar). | /workers/runtime-apis/web-crypto/ |
| Rate limiting binding | `ratelimits` en wrangler con `name`, `namespace_id` y `simple: { limit, period }`; `period` solo 10 o 60 s. Por ubicación y eventualmente consistente. Requiere wrangler 4.36.0 o superior. **Por verificar**: disponibilidad en el plan gratuito. | /workers/runtime-apis/bindings/rate-limit/ |

## 4. Decisiones tomadas y descartes

| Opción | Decisión | Motivo |
|---|---|---|
| Banear por `idfv` | Se usa, pero no basta | Cambia al reinstalar |
| UUID propio en el Keychain | Se usa | Sobrevive a reinstalar; enlaza cuentas |
| DeviceCheck | Se usa para hacer cumplir el bloqueo | Sobrevive a reinstalar y a borrar el dispositivo; no se puede falsificar el token |
| iCloud (`userRecordID` y KVS) | Se usa, opcional por app | Marca la cuenta de Apple y salta a otros dispositivos |
| Banear por IP | Descartado | IPs compartidas de operador; falsos positivos masivos |
| Lista en Firebase Remote Config | Descartado | La configuración es descargable por cualquiera; expone la lista |
| Lista en CloudKit público | Descartado | Deja fuera a Android; no aporta nada frente al Worker |
| Firebase Cloud Functions | Descartado | Exige el plan Blaze; Cloudflare ya está en uso |
| KV para la lista | Descartado | Propagación lenta y pocas escrituras gratis |
| D1 para la lista | Elegido | Lectura coherente tras escribir; margen gratuito amplio |
| App Attest | Opcional (sección 6.3) | Cierra el hueco de la app modificada; las apps que ya lo tengan lo aprovechan |

## 5. Arquitectura

```
 App (SDK)                                 Worker NonGrata                             Apple
 ─────────                                 ───────────────                             ─────
 1. idfv, installId (Keychain),
    userRecordID (iCloud), userId
    → hashes SHA-256 con prefijo de la app
 2. DCDevice.generateToken()
 3. POST /v1/device/check   ───────────►   4. rate limit por IP
                                           5. (opcional) validar aserción App Attest
                                           6. D1: ¿algún hash baneado? ¿ref desbaneado?
                                           7. query_two_bits   ──────────────────────►   bits
                                           8. si toca: update_two_bits   ────────────►   bit0
                                           9. si bloquea, sus hashes nuevos se
                                              añaden a la lista (propagación)
10. { status, ref }  ◄─────────────────────
11. blocked → la app cierra sesión, muestra
    su pantalla y guarda la marca local
    (Keychain + iCloud KVS)
```

### Capas

| Qué hace el actor | Qué lo atrapa |
|---|---|
| Cierra sesión y crea otra cuenta | `idfv`, `installId` |
| Reinstala la app | `installId`, `bit0` |
| Borra el iPhone y entra con la misma cuenta de Apple | `bit0`, `userRecordID`, marca KVS |
| Otro iPhone con la misma cuenta de Apple | `userRecordID`, marca KVS |
| Borra el iPhone y usa otra cuenta de Apple | `bit0` |
| Bloquea el dominio del Worker | Marca local si ya estaba bloqueado; modo estricto en el registro (sección 6.2) |
| Modifica la app para no llamar al Worker | App Attest exigido por el backend de la app (sección 6.3) |

La propagación del paso 9 hace que el sistema se refuerce solo: un dispositivo bloqueado (por
un hash o por `bit0`) que aparece con identificadores nuevos los convierte en baneados, y con
ellos cae su cuenta de Apple en el resto de dispositivos del actor.

## 6. Contrato y algoritmo

> Cambios de la implementación (2026-10-15): la propagación se aplica a cualquier dispositivo
> bloqueado, no solo al marcado por `bit0` (si no, el bloqueo no saltaba a otros dispositivos con
> la misma cuenta de Apple), y el desbaneo por `ref` borra los hashes del dispositivo.
>
> Cambios de la implementación (2026-10-29): con clave de Apple, un desbaneo por `ref` que llega
> en una comprobación sin `dc_token` deja entrar pero no se consume ni borra hashes; se consume en
> la siguiente con token, tras poner `bit0` a false. Antes se consumía sin limpiar `bit0` y el
> dispositivo volvía a quedar bloqueado. Sin clave de Apple se sigue consumiendo solo con D1.
>
> Cambios de la implementación (2026-11-02): cada `update_two_bits` del algoritmo usa
> `dc_token_update`. Si falta, no se escribe: el bloqueo se decide igual con D1 y `bit0`, y un
> desbaneo pendiente queda sin consumir, como cuando falta `dc_token`.

### 6.1 `POST /v1/device/check`

Petición:

```json
{
  "app": "myapp",
  "dc_token": "base64 o null",
  "dc_token_update": "base64 o null",
  "env": "development | production",
  "ref": "A1B2C3D4",
  "ids": {
    "idfv": "hex o null",
    "install": "hex",
    "icloud": "hex o null",
    "user": "hex o null"
  },
  "intent": "launch | foreground | login | signup",
  "platform": "ios",
  "app_version": "1.0.0"
}
```

Respuesta `200`:

```json
{ "status": "ok | blocked", "ref": "A1B2C3D4" }
```

Cualquier otra respuesta el cliente la trata como error.

`dc_token_update` (añadido en la implementación): Apple pide tratar cada token de DeviceCheck
como de un solo uso, así que el SDK genera un segundo token para `update_two_bits`. Si falta, el
Worker consulta pero no escribe; se escribe en la siguiente comprobación que traiga los dos
(cambio del 2026-11-02; antes reutilizaba `dc_token`). El Worker deriva `ref` del hash de `install` e ignora el que mande el
cliente.

`app` permite que un mismo Worker sirva a varias apps con listas separadas (sección 7.1). Si se
prefiere aislamiento total, un despliegue por app y se ignora el campo.

Algoritmo:

```
si rate limit excedido                → 429
config = configuración de `app`        (Team ID, Key ID, clave, ENFORCE, App Attest)
si config exige App Attest y la aserción no valida → 401

hashes  = ids no nulos
matched = existe en banned_ids (app, hash IN hashes)
unban   = unban_refs (app, ref) no consumido

bits = dc_token ? query_two_bits(env, dc_token) : null      // "Bit State Not Found" ⇒ bit0 = false

si unban:
    limpio = dc_token ? update_two_bits(bit0 = false) : true
    si limpio: borrar de banned_ids los hashes de la petición y consumir unban
    responder ok                       // si no quedó limpio, se reintenta en la siguiente

blocked = matched o bits.bit0 == true

si ENFORCE de la app está apagado:      // modo observación pura (decidido el 2026-11-02)
    registrar `blocked` y responder ok  // sin escribir en Apple ni propagar

si matched y bits y bits.bit0 != true:
    update_two_bits(bit0 = true)
si blocked:
    insertar los hashes nuevos en banned_ids con reason = propagated (sin pisar los existentes)
responder { status, ref }
```

Si Apple falla (5xx, 429, timeout), se decide solo con D1. `bit1` queda reservado (por ejemplo,
"en revisión").

### 6.2 Fail-open y modo estricto

- **Por defecto, fail-open.** Si la comprobación falla (red, timeout, 5xx, 429, 1027) y no hay
  marca local, la app no bloquea. Un fallo de la infraestructura nunca echa a usuarios normales.
- **Modo estricto para el registro** (configurable por app). Con `intent = signup`, crear una
  cuenta exige que la comprobación termine con `ok`. Si falla, la app muestra "no se pudo
  completar el registro, inténtalo de nuevo" y no crea la cuenta. Esto cierra el truco de
  bloquear el dominio del Worker para registrarse, sin afectar al uso diario de quien ya tiene
  cuenta.

### 6.3 App Attest (opcional por app)

Para una app que ya tenga App Attest con su propio servidor o con este Worker:

- La petición de `check` lleva una aserción (`generateAssertion`) sobre el hash del cuerpo de la
  petición. El Worker la valida antes de hacer nada.
- Así una app modificada no puede consultar ni hacer pasar un veredicto falso.
- La métrica de riesgo (campo 17 del recibo) puede alimentar `bit1` o un aviso cuando un
  dispositivo acumula muchas claves en 30 días, señal de reinstalaciones en serie.
- **Por verificar**: el flujo completo de validación de atestación y aserción en
  developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
  (no se leyó en detalle).

El paso definitivo, si alguna app lo necesita, es que su backend exija en el registro y el
login un veredicto firmado por el Worker (por ejemplo, un token corto firmado con una clave del
Worker), de modo que el bloqueo deje de depender del cliente.

### 6.4 Administración

| Método y ruta | Uso |
|---|---|
| `POST /v1/admin/ban` | `{ app, kind, value }` o `{ app, kind, hash }`, más `note` opcional. Con `value` en bruto, el Worker calcula el hash con el prefijo de la app y solo guarda el hash. |
| `POST /v1/admin/unban` | `{ app, kind, value o hash }` borra el hash. `{ app, ref }` programa el desbaneo del bit para la próxima comprobación de ese dispositivo. |
| `GET /v1/admin/lookup` | Por `hash` o `ref`. |

Todas con `Authorization: Bearer <ADMIN_TOKEN>`. Las tres exigen que la app esté configurada en ese Worker
(`HASH_PREFIX_<APP>`); si no, 400 `app not configured`, también con `hash` o `ref`, para que una
errata en `app` no dé un 200 sin efecto. Desbanear por `ref` basta para un desbaneo
completo: en la siguiente comprobación de ese dispositivo, el Worker pone `bit0` a false y borra
los hashes que trae la petición. Desbanear un hash suelto sirve para retirar un identificador
concreto (por ejemplo, el `icloud` de una pareja que comparte cuenta).

## 7. Worker

### 7.1 Esquema D1

```sql
CREATE TABLE banned_ids (
  app         TEXT NOT NULL,
  hash        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  reason      TEXT NOT NULL CHECK (reason IN ('manual', 'propagated')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (app, hash)
);

CREATE TABLE unban_refs (
  app         TEXT NOT NULL,
  ref         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (app, ref)
);

CREATE TABLE check_log (
  app         TEXT NOT NULL,
  ref         TEXT NOT NULL,
  blocked     INTEGER NOT NULL,
  matched     INTEGER NOT NULL,
  bit0        INTEGER,
  intent      TEXT,
  created_at  INTEGER NOT NULL
);
```

`check_log` solo guarda resultados (sin IPs ni identificadores en bruto) y sirve para el modo
observación. Conviene purgarlo periódicamente con un Cron Trigger.

### 7.2 JWT ES256 con Web Crypto

```ts
const b64url = (input: ArrayBuffer | string): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function appleJWT(p8: string, keyId: string, teamId: string): Promise<string> {
  const pem = p8.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`)
  );
  return `${header}.${claims}.${b64url(sig)}`;
}
```

- Web Crypto devuelve la firma ECDSA como `r || s` (64 bytes), que es el formato que pide JWS
  para ES256: no hay que convertir desde DER.
- Cachear el JWT en memoria del isolate y regenerarlo a los 30 minutos.
- Cada llamada a Apple lleva `transaction_id` (UUID nuevo) y `timestamp` (ms UTC).
- **Por verificar**: si el entorno de TestFlight usa el endpoint de producción de DeviceCheck
  (es lo esperado).

### 7.3 Configuración y secretos

Por app (en secretos o en una tabla de configuración):

| Nombre | Contenido |
|---|---|
| `APPLE_DC_KEY_P8_<APP>` | Contenido del `.p8` con DeviceCheck activado |
| `APPLE_KEY_ID_<APP>` | Key ID |
| `APPLE_TEAM_ID_<APP>` | Team ID |
| `HASH_PREFIX_<APP>` | Prefijo del hash, distinto por app, por ejemplo `myapp-ban-v1` |
| `ENFORCE_<APP>` | `"true"` bloquea; cualquier otro valor es modo observación |

Globales: `ADMIN_TOKEN` (secreto), binding D1 `DB`, binding `RATE_LIMITER` (por ejemplo
`limit: 20`, `period: 60`, clave `CF-Connecting-IP`). Si el binding no está en el plan gratuito,
usar una regla de rate limiting del WAF sobre la ruta.

Una clave de Apple por equipo de desarrollo; si dos apps son del mismo equipo, comparten clave.
Mejor una clave dedicada a DeviceCheck que reutilizar la de push, para poder revocarla sin
efectos colaterales.

### 7.4 Capacidad

- Una firma ECDSA y algo de JSON caben en 10 ms de CPU; la espera de red no cuenta como CPU.
- Como mucho dos subpeticiones a Apple (más la validación de App Attest si aplica) y unas pocas
  consultas a D1 por petición.
- Si se agota la cuota diaria (1027), el cliente lo trata como error: fail-open, salvo el
  registro en modo estricto.

## 8. SDK Swift

### 8.1 API pública propuesta

```swift
public struct NonGrataConfiguration: Sendable {
    public var endpoint: URL
    public var appId: String                 // "myapp"
    public var hashPrefix: String            // igual que HASH_PREFIX_<APP> del Worker
    public var useICloud: Bool               // requiere CloudKit y KVS en el App ID
    public var strictSignup: Bool
    public var foregroundInterval: Duration  // por ejemplo, .seconds(6 * 3600)
    public var timeout: Duration             // por ejemplo, .seconds(5)
    public var keychainService: String
}

public enum NonGrataVerdict: Sendable, Equatable {
    case allowed
    case blocked(ref: String)
    case unknown            // no se pudo comprobar y no hay marca local
}

@MainActor
@Observable
public final class NonGrata {
    public init(configuration: NonGrataConfiguration)
    public private(set) var verdict: NonGrataVerdict      // lee la marca local en el init
    public func check(intent: CheckIntent, userId: String?) async -> NonGrataVerdict
    public var installId: String { get }                     // para analítica y soporte
    public var iCloudIdHash: String? { get }
}
```

El SDK no impone interfaz: cada app pinta su pantalla de suspendido con su propio sistema de
presentación. Opcionalmente, una vista SwiftUI por defecto en un target aparte.

> Implementación (2026-10-29): producto `NonGrataUI` con `NonGrataSuspendedView(ref:)` (hueco
> `supportAction` para el contacto con soporte) y `.nonGrataBlockingOverlay(_:)`, que solo cubre
> con `.blocked`. El código de soporte se puede seleccionar y VoiceOver lo deletrea. Ver
> [INTEGRACION-IOS.md](INTEGRACION-IOS.md).

### 8.2 Identificadores

- **`installId`:** UUID generado una vez, guardado en el Keychain con
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` y un `kSecAttrService` propio del SDK.
  Documentar en el README que la app **no** debe borrarlo en su limpieza de primera ejecución.
- **`idfv`:** `UIDevice.current.identifierForVendor`; si es `nil`, se omite.
- **`icloud`:** `try await CKContainer.default().userRecordID().recordName`, con timeout corto;
  se omite si no hay cuenta.
- **`user`:** lo pasa la app si hay sesión.
- **Hash:** `SHA256(hashPrefix + ":" + kind + ":" + value)` en hex, con CryptoKit. El Worker y la
  CLI usan la misma fórmula. Desde el 2026-11-02 el valor se normaliza antes (pendiente 9).
- **`ref`:** primeros 8 caracteres en mayúsculas del hash de `installId`. Es el código de soporte.

### 8.3 Veredicto persistente

- Marca en el Keychain (sobrevive a reinstalar) y, si `useICloud`, en `NSUbiquitousKeyValueStore`
  (salta a otros dispositivos de la misma cuenta de Apple). Observar
  `didChangeExternallyNotification` para bloquear en caliente.
- `blocked` del Worker: pone las marcas. `ok`: las quita (única salida del bloqueo). Error: no
  toca nada.
- Nunca cerrar la app por código. La pantalla de bloqueo queda fija; cerrar la app a propósito
  puede verse como un fallo en la revisión.

### 8.4 Cuándo comprobar

- Al arrancar.
- Al volver a primer plano, como mucho cada `foregroundInterval`, salvo si está bloqueado (en
  ese caso siempre, para detectar el desbaneo).
- Tras un login correcto, con `userId`.
- Antes de crear la cuenta, con `intent = signup` (modo estricto si está activado).

Sin `isSupported` (simulador), se manda sin `dc_token` y el Worker decide solo con D1.

### 8.5 Capacidades de la app que lo use

- iCloud en el App ID (CloudKit con contenedor y key-value storage) si `useICloud`.
- DeviceCheck no necesita entitlement.
- Etiqueta de privacidad de App Store: "Device ID" y "User ID" con fin de prevención de fraude.
- Política de privacidad: mencionar identificadores de dispositivo con fin antifraude.
- **Verificado** (2026-11-02): el uso exclusivo antifraude no es tracking, así que no hace falta pedir ATT (sección 16, punto 5).

## 9. CLI de administración

Un comando pequeño (Node o Swift) que envuelve los endpoints de admin:

```
nongrata ban    app=myapp kind=idfv value=<valor> note=spam
nongrata unban  app=myapp ref=A1B2C3D4
nongrata lookup app=myapp ref=A1B2C3D4
```

Lee el endpoint y el `ADMIN_TOKEN` de variables de entorno. El hash lo calcula el Worker.

> Implementación (2026-10-26), en `cli/`: TypeScript ejecutado con Node, sin dependencias. Como
> cada app tiene su propio Worker, lee `NONGRATA_URL_<APP>` y `NONGRATA_ADMIN_TOKEN_<APP>`
> con `NONGRATA_URL` y `NONGRATA_ADMIN_TOKEN` como respaldo, y exige https salvo hacia
> localhost. Añade `nongrata hash prefix=… kind=… value=…`, que calcula el hash sin red con la
> misma fórmula del Worker (pasa `spec/hash-vectors.json`). Acepta el `ref` en minúsculas.
> Códigos de salida: 0 bien, 1 error del Worker o de red, 2 uso incorrecto.

## 10. Estructura del repo

Un monorepo:

```
nongrata/
├── Package.swift          Manifiesto del paquete Swift (en la raíz para que SPM lo resuelva por URL)
├── swift/                 Código del paquete (NonGrata + NonGrataUI opcional) y tests
├── worker/                Núcleo del Worker en TypeScript y tests con Vitest
├── deployments/
│   ├── example/           plantilla de wrangler.jsonc para una app
│   └── <tu-app>/          tu despliegue real (git lo ignora: lleva IDs de tu cuenta)
├── cli/
├── docs/                  Documentación en inglés; este documento, en español en docs/es/
└── .gitignore             incluye .dev.vars*
```

Alternativa: un despliegue único con el campo `app` y listas separadas por app en la misma base.
Más sencillo de operar; el aislamiento lo da la clave primaria `(app, hash)`.

Consumo desde las apps: el paquete Swift por SPM con la URL del repo, fijado a una etiqueta de
versión. Si usas un fork privado y la app compila en Xcode Cloud, hay que darle acceso a ese repo
desde App Store Connect, o el build fallará al resolver dependencias.

## 11. Privacidad

- El Worker solo guarda hashes con prefijo por app; nunca identificadores en bruto ni IPs.
- No hay fingerprinting (no se combinan señales del dispositivo para inventar un identificador):
  solo `idfv`, un UUID propio, el ID de iCloud y DeviceCheck, que Apple ofrece para esto.
- Revisar que los logs del Worker (Workers Logs) no registran los cuerpos de las peticiones.

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Comprador de segunda mano de un iPhone baneado | Desbaneo por `ref` desde soporte |
| Pareja que comparte cuenta de Apple | Desbaneo por `ref` y retirada del hash `icloud` |
| Worker caído | Fail-open; solo siguen bloqueados quienes ya lo estaban |
| Error al banear | Modo observación antes de activar `ENFORCE`; desbaneo por `ref` |
| Bloqueo del dominio del Worker para registrarse | Modo estricto en el registro |
| App modificada | App Attest y, si hace falta, veredicto exigido por el backend |
| Apple cambia la persistencia del Keychain | `bit0` e iCloud cubren el hueco |
| Abuso del endpoint público | Rate limit; sin `dc_token` válido no se tocan bits; desbanear exige `ADMIN_TOKEN` |

## 13. Pruebas

SDK (Swift Testing):

- Hash estable; tipos distintos dan hashes distintos.
- `installId` estable entre llamadas.
- Marca puesta implica `blocked` sin red; `ok` la quita; un error no la toca; sin marca y con
  error, `unknown` y la app no bloquea.
- Modo estricto: `signup` con error no permite crear la cuenta.

Worker (Vitest con el pool de Workers):

- Hash baneado con `bit0` falso: escribe el bit y responde `blocked`.
- `bit0` verdadero sin hash conocido: inserta los hashes como `propagated`.
- `ref` desbaneado: `bit0` a false, `ref` consumido, `ok`.
- Modo observación: siempre `ok`, registra `blocked` en `check_log` y no escribe `bit0` ni
  propaga.
- Apple caída: decide con D1.
- Admin sin token: 401.
- Aislamiento por `app`.

Mutation testing (2026-10-26): Stryker sobre el Worker y la CLI, dentro de `make check` y
semanal en CI, comparado con un baseline por paquete (`<paquete>/mutation-baseline.json`).
Worker 99,5 % (3 supervivientes equivalentes), CLI 100 % (desde el 2026-11-02; antes 78 %). El SDK Swift no tiene mutation testing automático: Muter no funciona sin parches (2026-11-05); una pasada a mano con sus 17 mutantes los mata todos tras un test nuevo.

De extremo a extremo, con un iPhone físico y build de desarrollo:

1. Banear el `idfv` ⇒ pantalla de bloqueo.
2. Quitar el hash y reabrir ⇒ sigue bloqueado por `bit0`.
3. Reinstalar ⇒ bloqueado al arrancar.
4. Desbanear el `ref` ⇒ se levanta en la siguiente comprobación.
5. Otro dispositivo con la misma cuenta de Apple ⇒ se bloquea por la marca de iCloud.
6. Sin red con marca ⇒ bloqueado. Sin red y sin marca ⇒ entra (salvo registro estricto).

## 14. Despliegue de cada app

1. Crear la clave de DeviceCheck y cargar los secretos de la app.
2. Desplegar con `ENFORCE` apagado.
3. Publicar la versión de la app con el SDK.
4. Cargar los identificadores conocidos y revisar `check_log`.
5. Activar `ENFORCE`.

Los pasos 4 y 5 no requieren nueva versión de la app.

## 15. Android

Fuera de la primera versión. Equivalente propuesto, **por verificar** con la documentación de
Android: `ANDROID_ID` como identificador de instalación (tipo `android_id`), el mismo Worker y la
misma lista. Play Integrity no ofrece bits por dispositivo; sus veredictos se podrían validar en
el Worker más adelante.

## 16. Pendientes de verificar

1. ~~Importación `pkcs8` de una clave P-256 en Workers.~~ **Verificado** el 2026-10-15 con un test en `workerd` (`worker/test/jwt.test.ts`).
2. Endpoint de DeviceCheck que corresponde a TestFlight. **La documentación no lo dice**
   (consultado el 2026-11-02): solo que `api.development` es "only for testing during
   development". Para App Attest, Apple sí dice que TestFlight usa producción
   (`com.apple.developer.devicecheck.appattest-environment`). El SDK manda `development` solo en
   builds `DEBUG` (`Configuration.swift`), así que TestFlight va a producción. Se confirma en las
   pruebas de extremo a extremo con una build de TestFlight.
3. Disponibilidad del binding de rate limiting en el plan gratuito. **La documentación no lo
   dice** (consultado el 2026-11-02): ni la página del binding ni las de precios y límites hablan
   de planes. El 2026-11-02 Cloudflare aceptó el binding al desplegar un Worker de prueba en una
   cuenta del plan gratuito.
4. Estabilidad de `userRecordID` entre dispositivos y reinstalaciones. **La documentación no lo
   dice** (consultado el 2026-11-02). Lo más cercano, en `CKContainer`: "When a user accesses a
   container for the first time, CloudKit assigns them a unique identifier". De ahí se deduce que
   es por contenedor (no oficial: cambia con otro bundle ID o contenedor). Se confirma en el paso
   5 de las pruebas de extremo a extremo.
5. ~~Exención de ATT para uso antifraude.~~ **Verificado** el 2026-11-02: no es tracking. La
   definición exige enlazar con datos de otras empresas para publicidad o compartir con data
   brokers (developer.apple.com/app-store/user-privacy-and-data-use/). Etiqueta de privacidad
   (developer.apple.com/app-store/app-privacy-details/): "Device ID" y, con `icloud` o `user`,
   "User ID"; propósito "App Functionality" (incluye "prevent fraud"); casi seguro "linked to
   the user". Hay que declararlo aunque solo sea funcional.
6. Flujo de validación de App Attest (atestación y aserción) si se usa en `check`.
7. `ANDROID_ID` y su comportamiento al reinstalar, para la versión Android.
8. ~~Si Apple acepta el mismo token de DeviceCheck para `query_two_bits` y `update_two_bits`.~~
   **Verificado** el 2026-11-02: no se debe. `generateToken`: "you should not use a token
   multiple times. Instead, use this method to generate a new token"; solo vale para reintentar
   la misma petición. Confirma `dc_token_update`. Si el SDK solo consigue un token
   (`deviceTokens()`), el Worker consulta con él pero no escribe; antes lo reutilizaba.
9. ~~Normalización de los valores en bruto antes del hash.~~ **Decidido** el 2026-11-02: antes
   del hash se quitan espacio, `\t`, `\n` y `\r` de los extremos, y en `idfv` e `install` (UUID)
   se pasan a mayúsculas las letras a-z. `icloud`, `user` y `android_id` son opacos y no se
   tocan. Así un `idfv` copiado en minúsculas da el mismo hash que el que manda el SDK. Igual en
   el SDK, el Worker y la CLI; los vectores nuevos de `spec/hash-vectors.json` lo fijan. No
   cambia ningún hash de un valor que ya estuviera normalizado.
