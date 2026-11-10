import SwiftUI

/// The `ref` exactly as support expects it: monospaced, selectable so it can be copied, and
/// spelled out by VoiceOver, because read as a word it can't be dictated.
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
