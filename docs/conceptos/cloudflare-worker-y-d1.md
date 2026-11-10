---
tags: [concepto]
aliases: [Worker, D1, wrangler, Cloudflare]
---

# Cloudflare Worker y D1

El servidor de nongrata no es una máquina que haya que mantener: es un **Worker** de
Cloudflare con una base de datos **D1**. Esta nota explica esas piezas para quien viene de iOS.

## Worker

Un Worker es una función que Cloudflare ejecuta en sus servidores cada vez que llega una
petición HTTP. Tú subes el código; Cloudflare pone las máquinas, la red y el HTTPS.

El nuestro está en TypeScript y tiene dos puntos de entrada (`worker/src/index.ts`):

- `fetch`: atiende las peticiones HTTP.
  - `POST /v1/device/check`: la comprobación que manda la app. Ver
    [Flujo de una comprobación](flujo-de-check.md).
  - `/v1/admin/*`: banear, desbanear y consultar. Lo usa la CLI con `ADMIN_TOKEN`.
- `scheduled`: la llama el Cron Trigger (ver abajo).

Plan gratuito: 100.000 peticiones al día y 10 ms de CPU por petición. La espera a Apple no
cuenta como CPU. Si se agota la cuota diaria (error 1027), la app lo trata como un fallo:
fail-open (ver [Fail-open y modo observación](fail-open-y-observacion.md)).

## D1

Una base de datos SQLite gestionada por Cloudflare. El Worker la ve como `env.DB`.

| Tabla | Qué guarda |
|---|---|
| `banned_ids` | Los hashes baneados, con `reason` = `manual` o `propagated`. Clave `(app, hash)`. |
| `unban_refs` | Los desbaneos por `ref`: pendientes o ya consumidos. |
| `check_log` | El resultado de cada comprobación. Nunca identificadores ni IPs. |

- Se eligió D1 y no KV porque lo que se escribe se lee al momento. En KV un cambio puede
  tardar 60 s o más en verse, y hay pocas escrituras gratis.
- Plan gratuito: 5 millones de filas leídas y 100.000 escritas al día; 500 MB por base.
- Las tablas se crean con **migraciones**: ficheros SQL en `worker/migrations/` que wrangler
  aplica en orden.
- Las marcas de tiempo van en milisegundos Unix.

## wrangler

La herramienta de línea de comandos de Cloudflare. Lee la configuración de un fichero
`wrangler.jsonc` (nombre del Worker, fichero de entrada, base D1, variables, cron) y hace:

| Para… | Comando |
|---|---|
| Probar en local | `pnpm --dir worker dev` (necesita `worker/.dev.vars`) |
| Crear las tablas en local | `pnpm --dir worker db:migrate:local` |
| Desplegar una app | `pnpm --dir worker exec wrangler deploy --config ../deployments/<tu-app>/wrangler.jsonc` |
| Validar sin desplegar | lo mismo con `--dry-run` |
| Cargar un secreto | `wrangler secret put <NOMBRE>` (ver abajo) |

Siempre con `pnpm`, nunca con `npx`. Las rutas de `--config` son relativas a `worker/`.

## Variables y secretos por app

Un mismo código sirve a varias apps. Cada app se configura con valores que llevan su nombre
como sufijo:

| Nombre | Tipo | Contenido |
|---|---|---|
| `HASH_PREFIX_<APP>` | variable | Prefijo del hash, por ejemplo `myapp-ban-v1` |
| `ENFORCE_<APP>` | variable | `"true"` bloquea; otro valor es modo observación |
| `APPLE_TEAM_ID_<APP>` | variable | Team ID de Apple |
| `APPLE_KEY_ID_<APP>` | variable | Key ID de la clave de DeviceCheck |
| `APPLE_DC_KEY_P8_<APP>` | secreto | Contenido del fichero `.p8` |
| `ADMIN_TOKEN` | secreto | Token de la CLI (uno por Worker, sin sufijo) |

- **Variables**: van en `vars` del `wrangler.jsonc`, a la vista y en git.
- **Secretos**: cifrados en Cloudflare, nunca en git. Se cargan con `wrangler secret put`; el
  comando exacto está en el comentario de `deployments/example/wrangler.jsonc`. En local
  van en `worker/.dev.vars` (fuera de git; hay un `.dev.vars.example`).
- El código lee igual las dos: `env.<NOMBRE>`.

`appConfig()` (`worker/src/env.ts`) arma la configuración de una app. El sufijo es el campo
`app` en mayúsculas, con `-` cambiado por `_` (`myapp` ⇒ `_MYAPP`).

- Sin `HASH_PREFIX_<APP>`, la app no existe: `check` responde 404 y admin, 400
  `app sin configurar`.
- Sin los tres datos de Apple (Team ID, Key ID y `.p8`), decide solo con D1.

## workers.dev

El subdominio de Cloudflare donde queda publicado un Worker cuando no se le asigna un dominio
propio, con la forma `<nombre-del-worker>.<subdominio-de-tu-cuenta>.workers.dev`. La plantilla
no declara dominio propio, así que un despliegue llamado `nongrata-myapp` vive en
`https://nongrata-myapp.<tu-subdominio>.workers.dev`. Esa URL, seguida de
`/v1/device/check`, es la que va en `endpoint` al configurar el SDK.

## Cron Trigger de purga

Una tarea programada, como un cron de Unix. En el `wrangler.jsonc` de cada despliegue:

```jsonc
"triggers": { "crons": ["17 3 * * *"] }
```

Cada día a las 3:17 (hora UTC) Cloudflare llama a `scheduled`, que borra de `check_log` las
filas de más de 30 días (`purgeCheckLog` en `worker/src/store.ts`). Nadie tiene que lanzarlo.

## Otras piezas de la configuración

- **Rate limiting**: el binding `RATE_LIMITER` limita `check` a 20 peticiones por minuto por
  IP; al pasarse, `429`. Cloudflare lo aceptó en una cuenta del plan gratuito (2026-11-02).
- **Logs**: los logs de invocación están desactivados (`invocation_logs: false`) para no
  registrar cuerpos de petición.

## Cómo se reparte el repo

```
worker/                     código compartido por todas las apps
├── src/                    el Worker
├── migrations/             tablas de D1 (las usan todos los despliegues)
└── wrangler.jsonc          solo para desarrollo y tests (app "demo")
deployments/
├── example/wrangler.jsonc  plantilla: nombre, base D1, variables y cron
└── <tu-app>/wrangler.jsonc tu despliegue real (git lo ignora: lleva IDs de tu cuenta)
```

Cada app tiene **su propio Worker** (`nongrata-myapp`) y **su propia base**
(`nongrata-myapp`), pero **el mismo código**: su `wrangler.jsonc` apunta a
`../../worker/src/index.ts` y a `../../worker/migrations`. Una app nueva es una copia de
`deployments/example/` con su nombre, sus variables y sus secretos.

## Dónde está en el código

- Rutas, `fetch` y `scheduled`: `worker/src/index.ts`.
- Configuración por app: `appConfig()` en `worker/src/env.ts`.
- Todo el SQL: `worker/src/store.ts`. Tablas: `worker/migrations/0001_init.sql`.
- Despliegue: plantilla en `deployments/example/wrangler.jsonc`. Desarrollo y tests: `worker/wrangler.jsonc`.

Diseño: secciones 3 (Cloudflare), 7 y 14 del [HANDOFF](../HANDOFF.md).
