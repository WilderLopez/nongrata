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
- **Autenticación.** `Authorization: Bearer <ADMIN_TOKEN>` en todas las peticiones. Sin él, o
  con un token incorrecto, cualquier ruta `/v1/admin/*` responde
  `401 {"error":"unauthorized"}`, también una que no existe; solo después una ruta o un método
  desconocidos dan `404 {"error":"not_found"}`. Un Worker sin `ADMIN_TOKEN` lo rechaza todo.
- **Solo hashes.** El Worker nunca guarda identificadores en bruto ni IPs. Puedes mandar un
  `value` en bruto a `ban`, `unban` y `lookup`: el Worker lo convierte en hash con el prefijo de
  la app (`SHA-256(prefijo:kind:valor)`, ver [hash y ref](conceptos/hash-y-ref.md)) y solo
  guarda el hash. Los listados devuelven hashes y `ref`, nunca valores.
- **JSON de ida y vuelta.** Los `POST` llevan el cuerpo en JSON; los `GET`, parámetros en la
  query string. Todas las respuestas son JSON con `cache-control: no-store`. Las marcas de
  tiempo van en milisegundos Unix.
- **Errores.** `400` con `{"error": "<motivo>"}`. Los motivos son textos cortos en inglés
  pensados para mostrarse tal cual: `invalid app`, `app not configured`, `invalid kind`,
  `invalid hash`, `invalid value`, `invalid ref`, `missing value or hash`,
  `missing value, hash or ref`, `missing ref, value or hash`, `invalid reason`,
  `invalid blocked`, `invalid since`, `invalid limit`, `invalid cursor`. `app` se comprueba
  siempre lo primero. Los parámetros desconocidos se ignoran.

## 2. Endpoints

| Método y ruta | Qué hace |
|---|---|
| `POST /v1/admin/ban` | Banea `{ app, kind, value o hash, note? }` como `manual`. Devuelve `{ app, kind, hash }`. |
| `POST /v1/admin/unban` | `{ app, kind, value o hash }` borra ese hash (`removed` dice si estaba); `{ app, ref }` programa el desbaneo completo de ese dispositivo en su próxima comprobación (`unban_scheduled: true`). Se pueden mandar los dos a la vez. |
| `GET /v1/admin/lookup` | `?app&ref`: el desbaneo pendiente o consumido del dispositivo y sus últimas 20 comprobaciones. `?app&kind&(value o hash)`: la fila del baneo, o `null`. |
| `GET /v1/admin/bans` | La lista de hashes baneados, de más reciente a más antiguo. Filtros: `kind`, `reason` (`manual` o `propagated`). |
| `GET /v1/admin/checks` | Las comprobaciones recientes (`check_log`), de más reciente a más antigua. Filtros: `ref`, `blocked` (`0` o `1`), `since` (ms Unix, inclusive). |
| `GET /v1/admin/log` | Las acciones de administración: cada `ban` y `unban` con éxito, de más reciente a más antigua. |

`kind` es uno de `idfv`, `install`, `icloud`, `user`, `android_id`. Un `ref` es el código de
soporte de 8 caracteres en mayúsculas que la app enseña en su pantalla de bloqueo.

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
| `bans` | `{ hash, kind, reason, note, created_at }` |
| `checks` | `{ ref, blocked, matched, bit0, intent, created_at }`: `blocked`, `matched` y `bit0` valen `0` o `1`, como en `lookup` (`bit0` es `null` si no se preguntó a Apple o no respondió); `intent`, tal como lo mandó el SDK |
| `log` | `{ action, kind, hash, ref, note, created_at }`: `action` es `ban` o `unban`; los campos que no aplican van a `null` |

En modo observación (`ENFORCE_<APP>` apagado), el `blocked` de una comprobación es lo que se
habría bloqueado; por eso `checks?blocked=1` sirve antes de encender el bloqueo.

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

El registro de administración no se purga porque los baneos no caducan: un hash baneado hace dos
años sigue bloqueando, y la constancia de quién lo baneó, cuándo y con qué nota tiene que durar
más que él. Crece una fila por acción humana (un `ban` o un `unban`), así que es diminuto al lado
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

## 5. Desde la CLI

```sh
pnpm ng bans   app=myapp reason=manual limit=20
pnpm ng checks app=myapp ref=7f3a9c21          # el ref puede ir en minúsculas
pnpm ng checks app=myapp blocked=1 since=1762704000000
pnpm ng log    app=myapp
pnpm ng bans   app=myapp cursor=<next_cursor>  # la página siguiente
```

La CLI imprime el JSON del Worker tal cual, una página por llamada. Lee `NONGRATA_URL_<APP>` y
`NONGRATA_ADMIN_TOKEN_<APP>`; ver la [sección 9](DISENO.md#9-cli-de-administración) del diseño.

## 6. Hacer un cliente

- Guarda `ADMIN_TOKEN` en un servidor. Puede banear y desbanear a cualquiera en esa app, así que
  no va en un navegador, en una app móvil ni en el lado cliente de un bot. Un panel web llama a
  su propio backend, y este al Worker.
- Trata cualquier respuesta que no sea `200` como un error y muestra el texto de `error`. Puede
  llegar un `5xx` sin JSON (D1 caída); reintenta los `GET`, y antes de reintentar un `POST`
  compruébalo con `lookup` o `log`.
- `ban` y `unban` son idempotentes en su efecto (banear dos veces deja una fila; programar dos
  veces un `ref` deja un desbaneo pendiente), pero cada llamada con éxito añade una fila al
  registro.

## 7. Próximos pasos (sin hacer)

- **Panel web.** Una interfaz de administración pequeña sobre esta API (baneos, comprobaciones
  de un `ref`, el registro).
- **CORS.** El Worker no manda cabeceras CORS, así que un navegador no puede llamarlo
  directamente; es a propósito mientras haya un solo token con todos los permisos.
- **Tokens por operador.** Hoy hay un `ADMIN_TOKEN` por Worker y el registro no puede decir
  quién actuó. Tokens con nombre (o Cloudflare Access delante de `/v1/admin/`) permitirían
  registrar al operador y dar acceso de solo lectura.
