import NonGrataUI
import Foundation
import Testing

/// They resolve from the package's bundle, not the app's: if the bundle were the wrong one,
/// the English `defaultValue` would always come out and the Spanish case would fail.
struct DefaultStringsTests {
    @Test(
        "Default texts in English and Spanish",
        arguments: [
            ("en", "Access suspended", "Support code"),
            ("es", "Acceso suspendido", "Código de soporte"),
        ]
    )
    func defaults(language: String, title: String, supportCode: String) {
        #expect(resolve(NonGrataUIStrings.suspendedTitle, in: language) == title)
        #expect(resolve(NonGrataUIStrings.supportCodeLabel, in: language) == supportCode)
    }

    @Test("The message exists in both languages and mentions the code", arguments: ["en", "es"])
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
