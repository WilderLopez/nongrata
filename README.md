<p align="center">
  <img src="assets/icon.svg" width="128" height="128" alt="Icono de NonGrata: un iPhone con la señal de prohibido">
</p>

# NonGrata

Baneo por dispositivo y por cuenta de Apple para apps iOS, sin tocar el backend de la app.

Cuando alguien crea cuentas en cadena (cierra sesión y abre otra, reinstala, borra el iPhone),
banear la cuenta no basta. NonGrata recuerda el dispositivo con varias capas que sobreviven a
cosas distintas: el `identifierForVendor`, un identificador propio en el Keychain, el usuario de
iCloud y los dos bits de [DeviceCheck](https://developer.apple.com/documentation/devicecheck) que
Apple guarda en sus servidores, que sobreviven incluso a borrar el iPhone.

Tres piezas:

| Pieza | Qué es |
|---|---|
| SDK Swift (`NonGrata`, `NonGrataUI`) | Paquete SPM para iOS 17+. Comprueba el dispositivo y devuelve `allowed`, `blocked(ref:)` o `unknown`. `NonGrataUI` es opcional: la pantalla de suspendido. |
| Worker (`worker/`) | Cloudflare Worker con D1. Decide con la lista de baneos y con DeviceCheck. Un despliegue por app. |
| CLI (`cli/`) | Banear, desbanear y consultar desde la terminal. |

Solo viajan hashes (`SHA256(prefijo:tipo:valor)`); ni el Worker ni la base guardan
identificadores en bruto ni IPs.

## Cómo se usa

### 1. Desplegar el Worker de tu app

Necesitas una cuenta de Cloudflare (el plan gratuito sirve para empezar) y, para DeviceCheck, una
clave con DeviceCheck activado del portal de Apple Developer (Certificates, IDs & Profiles →
Keys).

```sh
make install
cp -r deployments/example deployments/<tu-app>      # git ignora esta carpeta
cd worker
pnpm exec wrangler d1 create nongrata-<tu-app>   # pon el database_id en tu wrangler.jsonc
```

Edita `deployments/<tu-app>/wrangler.jsonc` (nombre, `HASH_PREFIX_<APP>`, Team ID y Key ID) y,
desde `worker/`:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config ../deployments/<tu-app>/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config ../deployments/<tu-app>/wrangler.jsonc
pnpm exec wrangler secret put APPLE_DC_KEY_P8_<APP> --config ../deployments/<tu-app>/wrangler.jsonc < AuthKey_<KEY_ID>.p8
pnpm exec wrangler deploy --config ../deployments/<tu-app>/wrangler.jsonc
```

Empieza en modo observación (`ENFORCE_<APP> = "false"`): registra lo que bloquearía, pero deja
entrar a todo el mundo. Detalle en [Cloudflare Worker y D1](docs/conceptos/cloudflare-worker-y-d1.md).

### 2. Añadir el SDK a la app

En Xcode, File → Add Package Dependencies… con la URL de este repo, desde la versión `0.1.0`.

```swift
import NonGrata

let nonGrata = NonGrata(configuration: .init(
    endpoint: URL(string: "https://nongrata-myapp.<tu-subdominio>.workers.dev/v1/device/check")!,
    appId: "myapp",
    hashPrefix: "myapp-ban-v1"   // igual que HASH_PREFIX_MYAPP del Worker
))

let verdict = await nonGrata.check(intent: .launch)
```

Cuándo comprobar, qué hacer con cada veredicto, capacidades y privacidad:
[Integrar en una app iOS](docs/INTEGRATION-IOS.md).

### 3. Banear y desbanear

```sh
export NONGRATA_URL_MYAPP=https://nongrata-myapp.<tu-subdominio>.workers.dev
export NONGRATA_ADMIN_TOKEN_MYAPP=<tu ADMIN_TOKEN>
pnpm ng ban    app=myapp kind=idfv value=<IDFV> note="spam"
pnpm ng unban  app=myapp ref=A1B2C3D4      # el código de soporte que ve el usuario
pnpm ng help
```

## Documentación

- [Diseño completo](docs/HANDOFF.md): problema, arquitectura, contrato, algoritmo, riesgos y lo
  que queda por verificar.
- [Integrar en una app iOS](docs/INTEGRATION-IOS.md).
- [Glosario](docs/glosario.md) y notas de conceptos en [`docs/conceptos/`](docs/conceptos/).

## Desarrollo

Solo con pnpm (`packageManager` fija la versión). Node 22.18 o superior y Xcode con Swift 6.

```sh
make install   # dependencias
make check     # docs, tipos, tests de Worker, CLI y SDK, build de iOS y mutation testing
```

Los tests del Worker corren dentro de `workerd`; los de Swift, con `swift test` desde la raíz.

## Estado

Versión 0.1.0. Falta App Attest (opcional) y Android está esbozado, no diseñado. Ver la
sección 16 del [diseño](docs/HANDOFF.md) para lo que aún no está confirmado en la documentación
de Apple o Cloudflare.

## Licencia

[MIT](LICENSE).
