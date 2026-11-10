import NonGrata
import SwiftUI

/// Cubre el contenido con `NonGrataSuspendedView` mientras el veredicto sea `.blocked`.
/// Con `.allowed` o `.unknown` no hace nada: `.unknown` es el fail-open del SDK.
struct NonGrataBlockingOverlay<SupportAction: View>: ViewModifier {
    let nonGrata: NonGrata
    let title: LocalizedStringResource
    let message: LocalizedStringResource
    let supportAction: (String) -> SupportAction

    func body(content: Content) -> some View {
        let ref = nonGrata.verdict.blockedRef

        content
            // Debajo del bloqueo no se debe poder usar nada, tampoco con VoiceOver o teclado.
            .disabled(ref != nil)
            .accessibilityHidden(ref != nil)
            .overlay {
                if let ref {
                    NonGrataSuspendedView(ref: ref, title: title, message: message) {
                        supportAction(ref)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
    }
}

extension View {
    /// Cubre esta vista con la pantalla de suspendido mientras `nonGrata.verdict` sea
    /// `.blocked`, y la retira sola cuando el Worker responde `ok`. Opcional: la app puede pintar
    /// su propia pantalla leyendo `verdict`. No cierra la sesión de la app; eso lo hace la app.
    public func nonGrataBlockingOverlay<SupportAction: View>(
        _ nonGrata: NonGrata,
        title: LocalizedStringResource = NonGrataUIStrings.suspendedTitle,
        message: LocalizedStringResource = NonGrataUIStrings.suspendedMessage,
        @ViewBuilder supportAction: @escaping (_ ref: String) -> SupportAction
    ) -> some View {
        modifier(NonGrataBlockingOverlay(
            nonGrata: nonGrata,
            title: title,
            message: message,
            supportAction: supportAction
        ))
    }

    /// Igual, sin acción de contacto con soporte.
    public func nonGrataBlockingOverlay(
        _ nonGrata: NonGrata,
        title: LocalizedStringResource = NonGrataUIStrings.suspendedTitle,
        message: LocalizedStringResource = NonGrataUIStrings.suspendedMessage
    ) -> some View {
        nonGrataBlockingOverlay(nonGrata, title: title, message: message) { _ in EmptyView() }
    }
}
