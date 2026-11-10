# Integrar NonGrata en una app iOS

## 1. Dependencia

Swift Package Manager, fijado a una etiqueta de versión:

- En Xcode: File → Add Package Dependencies… → `https://github.com/WilderLopez/nongrata.git`,
  regla "Up to Next Minor Version" desde `0.1.0` (antes de 1.0, un cambio de minor puede romper).
- Productos: `NonGrata` (obligatorio) y `NonGrataUI` (opcional, la pantalla de suspendido).
- Si usas un fork privado, Xcode necesita tu cuenta de GitHub en Settings → Accounts y, si la
  app compila en Xcode Cloud, hay que darle acceso a ese repo desde App Store Connect.

`Package.swift` está en la raíz del repo (SPM no resuelve un paquete remoto en una subcarpeta);
el código sigue en `swift/`.

## 2. Capacidades del App ID

- DeviceCheck no necesita entitlement, pero la app debe pertenecer a la cuenta de desarrollador
  cuya clave usa el Worker.
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
- Textos por defecto en español e inglés. Para cambiarlos, pasa `title:` y `message:` como
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
- Por verificar: que este uso no cuenta como tracking a efectos de ATT (docs/HANDOFF.md,
  sección 16).
