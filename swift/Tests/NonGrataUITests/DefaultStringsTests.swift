import NonGrataUI
import Foundation
import Testing

/// Resuelven desde el bundle del paquete, no desde el de la app: si el bundle fuera el
/// equivocado, saldría siempre el `defaultValue` en español y el caso en inglés fallaría.
struct DefaultStringsTests {
    @Test(
        "Textos por defecto en español e inglés",
        arguments: [
            ("es", "Acceso suspendido", "Código de soporte"),
            ("en", "Access suspended", "Support code"),
        ]
    )
    func defaults(language: String, title: String, supportCode: String) {
        #expect(resolve(NonGrataUIStrings.suspendedTitle, in: language) == title)
        #expect(resolve(NonGrataUIStrings.supportCodeLabel, in: language) == supportCode)
    }

    @Test("El mensaje existe en los dos idiomas y menciona el código", arguments: ["es", "en"])
    func message(language: String) {
        let message = resolve(NonGrataUIStrings.suspendedMessage, in: language)
        #expect(message.contains("nongrata.") == false)
        #expect(message.localizedCaseInsensitiveContains(language == "es" ? "código" : "code"))
    }

    private func resolve(_ resource: LocalizedStringResource, in language: String) -> String {
        var resource = resource
        resource.locale = Locale(identifier: language)
        return String(localized: resource)
    }
}
