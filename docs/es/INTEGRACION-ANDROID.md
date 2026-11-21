# Integrar NonGrata en una app Android

*English: [INTEGRATION-ANDROID.md](../INTEGRATION-ANDROID.md)*

El SDK de Kotlin vive en `android/` (módulo `nongrata`, paquete `io.github.wilderlopez.nongrata`).
Pregunta al mismo Worker que la app de iOS, con la misma lista, si el dispositivo está bloqueado.
Si has leído la [guía de iOS](INTEGRACION-IOS.md), casi todo es igual; la sección 7 recoge lo que
cambia.

## 1. Requisitos

- `minSdk 26` (Android 8.0). El SDK se compila con JDK 17 y con las versiones del Android Gradle
  Plugin y de Gradle que fija el repo (`android/gradle/libs.versions.toml` y
  `android/gradle/wrapper/gradle-wrapper.properties`); tu app necesita una cadena de herramientas
  capaz de leer un módulo compilado con ellas.
- El permiso `INTERNET`. El manifiesto de la librería lo declara y se fusiona con el de tu app, así
  que no añades nada.
- Ninguna dependencia en tiempo de ejecución salvo la biblioteca estándar de Kotlin, y ninguna
  interfaz.

## 2. Instalación

NonGrata aún no está en Maven Central. Por ahora una app lo consume desde una copia de este repo,
con una compilación compuesta de Gradle, como hace `Examples/NonGrataDemoAndroid`.

1. Pon el repo donde tu app lo vea: un clon junto a tu proyecto o un submódulo de git.
2. En el `settings.gradle.kts` de la app, apunta al directorio `android/`:

   ```kotlin
   includeBuild("../ruta/a/nongrata/android")
   ```

3. En el módulo de la app, sin versión (la da la compilación incluida):

   ```kotlin
   dependencies {
       implementation("io.github.wilderlopez:nongrata")
   }
   ```

**Fíjalo.** Una copia de `main` cambia bajo tus pies. Usa una etiqueta de versión o un commit que
contenga `android/` y, en un submódulo, haz commit de ese puntero, para que todas las compilaciones
usen el mismo SDK. Antes de 1.0, un cambio de minor puede romper la API.

**Verificación de dependencias.** Gradle solo lee `gradle/verification-metadata.xml` de la
compilación raíz, que es tu app: el fichero del propio SDK se ignora al incluirlo. Si tu app usa
verificación, regenera el tuyo tras añadir el SDK
(`./gradlew --write-verification-metadata sha256 build`) y revisa el diff. El SDK no añade nada en
ejecución; lo que aparece son artefactos de compilación del Android Gradle Plugin. El
[README de Android](../../android/README.md) explica cómo los fija el repo.

## 3. El Worker

La app habla con el **mismo Worker y la misma lista que iOS**: mismo `app` y mismo
`HASH_PREFIX_<APP>` en la configuración. Un baneo por `user` alcanza entonces a la persona en las
dos plataformas. Si la app es nueva en el Worker, créala como en la guía de iOS; en el portal de
Apple no hay nada que configurar para Android.

Un Worker existente necesita dos cosas antes de que una build Android compruebe contra él:

- El código que entiende `platform: "android"` (la [API de comprobación](API-CHECK.md#clientes-android)).
  Sin él, el Worker toma el camino de iOS e ignora `android_id`.
- La migración `0006`, que añade `check_log.platform`. Sin ella **todas las comprobaciones fallan
  con un `500`** y las apps caen en fail-open. Ver
  "Actualizar a la columna de plataforma" en la [guía de la API de administración](API-ADMIN.md) y aplícala
  antes de desplegar.

Una comprobación Android nunca llega a Apple, aunque la app tenga clave de DeviceCheck.

## 4. Configuración

Crea **una sola instancia** para toda la app, en tu `Application`, y comprueba enseguida:

```kotlin
class MyApplication : Application() {
    lateinit var nonGrata: NonGrata
        private set

    override fun onCreate() {
        super.onCreate()
        nonGrata = NonGrata(
            this,
            NonGrataConfiguration(
                endpoint = "https://<worker>/v1/device/check",
                appId = "myapp",
                hashPrefix = "myapp-ban-v1",   // igual que HASH_PREFIX_MYAPP del Worker
            ),
        )
        nonGrata.check(CheckIntent.LAUNCH)
    }
}
```

Decláralo en el manifiesto (`android:name=".MyApplication"`). `endpoint` es la URL completa de
`POST /v1/device/check`; el constructor lanza `IllegalArgumentException` si no es una URL `http(s)`
absoluta, así que un error de escritura falla al arrancar y no en la primera comprobación. Los
demás parámetros tienen valor por defecto:

| Parámetro | Por defecto | |
|---|---|---|
| `environment` | `PRODUCTION` | Se manda como `env`; solo para el registro de comprobaciones, porque una comprobación Android nunca llama a Apple. |
| `strictSignup` | `true` | Con `SIGNUP`, crear la cuenta exige `Allowed`. |
| `foregroundInterval` | 6 horas | Intervalo mínimo entre comprobaciones `FOREGROUND` mientras está permitido. |
| `timeout` | 5 segundos | Para conectar y, aparte, para leer la respuesta. |

El constructor lee dos ficheros pequeños en el hilo que lo llama, así que un dispositivo que estaba
bloqueado es `Blocked` desde el primer instante, antes de cualquier comprobación. Las comprobaciones
corren en un hilo de fondo.

## 5. Cuándo comprobar

| Momento | Llamada |
|---|---|
| Al arrancar | `nonGrata.check(CheckIntent.LAUNCH)` |
| Al volver a primer plano | `nonGrata.check(CheckIntent.FOREGROUND)` (se limita a una cada `foregroundInterval` mientras está permitido) |
| Tras un login correcto | `nonGrata.check(CheckIntent.LOGIN, userId)` |
| Antes de crear la cuenta | ver abajo |
| Cuando algo pueda haber cambiado | `nonGrata.check(CheckIntent.REFRESH)` (nunca se limita) |

El SDK no depende de `androidx.lifecycle`, así que no detecta el primer plano por su cuenta. Llama
a `FOREGROUND` desde donde tu app ya lo sepa: `Activity.onStart`, o `ProcessLifecycleOwner` si lo
usas.

Antes de crear una cuenta:

```kotlin
nonGrata.check(CheckIntent.SIGNUP) { verdict ->
    if (nonGrata.permits(verdict, CheckIntent.SIGNUP)) {
        createAccount()
    } else {
        // Blocked: la pantalla de suspendido.
        // Unknown en modo estricto: "No se pudo completar el registro. Inténtalo de nuevo."
    }
}
```

`permits(verdict, intent)` aplica fail-open: `Unknown` deja pasar todo salvo `SIGNUP` con
`strictSignup`.

### El `userId`

Pasa el ID del usuario en todas las comprobaciones hechas con sesión, no solo en el login: un
baneo por `user` alcanza a un dispositivo en una comprobación que lleve ese usuario. Las
mayúsculas no importan (el SDK y el Worker pasan A-Z a minúsculas antes de hacer el hash). Si tu
Worker tiene los vínculos de usuario activados, mira
[Banear por ID de usuario](INTEGRACION-IOS.md#banear-por-id-de-usuario).

**Nunca pases un `userId` vacío.** El SDK descarta un `userId` vacío o solo con espacios y saltos de
línea, y manda la comprobación sin usuario. El motivo es que el hash de un usuario vacío es el
mismo en todos los dispositivos sin sesión: si alguna vez se baneara ese hash y se propagara,
bloquearía a todo el que no haya iniciado sesión. Pasa `null` (o nada) cuando no hay sesión. El
Worker también lo descarta ([API de comprobación](API-CHECK.md#3-qué-hace-el-servidor),
"Usuario vacío"), pero un cliente no debe contar con eso.

### Cuánto tarda en llegar un baneo

Igual que en iOS: un baneo llega a un dispositivo en su **siguiente comprobación**, no cuando lo
haces. Arranque, login y registro siempre comprueban; `FOREGROUND` se salta mientras el último
veredicto permitido sea más reciente que `foregroundInterval`. Las tres palancas de
[la guía de iOS](INTEGRACION-IOS.md#cuánto-tarda-en-llegar-un-baneo) valen igual: bajar
`foregroundInterval`, comprobar con un temporizador corto mientras la app está abierta y llamar a
`REFRESH` cuando sepas que algo cambió. Un temporizador en Kotlin:

```kotlin
private val handler = Handler(Looper.getMainLooper())
private val tick = object : Runnable {
    override fun run() {
        nonGrata.check(CheckIntent.FOREGROUND)   // manda como mucho una por foregroundInterval
        handler.postDelayed(this, 60_000)
    }
}
// onStart: handler.post(tick)       onStop: handler.removeCallbacks(tick)
```

El Worker no manda push ni guarda token de push. Un desbaneo no espera: un dispositivo bloqueado
comprueba en cada `FOREGROUND`.

## 6. Bloqueo

`NonGrata.verdict` es `Allowed`, `Blocked(ref)` o `Unknown`. Escucha los cambios y lee el actual
cuando arranque una pantalla:

```kotlin
private val listener = NonGrata.VerdictListener { verdict ->
    if (verdict is NonGrataVerdict.Blocked) showSuspended(verdict.ref)   // cierra sesión, muestra tu pantalla
    else hideSuspended()
}

override fun onStart() {
    super.onStart()
    nonGrata.addListener(listener)
    listener.onVerdict(nonGrata.verdict)
}
override fun onStop() {
    nonGrata.removeListener(listener)
    super.onStop()
}
```

- Los oyentes y el callback de `check` se llaman **en el hilo principal**. Añádelos desde el hilo
  principal y quítalos cuando la pantalla desaparezca: el SDK los retiene con referencia fuerte.
- Con `Blocked(ref)`, cierra la sesión del usuario y muestra tu pantalla de suspendido con el `ref`
  como código de soporte. **El SDK no impone interfaz y nunca cierra la app.** Tampoco la cierres
  por código; la pantalla queda fija.
- `nonGrata.supportCode` es el mismo `ref` de 8 caracteres de este dispositivo, disponible desde
  cualquier hilo (`null` solo si no se pudo leer el almacenamiento). Muéstralo en "Contactar con
  soporte" y pídelo. `nonGrata.installId` es el UUID propio del SDK, para analítica: mándalo a tu
  backend para cruzar cuentas.
- **La marca local de bloqueo** es un fichero en `noBackupFilesDir`. Una respuesta `blocked` escribe
  ahí el `ref`; solo un `ok` lo borra. Un error de red, un timeout o un `5xx` no tocan nada: un
  dispositivo bloqueado sigue bloqueado sin conexión, y uno que nunca estuvo bloqueado queda
  `Unknown` y entra (fail-open). El bloqueo se levanta solo cuando el Worker responde `ok`, por
  ejemplo tras un desbaneo por `ref`.

No borres los ficheros del SDK (`<noBackupFilesDir>/nongrata/`) en ninguna limpieza que haga tu app
tras una reinstalación o una actualización. Si vacías ese directorio, pierdes el `installId` y la
marca de bloqueo.

## 7. Diferencias con iOS

- **Sin DeviceCheck ni `bit0`, sin iCloud.** En iOS un baneo sobrevive a reinstalar porque Apple
  guarda un bit del dispositivo. Android no tiene equivalente en esta versión. Hay tres
  identificadores: `install`, `user` y `android_id`.
- **El `installId` no sobrevive a desinstalar.** Vive en `noBackupFilesDir`, que Auto Backup nunca
  copia, así que restaurar en un teléfono nuevo no clona el `ref`; el precio es que desinstalar lo
  borra. Lo que devuelve a un dispositivo baneado es `ANDROID_ID`: cuando un dispositivo bloqueado
  comprueba, el Worker propaga su hash, así que la app reinstalada (`install` nuevo, mismo
  `ANDROID_ID`) sigue bloqueada.
- **`ANDROID_ID` tiene límites.** Sobrevive a desinstalar y reinstalar mientras la app se firme con
  la misma clave. Puede cambiar tras un restablecimiento de fábrica, y cada usuario de un
  dispositivo con varios usuarios ve un valor distinto (como si fuera otro dispositivo). Antes de
  Android 8 lo compartían todas las apps, pero `minSdk 26` lo descarta. Google no lo prohíbe para
  prevenir abuso, pero no es una garantía: quien restablece el teléfono y cambia de cuenta es un
  dispositivo nuevo. Ver [diseño, sección 15](DISENO.md#15-android).
- **Callbacks en el hilo principal, no `async`.** `check` vuelve enseguida y llama a `onResult` (y a
  los oyentes) en el hilo principal. El `await` de Swift no tiene aquí equivalente en Kotlin.
- **Reloj monótono.** El límite de `FOREGROUND` usa `SystemClock.elapsedRealtime`, así que cambiar
  la fecha del teléfono no lo salta ni lo alarga. Como en iOS, se guarda solo en memoria: si el
  proceso muere, el siguiente `FOREGROUND` comprueba.
- **No sigue redirecciones.** Solo un `200` con `{status, ref}` es respuesta; un `3xx` es "sin
  respuesta" (fail-open), no una segunda petición. Usa la URL final del Worker, sin redirección
  delante.
- Si dos comprobaciones se solapan, decide la que empezó la última, igual que en iOS.

## 8. Privacidad

- **Play Console, formulario «Data safety».** Declara "Device or other IDs" (el ID `install` y
  `ANDROID_ID`) y "User IDs" (el ID `user`, si lo pasas), ambos **collected** y **not shared**, con
  el propósito "Fraud prevention, security, and compliance". Nada en el formulario exime a un
  identificador por estar hasheado, así que decláralos aunque el Worker solo guarde hashes.
- **Política de privacidad.** Menciona los identificadores de dispositivo usados para prevenir
  fraude. Con `LINK_USERS_<APP>` activo, el Worker guarda un hash del ID de usuario vinculado a un
  hash del ID de instalación durante 180 días desde la última vez visto; dilo.
- El Worker nunca guarda identificadores en bruto ni IPs. Eso lo garantiza por su lado; el SDK solo
  manda hashes.

## 9. Probarlo

- **La app de demostración**, `Examples/NonGrataDemoAndroid`, consume el SDK con `includeBuild` y
  tiene un botón por cada tipo de comprobación, un campo para el `userId` y el veredicto y el
  código de soporte en pantalla. Copia `nongrata.local.properties.example` a
  `nongrata.local.properties` (git ignora la copia) y rellena la URL, el `appId` y el `hashPrefix`
  de tu Worker; sin él la demo compila con marcadores y toda comprobación acaba en `Unknown`.
  `make build-android` la compila.
- **El emulador** basta: el SDK no usa servicios de Google, así que una imagen AOSP sirve igual que
  una con Google Play. El emulador tiene su propio `ANDROID_ID` y un borrado de datos lo cambia, que
  es una forma rápida de probar un "restablecimiento de fábrica".
- **Un baneo de punta a punta.** Arranca la demo, escribe un ID de usuario y pulsa Login, banéalo
  desde la CLI (`pnpm ng ban app=myapp kind=user value=<ese ID de usuario>`, ver la guía de la
  [API de administración](API-ADMIN.md)), pulsa una comprobación y el veredicto pasa a `Blocked`.
  Desbanea por el `ref` que muestra (`pnpm ng unban app=myapp ref=<ref>`) y vuelve a comprobar:
  `Allowed`. Usa un Worker con `ENFORCE`; en modo observación responde `ok` diga lo que diga la
  lista.
- **Los tests del propio SDK**: `make test-android` los ejecuta en la JVM, sin emulador y sin red.
  Leen los vectores de hash de `spec/hash-vectors.json`.

## 10. Otras plataformas

El contrato exacto de la comprobación, para un cliente que no es este SDK, está en la
[guía de la API de comprobación](API-CHECK.md).
