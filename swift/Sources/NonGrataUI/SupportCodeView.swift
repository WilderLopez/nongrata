import SwiftUI

/// El `ref` tal cual lo espera soporte: monoespaciado, seleccionable para copiarlo y deletreado
/// por VoiceOver, porque leído como palabra no se puede dictar.
struct SupportCodeView: View {
    let ref: String

    var body: some View {
        VStack {
            Text(NonGrataUIStrings.supportCodeLabel)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text(verbatim: ref)
                .font(.title3.monospaced())
                .bold()
                .speechSpellsOutCharacters()
                .textSelection(.enabled)
        }
    }
}
