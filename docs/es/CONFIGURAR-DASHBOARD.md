# Poner en marcha NonGrata Dashboard desde cero

*English: [DASHBOARD-SETUP.md](../DASHBOARD-SETUP.md)*

De la nada a tener la app [NonGrata Dashboard](https://github.com/WilderLopez/nongrata-dashboard)
(iPhone, iPad o Mac) administrando tu propio Worker. Tres pasos: un Worker, la app y emparejar
los dos.

Esta es la guía práctica. El protocolo que hay detrás del paso 3 (qué se firma, los roles, el
modelo de amenazas) está en [Dispositivos de administración](EMPAREJAMIENTO.md).

## Qué necesitas

| | |
|---|---|
| Una cuenta de Cloudflare | Workers y D1; el plan gratuito basta para empezar |
| En tu ordenador | Node 22.18 o posterior, pnpm y una copia de este repo |
| Para la app | Xcode 16 o posterior; un iPhone o iPad con iOS 17, o un Mac con macOS 14 y Apple silicon o chip T2 |

Para emparejar el Dashboard **no** hace falta la clave de DeviceCheck de Apple. Sin ella el
Worker decide solo con su lista; añádela cuando integres el SDK en tu app
([Integrar en una app iOS](INTEGRACION-IOS.md)).

## 1. Despliega el Worker

¿Ya tienes un Worker de NonGrata? Ve al punto
[1.4](#14-un-worker-desplegado-antes-de-que-existiera-el-emparejamiento).

### 1.1 Crea el despliegue

```sh
git clone https://github.com/WilderLopez/nongrata.git && cd nongrata
make install
cp -r deployments/example deployments/<tu-app>      # git ignora esta carpeta
cd worker
pnpm exec wrangler login                             # una vez por ordenador
pnpm exec wrangler d1 create nongrata-<tu-app>       # imprime el database_id
```

### 1.2 Rellena `deployments/<tu-app>/wrangler.jsonc`

| Campo | Valor |
|---|---|
| `name`, `database_name` | `nongrata-<tu-app>` |
| `database_id` | El que imprimió `d1 create` |
| `namespace_id` | Un número entero que no use ningún otro rate limiter de tu cuenta de Cloudflare, por ejemplo `1001` |
| `HASH_PREFIX_MYAPP` | Renombra la variable a tu app (`HASH_PREFIX_<APP>`, en mayúsculas, `-` como `_`) y dale un valor como `<tu-app>-ban-v1`. No lo cambies nunca después: todos los hashes dependen de él |
| `ENFORCE_MYAPP` | Renómbrala igual y déjala en `"false"` (modo observación) |
| `APPLE_TEAM_ID_MYAPP`, `APPLE_KEY_ID_MYAPP` | Renómbralas y rellénalas si tienes la clave de DeviceCheck; si no, borra las dos líneas |

### 1.3 Secretos, base de datos y despliegue

`ADMIN_TOKEN` es una contraseña que eliges tú; es la credencial maestra del Worker. Genera una
buena y guárdala en un gestor de contraseñas: el paso 3 la necesita.

```sh
openssl rand -base64 32      # copia la salida: es tu ADMIN_TOKEN
```

Desde `worker/`:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config ../deployments/<tu-app>/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config ../deployments/<tu-app>/wrangler.jsonc   # pégalo cuando lo pida
pnpm exec wrangler deploy --config ../deployments/<tu-app>/wrangler.jsonc
```

`deploy` imprime la dirección del Worker, `https://nongrata-<tu-app>.<tu-subdominio>.workers.dev`.
Guárdala también.

Con clave de DeviceCheck, además:

```sh
pnpm exec wrangler secret put APPLE_DC_KEY_P8_<APP> --config ../deployments/<tu-app>/wrangler.jsonc < AuthKey_<KEY_ID>.p8
```

### 1.4 Un Worker desplegado antes de que existiera el emparejamiento

El emparejamiento necesita la migración `0003` y el código actual. Con el repo al día, en
`worker/`, aplica **primero** las migraciones y despliega después (el código nuevo escribe
columnas que la base de datos antigua no tiene):

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config ../deployments/<tu-app>/wrangler.jsonc
pnpm exec wrangler deploy --config ../deployments/<tu-app>/wrangler.jsonc
```

## 2. Consigue la app

Compílala desde su repo, [NonGrata Dashboard](https://github.com/WilderLopez/nongrata-dashboard):
su README trae los pasos (XcodeGen, tu Team ID en un fichero de configuración local, ejecutar
desde Xcode). Necesita una build firmada en un dispositivo real o en un Mac: la clave del paso 3
vive en el Secure Enclave.

Sin Worker, la app se puede recorrer igualmente con sus datos de ejemplo.

## 3. Empareja la app con el Worker

En tu ordenador, desde la raíz de este repo, con la dirección y el token del paso 1:

```sh
export NONGRATA_URL=https://nongrata-<tu-app>.<tu-subdominio>.workers.dev
export NONGRATA_ADMIN_TOKEN=<tu ADMIN_TOKEN>
pnpm ng pair app=<tu-app> role=admin label="Mi Mac"
```

La terminal dibuja un código QR, imprime lo mismo como enlace (`nongrata://pair?…`) y espera:

```text
Scan with NonGrata Dashboard (expires in 10 min):
  ▄▄▄▄▄▄▄ ▄ ▄▄ ▄▄▄▄▄▄▄
  …
Or open: nongrata://pair?v=1&url=…
Waiting for the device…
```

En la app, elige **Connect Your Worker** (conectar tu Worker):

- **iPhone o iPad:** escanea el código QR.
- **Mac:** copia el enlace de la terminal y pégalo en la app. Abrir el enlace
  (`open "nongrata://pair?…"`) hace lo mismo.

Después:

1. La app enseña la dirección del Worker. Comprueba que es la tuya y confirma.
2. La app y la terminal enseñan un **código de 6 dígitos**. Compáralos.
3. Si son iguales, responde `y` en la terminal. Cualquier otra respuesta cancela el
   emparejamiento y borra ese dispositivo.

```text
Claimed by "MacBook Pro" (macos).
Verification code: 123 456. Does the device show the same code? [y/N] y
Paired: device 7sK… with role admin.
```

La app se abre en tu Worker. A partir de aquí no usa nunca el token: firma cada petición con una
clave que no sale del dispositivo.

## 4. Compruébalo

```sh
pnpm ng devices app=<tu-app>     # tu dispositivo, con "status": "active"
```

En la app, Ajustes enseña el Worker, sus apps y el rol de este dispositivo.

## Más dispositivos, roles y quitar uno

- **Un emparejamiento por dispositivo.** El enlace sirve una vez, durante 10 minutos. Ejecuta
  `pnpm ng pair` de nuevo para cada iPhone, iPad o Mac.
- **Roles.** `role=read` puede verlo todo y no cambia nada. `role=admin` puede además banear,
  desbanear y revocar dispositivos. Ningún dispositivo puede emparejar a otro: eso siempre
  requiere el token.
- **Quitar un dispositivo.** `pnpm ng devices revoke app=<tu-app> id=<device_id>`, o desde otro
  dispositivo `admin` en la app. Es definitivo; para volver a usar ese dispositivo, emparéjalo
  otra vez.
- **Varios Workers.** Empareja la app una vez con cada uno; guarda una clave por Worker.

## Si algo falla

| Qué ves | Por qué y qué hacer |
|---|---|
| `missing NONGRATA_URL…` o `missing NONGRATA_ADMIN_TOKEN…` | Las dos líneas `export` del paso 3 no están puestas en esta terminal |
| `HTTP 401` con `unauthorized` en la terminal | El token no es el `ADMIN_TOKEN` de ese Worker. Si lo perdiste, pon otro con `wrangler secret put ADMIN_TOKEN`; los dispositivos emparejados siguen funcionando |
| `HTTP 404` con `not_found` al emparejar | El Worker es anterior al emparejamiento: haz el punto [1.4](#14-un-worker-desplegado-antes-de-que-existiera-el-emparejamiento) |
| `the pairing is expired` o `no device claimed the pairing in time` | Pasaron los 10 minutos. Ejecuta `pnpm ng pair` otra vez |
| El QR no se escanea | Agranda la ventana de la terminal o reduce la letra, o usa el enlace |
| Los códigos son distintos | Responde `N`. Otra persona reclamó ese emparejamiento; ejecuta el comando otra vez y no compartas el enlace |
| La app dice que el reloj está mal | Las peticiones firmadas admiten 5 minutos de diferencia con el Worker. Pon la fecha y la hora del dispositivo en automático |
| La app pide emparejar de nuevo | Se volvió a registrar Face ID o Touch ID, y eso invalida la clave. Empareja otra vez y revoca la entrada antigua |

## Ver también

- [Dispositivos de administración](EMPAREJAMIENTO.md): el protocolo de emparejamiento, las
  peticiones firmadas, los roles y las amenazas.
- [API de administración](API-ADMIN.md): todo lo que la app y la CLI pueden pedirle al Worker.
- [Cloudflare Worker y D1](conceptos/cloudflare-worker-y-d1.md): qué es cada pieza del
  despliegue.
