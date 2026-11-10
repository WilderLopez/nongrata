import Foundation

/// Textos por defecto de `NonGrataUI`, en el String Catalog del paquete (español como idioma
/// base e inglés). La app puede pasar los suyos a `NonGrataSuspendedView`.
public enum NonGrataUIStrings {
    public static var suspendedTitle: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.title",
            defaultValue: "Acceso suspendido",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Título de la pantalla que se muestra cuando este dispositivo está bloqueado."
        )
    }

    public static var suspendedMessage: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.message",
            defaultValue: "Este dispositivo no puede usar la app. Si crees que es un error, contacta con soporte y facilita el código de abajo.",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Explicación bajo el título de la pantalla de bloqueo. «El código de abajo» es el código de soporte."
        )
    }

    public static var supportCodeLabel: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.supportCode",
            defaultValue: "Código de soporte",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Etiqueta sobre el código de 8 caracteres que el usuario dicta a soporte."
        )
    }
}
