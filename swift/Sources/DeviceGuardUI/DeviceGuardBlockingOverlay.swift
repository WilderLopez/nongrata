import DeviceGuard
import SwiftUI

/// Cubre el contenido con `DeviceGuardSuspendedView` mientras el veredicto sea `.blocked`.
/// Con `.allowed` o `.unknown` no hace nada: `.unknown` es el fail-open del SDK.
struct DeviceGuardBlockingOverlay<SupportAction: View>: ViewModifier {
    let deviceGuard: DeviceGuard
    let title: LocalizedStringResource
    let message: LocalizedStringResource
    let supportAction: (String) -> SupportAction

    func body(content: Content) -> some View {
        let ref = deviceGuard.verdict.blockedRef

        content
            // Debajo del bloqueo no se debe poder usar nada, tampoco con VoiceOver o teclado.
            .disabled(ref != nil)
            .accessibilityHidden(ref != nil)
            .overlay {
                if let ref {
                    DeviceGuardSuspendedView(ref: ref, title: title, message: message) {
                        supportAction(ref)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
    }
}

extension View {
    /// Cubre esta vista con la pantalla de suspendido mientras `deviceGuard.verdict` sea
    /// `.blocked`, y la retira sola cuando el Worker responde `ok`. Opcional: la app puede pintar
    /// su propia pantalla leyendo `verdict`. No cierra la sesión de la app; eso lo hace la app.
    public func deviceGuardBlockingOverlay<SupportAction: View>(
        _ deviceGuard: DeviceGuard,
        title: LocalizedStringResource = DeviceGuardUIStrings.suspendedTitle,
        message: LocalizedStringResource = DeviceGuardUIStrings.suspendedMessage,
        @ViewBuilder supportAction: @escaping (_ ref: String) -> SupportAction
    ) -> some View {
        modifier(DeviceGuardBlockingOverlay(
            deviceGuard: deviceGuard,
            title: title,
            message: message,
            supportAction: supportAction
        ))
    }

    /// Igual, sin acción de contacto con soporte.
    public func deviceGuardBlockingOverlay(
        _ deviceGuard: DeviceGuard,
        title: LocalizedStringResource = DeviceGuardUIStrings.suspendedTitle,
        message: LocalizedStringResource = DeviceGuardUIStrings.suspendedMessage
    ) -> some View {
        deviceGuardBlockingOverlay(deviceGuard, title: title, message: message) { _ in EmptyView() }
    }
}
