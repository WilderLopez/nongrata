import SwiftUI

/// Pantalla de suspendido por defecto para `NonGrataVerdict.blocked(ref:)`.
///
/// Es opcional: el SDK no impone interfaz. No navega ni cierra la app; la app la coloca donde
/// quiera (o usa `nonGrataBlockingOverlay(_:)`). `supportAction` es el hueco para la acción
/// de contacto de la app, por ejemplo un botón que abre su correo de soporte con el `ref`.
public struct NonGrataSuspendedView<SupportAction: View>: View {
    private let ref: String
    private let title: LocalizedStringResource
    private let message: LocalizedStringResource
    private let supportAction: SupportAction

    public init(
        ref: String,
        title: LocalizedStringResource = NonGrataUIStrings.suspendedTitle,
        message: LocalizedStringResource = NonGrataUIStrings.suspendedMessage,
        @ViewBuilder supportAction: () -> SupportAction
    ) {
        self.ref = ref
        self.title = title
        self.message = message
        self.supportAction = supportAction()
    }

    public var body: some View {
        // Centrada si cabe; con textos grandes de Dynamic Type, desplazable.
        ViewThatFits(in: .vertical) {
            SuspendedContent(ref: ref, title: title, message: message, supportAction: supportAction)

            ScrollView {
                SuspendedContent(ref: ref, title: title, message: message, supportAction: supportAction)
            }
        }
    }
}

extension NonGrataSuspendedView where SupportAction == EmptyView {
    public init(
        ref: String,
        title: LocalizedStringResource = NonGrataUIStrings.suspendedTitle,
        message: LocalizedStringResource = NonGrataUIStrings.suspendedMessage
    ) {
        self.init(ref: ref, title: title, message: message) { EmptyView() }
    }
}

#Preview("Sin acción de soporte") {
    NonGrataSuspendedView(ref: "A1B2C3D4")
}

#Preview("Con acción de soporte") {
    NonGrataSuspendedView(ref: "A1B2C3D4") {
        Button("Contactar con soporte") {}
            .buttonStyle(.borderedProminent)
    }
}
