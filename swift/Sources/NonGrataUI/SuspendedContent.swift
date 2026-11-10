import SwiftUI

/// Contenido de `NonGrataSuspendedView`, que lo coloca centrado o dentro de un scroll.
struct SuspendedContent<SupportAction: View>: View {
    let ref: String
    let title: LocalizedStringResource
    let message: LocalizedStringResource
    let supportAction: SupportAction

    var body: some View {
        VStack {
            Image(systemName: "hand.raised.fill")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
                .padding(.bottom)

            Text(title)
                .font(.title2)
                .bold()
                .accessibilityAddTraits(.isHeader)

            Text(message)
                .foregroundStyle(.secondary)

            SupportCodeView(ref: ref)
                .padding(.vertical)

            supportAction
        }
        .multilineTextAlignment(.center)
        .padding()
        .frame(maxWidth: .infinity)
    }
}
