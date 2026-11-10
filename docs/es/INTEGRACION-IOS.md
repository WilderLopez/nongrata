# Integrar NonGrata en una app iOS

*English: [INTEGRATION-IOS.md](../INTEGRATION-IOS.md)*

## 1. Dependencia

Swift Package Manager, fijado a una etiqueta de versión:

- En Xcode: File → Add Package Dependencies… → `https://github.com/WilderLopez/nongrata.git`,
  regla "Up to Next Minor Version" desde `0.2.0` (antes de 1.0, un cambio de minor puede romper).
- Productos: `NonGrata` (obligatorio) y `NonGrataUI` (opcional, la pantalla de suspendido).
- Si usas un fork privado, Xcode necesita tu cuenta de GitHub en Settings → Accounts y, si la
  app compila en Xcode Cloud, hay que darle acceso a ese repo desde App Store Connect.

`Package.swift` está en la raíz del repo (SPM no resuelve un paquete remoto en una subcarpeta);
el código sigue en `swift/`.

## 2. Capacidades del App ID

- DeviceCheck no necesita entitlement, pero la app debe pertenecer al equipo de desarrollo cuya
  clave usa el Worker. La clave y la app tienen que estar en el **mismo equipo**: una app de
  otro equipo necesita su propia clave de DeviceCheck.
- **Registra un App ID explícito para el bundle ID** (Certificates, IDs & Profiles →
  Identifiers, sin capacidades). Observado el 2026-11-10: con una app firmada solo con el App ID
  comodín del equipo, el dispositivo genera tokens pero Apple responde al Worker
  `400 Bad Authorization Token`, así que el Worker no obtiene `bit0` y decide solo con su lista.
  Unos minutos después de registrar el App ID, la misma build funcionó. Las apps de la App Store
  siempre lo tienen; afecta sobre todo a apps de prueba y de demostración.
- Solo con `useICloud: true`: iCloud con CloudKit (contenedor por defecto) y key-value storage
  (`com.apple.developer.ubiquity-kvstore-identifier`). Sin CloudKit, `useICloud` hace fallar la
  app al leer el ID de iCloud.

## 3. Configuración

```swift
let nonGrata = NonGrata(configuration: .init(
    endpoint: URL(string: "https://<worker>/v1/device/check")!,
    appId: "myapp",
    hashPrefix: "myapp-ban-v1",   // igual que HASH_PREFIX_MYAPP del Worker
    useICloud: true
))
```

Crea una sola instancia para toda la app. Es `@MainActor` y `@Observable`, así que la interfaz
puede observar `verdict` directamente.

## 4. Cuándo comprobar

| Momento | Llamada |
|---|---|
| Al arrancar | `await nonGrata.check(intent: .launch)` |
| Al volver a primer plano | `await nonGrata.check(intent: .foreground)` (se limita sola a una cada `foregroundInterval` mientras no haya bloqueo) |
| Tras un login correcto | `await nonGrata.check(intent: .login, userId: user.id)` |
| Antes de crear la cuenta | ver abajo |

```swift
let verdict = await nonGrata.check(intent: .signup)
guard nonGrata.permits(verdict, for: .signup) else {
    // .blocked: pantalla de suspendido.
    // .unknown en modo estricto: "No se pudo completar el registro, inténtalo de nuevo".
    return
}
createAccount()
```

`permits(_:for:)` aplica el fail-open: `.unknown` deja seguir en todo salvo en `.signup` con
`strictSignup`.

## 5. Bloqueo

- Con `verdict == .blocked(ref:)`, cierra la sesión y muestra tu pantalla de suspendido con el
  `ref` como código de soporte. El SDK no impone interfaz.
- **No cierres la app por código.** La pantalla queda fija; cerrar la app a propósito puede verse
  como un fallo en la revisión de App Store.
- El bloqueo se levanta solo cuando el Worker responde `ok` (por ejemplo, tras un desbaneo por
  `ref`), en la siguiente vuelta a primer plano.

### Pantalla por defecto (opcional)

Si no quieres diseñar la tuya, añade también el producto `NonGrataUI`. Solo pinta: no cierra
la sesión, no navega y no cierra la app.

```swift
import NonGrataUI

RootView()
    .nonGrataBlockingOverlay(nonGrata) { ref in
        Button("Contactar con soporte") { openSupportMail(ref: ref) }
    }
```

- Cubre el contenido solo con `.blocked(ref:)` y lo retira cuando el Worker responde `ok`. Con
  `.unknown` no hace nada (fail-open).
- Debajo, el contenido queda desactivado y oculto para VoiceOver.
- El código de soporte se puede seleccionar para copiarlo y VoiceOver lo deletrea.
- Textos por defecto en inglés (base) y español. Para cambiarlos, pasa `title:` y `message:` como
  `LocalizedStringResource` de tu propio catálogo.
- Si prefieres colocarla tú (por ejemplo en otra ventana o tras cerrar sesión), usa
  `NonGrataSuspendedView(ref:)` directamente.

## 6. Keychain

El SDK guarda `installId` y la marca de bloqueo en el Keychain con el servicio
`keychainService` (por defecto `nongrata`). **No los borres** en la limpieza de primera
ejecución que algunas apps hacen tras reinstalar. Si la app borra todo su Keychain, excluye ese
servicio.

## 7. Analítica y soporte

- `nonGrata.installId`: UUID propio, estable entre reinstalaciones. Mándalo también al backend
  de la app, aunque sea como texto libre, para cruzar cuentas.
- `nonGrata.supportCode`: el `ref` de 8 caracteres que hay que pedir al usuario en soporte.

## 8. Privacidad

- Etiqueta de privacidad de App Store: "Device ID" y "User ID" con fin de prevención de fraude.
- Política de privacidad: mencionar identificadores de dispositivo con fin antifraude.
- Este uso no es tracking, así que no hace falta pedir el permiso de ATT (verificado el
  2026-11-02; [diseño](DISENO.md), sección 16, punto 5).
