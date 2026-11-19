# API de administración de NonGrata

*English: [ADMIN-API.md](../ADMIN-API.md)*

Cada Worker de NonGrata tiene una API HTTP de administración bajo `/v1/admin/`. La CLI
`nongrata` es un cliente de ella; un panel web, un bot de soporte o el backend de tu app pueden
ser otros. Esta guía explica cómo funciona; el contrato exacto, con esquemas y ejemplos, es la
especificación OpenAPI 3.1 de [admin-api.yaml](../admin-api.yaml) (en inglés). El diseño está en
la [sección 6.4](DISENO.md#64-administración) del documento de diseño.

## 1. Lo básico

- **Un Worker por app.** Cada despliegue tiene su URL, su base de datos D1 y su `ADMIN_TOKEN`.
  Aun así, cada petición dice de qué `app` se trata, y la app tiene que estar configurada en ese
  Worker (`HASH_PREFIX_<APP>`): una errata en `app` da `400 app not configured` en vez de un
  `200` que no hace nada.
- **Autenticación.** `Authorization: Bearer <ADMIN_TOKEN>` en todas las peticiones, o la firma
  de un dispositivo de administración emparejado (sección 6). Sin ninguno de los dos, o con un
  token incorrecto, cualquier ruta `/v1/admin/*` responde `401 {"error":"unauthorized"}`, también
  una que no existe; solo después una ruta o un método desconocidos dan
  `404 {"error":"not_found"}`. Un Worker sin `ADMIN_TOKEN` rechaza cualquier token. Una ruta que
  quien llama no puede usar da `403 {"error":"forbidden"}`.
- **Solo hashes.** El Worker nunca guarda identificadores en bruto ni IPs. Puedes mandar un
  `value` en bruto a `ban`, `unban` y `lookup`: el Worker lo convierte en hash con el prefijo de
  la app (`SHA-256(prefijo:kind:valor)`, ver [hash y ref](conceptos/hash-y-ref.md)) y solo
  guarda el hash. Los listados devuelven hashes y `ref`, nunca valores.
- **JSON de ida y vuelta.** Los `POST` llevan el cuerpo en JSON; los `GET`, parámetros en la
  query string. Todas las respuestas son JSON con `cache-control: no-store`. Las marcas de
  tiempo van en milisegundos Unix.
- **Errores.** `400` con `{"error": "<motivo>"}`. Los motivos son textos cortos en inglés
  pensados para mostrarse tal cual: `invalid app`, `app not configured`, `invalid kind`,
  `invalid hash`, `invalid value`, `value is a hash`, `invalid ref`, `missing value or hash`,
  `missing value, hash or ref`, `missing ref, value or hash`, `invalid reason`,
  `invalid blocked`, `invalid since`, `invalid limit`, `invalid cursor`; para los
  dispositivos, `invalid role`, `invalid label`, `https required`, `invalid name`,
  `invalid platform`, `invalid pairing` y `ambiguous credentials`. `app` se comprueba siempre lo
  primero. Los parámetros desconocidos se ignoran. `value is a hash` significa un `value` de 64
  caracteres hexadecimales en `idfv`, `install` o `icloud`: es un hash en el campo equivocado, y
  volver a hashearlo daría un baneo que no coincide con nada, así que mándalo como `hash`. Un
  valor de `user` sí puede tener esa forma y se acepta. Las rutas de dispositivos responden además
  `404` (`pairing not found`, `not_found` para un dispositivo desconocido), `409`
  (`pairing not claimed`, `pairing already approved`, `pairing expired`) y `429`
  (`rate_limited`, en las reclamaciones).

## 2. Endpoints

| Método y ruta | Qué hace |
|---|---|
| `POST /v1/admin/ban` | Banea `{ app, kind, value o hash, note? }` como `manual`. Devuelve `{ app, kind, hash }`, con `unban_cancelled: true` si era un `install` cuyo dispositivo tenía un desbaneo pendiente: gana la última decisión. |
| `POST /v1/admin/unban` | `{ app, kind, value o hash }` borra ese hash (`removed` dice si estaba); `{ app, ref }` borra en el momento los baneos automáticos que propagó ese dispositivo y programa su desbaneo completo en su próxima comprobación (`unban_scheduled: true`). Se pueden mandar los dos a la vez. |
| `GET /v1/admin/lookup` | `?app&ref`: el desbaneo pendiente o consumido del dispositivo y sus últimas 20 comprobaciones. `?app&kind&(value o hash)`: la fila del baneo, o `null`. Con el vínculo de usuarios activado, también [los dispositivos de un usuario y los usuarios de un dispositivo](#los-dispositivos-de-un-usuario-y-los-usuarios-de-un-dispositivo). |
| `GET /v1/admin/bans` | La lista de hashes baneados, de más reciente a más antiguo. Filtros: `kind`, `reason` (`manual` o `propagated`). |
| `GET /v1/admin/checks` | Las comprobaciones recientes (`check_log`), de más reciente a más antigua. Filtros: `ref`, `blocked` (`0` o `1`), `since` (ms Unix, inclusive). |
| `GET /v1/admin/log` | Las acciones de administración, de más reciente a más antigua. Con `app`: cada `ban` y `unban` con éxito de esa app. Sin `app`: los eventos de dispositivos del Worker, `pair` y `revoke`. |
| `GET /v1/admin/apps` | Las apps configuradas en este Worker, con `enforce`, si DeviceCheck está configurado y `link_users`. |
| `GET /v1/admin/me` | El dispositivo que llama (solo dispositivos). |
| `GET /v1/admin/devices` | Los dispositivos emparejados, de más reciente a más antiguo. |
| `POST /v1/admin/devices/{id}/revoke` | Revoca un dispositivo, para siempre. Idempotente. |
| `POST /v1/admin/pairings`, `GET` y `DELETE /v1/admin/pairings/{id}`, `POST /v1/admin/pairings/{id}/approve` | Emparejar un dispositivo de administración nuevo (solo `ADMIN_TOKEN`). |
| `POST /v1/pair/claim` | Fuera de `/v1/admin/`: el dispositivo reclama un emparejamiento, sin otra credencial. |

`kind` es uno de `idfv`, `install`, `icloud`, `user`, `android_id`. Un `ref` es el código de
soporte de 8 caracteres en mayúsculas que la app enseña en su pantalla de bloqueo. Las rutas de
dispositivos, apps y emparejamientos no llevan `app`: afectan a todo el Worker. Las describen la
sección 6 y [Dispositivos de administración](EMPAREJAMIENTO.md).

### Banear y desbanear

```sh
curl -sS https://nongrata-myapp.<tu-subdominio>.workers.dev/v1/admin/ban \
  -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP" -H "content-type: application/json" \
  -d '{"app":"myapp","kind":"idfv","value":"E621E1F8-C36C-495A-93FC-0C247A3E6E5F","note":"spam"}'
# {"app":"myapp","kind":"idfv","hash":"9d2c…"}
```

Banear un hash que ya estaba como `propagated` lo convierte en `manual`, con la nota nueva (como
mucho 500 caracteres) y la hora nueva. Desbanear por `ref` es el desbaneo completo: en la
siguiente comprobación de ese dispositivo, el Worker pone `bit0` a false y borra los hashes que
trae la comprobación. Desbanear un hash suelto sirve para retirar un identificador, por ejemplo
el `icloud` de una pareja que comparte cuenta de Apple. Los detalles están en
[propagación](conceptos/propagacion.md) y en [el flujo de una comprobación](conceptos/flujo-de-check.md).

### Listados

```sh
curl -sS "https://nongrata-myapp.<tu-subdominio>.workers.dev/v1/admin/checks?app=myapp&blocked=1&limit=2" \
  -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP"
```

```json
{
  "app": "myapp",
  "items": [
    { "ref": "7F3A9C21", "blocked": 1, "matched": 0, "bit0": 1, "intent": "launch", "created_at": 1762786800000 },
    { "ref": "0B4E6D12", "blocked": 1, "matched": 1, "bit0": null, "intent": "signup", "created_at": 1762786200000 }
  ],
  "next_cursor": "MTc2Mjc4NjIwMDAwMC40Mg"
}
```

Los elementos de cada listado:

| Listado | Elemento |
|---|---|
| `bans` | `{ hash, kind, reason, note, created_at, ref }`: `ref` es el código de soporte del dispositivo al que pertenece el baneo, así que los baneos con el mismo `ref` son un solo dispositivo. Es el principio del hash en un `install`, y el dispositivo que lo trajo en un baneo automático. `null` cuando el Worker no puede saberlo: un baneo manual de otro tipo (puede coincidir con varios dispositivos) o uno automático anterior a la migración `0004` |
| `checks` | `{ ref, blocked, matched, bit0, intent, created_at }`: `blocked`, `matched` y `bit0` valen `0` o `1`, como en `lookup` (`bit0` es `null` si no se preguntó a Apple o no respondió); `intent`, tal como lo mandó el SDK |
| `log` | `{ action, kind, hash, ref, note, device_id, actor, created_at }`: `action` es `ban`, `unban`, `pair` o `revoke`; `device_id` es el dispositivo de `pair` y `revoke`; `actor` es `token` o `device:<device_id>` (`null` antes de la migración `0003`); los campos que no aplican van a `null` |

En modo observación (`ENFORCE_<APP>` apagado), el `blocked` de una comprobación es lo que se
habría bloqueado; por eso `checks?blocked=1` sirve antes de encender el bloqueo.

### ¿Ha llegado el baneo al dispositivo?

Un baneo se aplica en la siguiente comprobación del dispositivo, que puede tardar horas (ver
[Cuánto tarda en llegar un baneo](INTEGRACION-IOS.md#cuánto-tarda-en-llegar-un-baneo)). Un
cliente puede distinguir los dos estados solo con los listados:

- **Aplicado**: hay una comprobación de ese `ref` con `blocked = 1` y `created_at` igual o
  posterior al del baneo. Pide una vez `checks?blocked=1&since=<el baneo más antiguo sin
  resolver>` y agrupa por `ref`, en vez de una petición por baneo; el listado va de más reciente
  a más antiguo, así que la fila más antigua de cada `ref` es cuándo se aplicó. Un baneo
  automático (`propagated`) lo escribe una comprobación bloqueada: un dispositivo que tiene uno
  está aplicado por definición, y su `created_at` es la hora.
- **Pendiente**: el baneo tiene `ref` y todavía no hay una comprobación así.
- **No se puede saber**: un baneo manual con `ref` `null` no es de ningún dispositivo hasta que
  uno comprueba, y esa fila sigue con `null` después (cada dispositivo que bloquea aparece
  entonces con sus propios baneos automáticos). Y `check_log` se guarda 30 días: un baneo más
  antiguo, sin fila automática y sin comprobaciones bloqueadas en esa ventana, no es ni lo uno
  ni lo otro.

En modo observación no se propaga nada y la app recibió `ok`, así que una comprobación que
coincide significa "se habría bloqueado", no "aplicado".

### Los dispositivos de un usuario y los usuarios de un dispositivo

Solo para una app con `LINK_USERS_<APP>` en `"true"` (diseño, sección 6.5; lo dice `link_users`
en `GET /v1/admin/apps`). El Worker recuerda entonces qué usuarios han pasado por cada
dispositivo, y un baneo por `user` los alcanza a todos en su siguiente comprobación.

`GET /v1/admin/lookup?app&kind=user&(value o hash)` añade los dispositivos donde se vio a ese
usuario:

```json
{
  "app": "myapp",
  "hash": "9f2c…",
  "banned": null,
  "devices": [
    { "ref": "A1B2C3D4", "install_hash": "a1b2c3d4…", "first_seen": 1794000000000, "last_seen": 1794943390138, "blocked": 0 }
  ],
  "devices_more": false
}
```

`GET /v1/admin/lookup?app&ref` añade los usuarios vistos en ese dispositivo:

```json
{
  "app": "myapp",
  "ref": "A1B2C3D4",
  "unban": null,
  "checks": [],
  "users": [
    { "hash": "9f2c…", "first_seen": 1794000000000, "last_seen": 1794943390138, "banned": 0 }
  ],
  "users_more": false
}
```

- **El visto más recientemente primero, como mucho 100.** `devices_more` o `users_more` vale
  `true` cuando hay más; los que quedan fuera son los vistos hace más tiempo.
- **`blocked`** es la última comprobación de ese dispositivo en `check_log`: `1`, `0`, o `null`
  cuando no tiene ninguna en los últimos 30 días. En modo observación `1` significa «se habría
  bloqueado».
- **`banned`** vale `1` cuando ese hash de usuario está en la lista de baneos de la app.
- **Campo ausente = no soportado.** Una app sin `LINK_USERS_<APP>`, un Worker anterior o un
  lookup de otro tipo no tienen campo `devices` ni `users`. Una lista vacía significa
  «soportado, ninguno visto».
- **Cuánto dura un vínculo:** hasta 180 días después de la última vez que se vio a ese usuario
  en ese dispositivo; los vínculos de un usuario baneado se conservan. `last_seen` se renueva
  como mucho una vez al día.
- **Solo hashes.** `users` no puede decir quién es un usuario; permite a un cliente banear la
  cuenta que hay detrás de un dispositivo (`POST /v1/admin/ban` con `kind: "user"` y ese
  `hash`). `install_hash` hace lo mismo para un dispositivo (`kind: "install"`).
- **Los valores de `user` distinguen mayúsculas.** `value` tiene que ser el ID exactamente como
  la app lo pasa al SDK.

Desbanear un dispositivo por `ref` quita también sus vínculos con los usuarios baneados; ellos
siguen baneados.

## 3. Paginación

Los tres listados funcionan igual:

- De más reciente a más antiguo, por `created_at` y después por una clave interna (el hash o el
  id de la fila), así que el orden es total aunque varias filas compartan milisegundo.
- `limit` de 1 a 100; 50 por defecto.
- Cada página trae `next_cursor`. Para la siguiente, repite la misma petición con
  `cursor=<next_cursor>`. En la última página, `next_cursor` es `null`.
- El cursor es opaco: no lo construyas ni lo interpretes, y úsalo solo con el listado y los
  filtros que lo produjeron. Es una posición (keyset), no un desplazamiento, así que las filas
  que se añaden mientras paginas no mueven lo que viene después: las nuevas van al principio,
  que ya has pasado (igual que un baneo que se vuelve a banear, porque toma la hora nueva).

```sh
cursor=""
while :; do
  page=$(curl -sS "$URL/v1/admin/bans?app=myapp&limit=100${cursor:+&cursor=$cursor}" \
    -H "authorization: Bearer $NONGRATA_ADMIN_TOKEN_MYAPP")
  echo "$page" | jq -c '.items[]'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
```

## 4. Qué se guarda y cuánto tiempo

| Datos | Se guardan | Por qué |
|---|---|---|
| Baneos (`banned_ids`) | Hasta que se desbanean | Es la lista. Un desbaneo borra la fila. |
| Comprobaciones (`check_log`) | 30 días | El cron diario borra las filas más antiguas. `checks` no ve más atrás. |
| Registro de administración (`admin_log`) | Siempre | No se purga, ver abajo. |
| Emparejamientos (`admin_pairings`) | Hasta que caducan (10 minutos) | El cron diario los borra, aprobados o no. |
| Dispositivos (`admin_devices`) | Siempre una vez aprobados; los revocados se quedan | Para que el registro pueda seguir nombrándolos. Uno pendiente se va con su emparejamiento. |
| Nonces (`admin_nonces`) | 10 minutos | Solo para rechazar repeticiones. |

El registro de administración no se purga porque los baneos no caducan: un hash baneado hace dos
años sigue bloqueando, y la constancia de quién lo baneó, cuándo y con qué nota tiene que durar
más que él. Crece una fila por acción humana (un `ban`, un `unban`, un `pair` o un `revoke`), así que es diminuto al lado
de `check_log`, que crece con cada arranque de la app; purgarlo no ahorraría nada y añadiría una
segunda sentencia al cron. Guarda lo que ya guardan los endpoints: el hash (nunca el `value` en
bruto), el `ref` y la nota. Registra que se programó un desbaneo por `ref`; si el dispositivo ya
lo consumió se ve en `lookup` por `ref`. Si algún día hace falta recortarlo, basta un
`DELETE FROM admin_log WHERE created_at < …` puntual con Wrangler.

**Actualizar un despliegue de la 0.2.0.** Los listados y el registro necesitan la migración
`0002_admin_log.sql`. Aplica las migraciones (`wrangler d1 migrations apply DB --remote`, como en
el README) antes de desplegar el Worker nuevo: hasta entonces, `ban` y `unban` fallan con un
`500`, porque la fila del registro se escribe en la misma transacción, mientras que
`/v1/device/check` sigue funcionando. Comprueba que se aplicó de verdad con
`wrangler d1 migrations list DB --remote` (nada pendiente): desde un script u otra terminal no
interactiva, Wrangler puede saltarse su pregunta de confirmación sin aplicar nada; antepón `CI=1`
para que responda que sí.

**Actualizar a dispositivos de administración.** El emparejamiento, las peticiones firmadas y el
`actor` del registro necesitan la migración `0003_admin_devices.sql`, que además reconstruye
`admin_log` (conservando sus filas). Aplícala igual antes de desplegar, con `CI=1` desde una
terminal no interactiva, y compruébala con `wrangler d1 migrations list DB --remote`: hasta que
se aplique, `ban`, `unban` y `log` fallan con un `500` mientras `/v1/device/check` sigue
funcionando.

## 5. Desde la CLI

```sh
pnpm ng bans   app=myapp reason=manual limit=20
pnpm ng checks app=myapp ref=7f3a9c21          # el ref puede ir en minúsculas
pnpm ng checks app=myapp blocked=1 since=1762704000000
pnpm ng log    app=myapp
pnpm ng bans   app=myapp cursor=<next_cursor>  # la página siguiente
pnpm ng lookup app=myapp kind=user value=<id de usuario>   # con el vínculo: los dispositivos de ese usuario
pnpm ng ban    app=myapp kind=user value=<id de usuario>   # los alcanza a todos en su siguiente comprobación
```

La CLI imprime el JSON del Worker tal cual, una página por llamada. Lee `NONGRATA_URL_<APP>` y
`NONGRATA_ADMIN_TOKEN_<APP>`; ver la [sección 9](DISENO.md#9-cli-de-administración) del diseño.

```sh
pnpm ng pair    app=myapp role=read label="Ana's iPhone"   # QR, esperar, comparar el código, aprobar
pnpm ng devices app=myapp                                  # los dispositivos emparejados
pnpm ng devices revoke app=myapp id=<device_id>
```

Los dispositivos son del Worker, así que aquí `app=` solo elige qué Worker (su URL y su token).

## 6. Dispositivos de administración

Un teléfono, una tableta o un Mac (por ejemplo la app NonGrata Dashboard) no necesita el token:
se empareja una vez y después firma cada petición con una clave que nunca sale de su Secure
Enclave. El protocolo, la tabla de roles y el modelo de amenazas están en
[Dispositivos de administración](EMPAREJAMIENTO.md). En resumen:

- `pnpm ng pair` crea un emparejamiento de un solo uso (10 minutos) y lo muestra como código QR.
  El dispositivo lo reclama con `POST /v1/pair/claim`, los dos lados muestran un código de
  verificación de 6 cifras, y el admin lo aprueba en la terminal solo si coinciden.
- Un dispositivo tiene el rol `read` (todo lo que solo lee, más `apps` y `me`) o `admin`
  (además `ban`, `unban`, `devices` y `revoke`). Solo el token puede crear, aprobar o cancelar
  emparejamientos.
- Una petición firmada lleva `NonGrata-Device`, `NonGrata-Timestamp`, `NonGrata-Nonce` y
  `NonGrata-Signature` en vez de `Authorization`; con las dos cosas, `400 ambiguous
  credentials`. Un reloj desfasado más de 5 minutos da `401` con `"reason": "clock"` y el
  `server_time` del Worker.
- Revoca un dispositivo perdido con `pnpm ng devices revoke`; el `actor` del registro dice quién
  hizo cada acción.

## 7. Hacer un cliente

- Guarda `ADMIN_TOKEN` en un servidor. Puede banear y desbanear a cualquiera en esa app, así que
  no va en un navegador, en una app móvil ni en el lado cliente de un bot. Un panel web llama a
  su propio backend, y este al Worker. Una app móvil se empareja como dispositivo de
  administración (sección 6).
- Trata cualquier respuesta que no sea `200` como un error y muestra el texto de `error`. Puede
  llegar un `5xx` sin JSON (D1 caída); reintenta los `GET`, y antes de reintentar un `POST`
  compruébalo con `lookup` o `log`.
- `ban` y `unban` son idempotentes en su efecto (banear dos veces deja una fila; programar dos
  veces un `ref` deja un desbaneo pendiente), pero cada llamada con éxito añade una fila al
  registro.

## 8. Próximos pasos (sin hacer)

- **Panel web.** Una interfaz de administración pequeña sobre esta API (baneos, comprobaciones
  de un `ref`, el registro).
- **CORS.** El Worker no manda cabeceras CORS, así que un navegador no puede llamarlo
  directamente; es a propósito mientras haya un solo token con todos los permisos.
- **Tokens por operador.** Hay un `ADMIN_TOKEN` por Worker; los dispositivos emparejados ya dan
  a cada operador su propia identidad en el registro (`actor`) y un rol de solo lectura. Tokens
  con nombre (o Cloudflare Access delante de `/v1/admin/`) harían lo mismo para servidores y
  scripts.
