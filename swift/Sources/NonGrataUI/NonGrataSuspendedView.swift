import SwiftUI

/// Default suspended screen for `NonGrataVerdict.blocked(ref:)`.
///
/// It is optional: the SDK doesn't impose any UI. It neither navigates nor closes the app; the
/// app places it wherever it wants (or uses `nonGrataBlockingOverlay(_:)`). `supportAction` is
/// the slot for the app's contact action, for example a button that opens its support email
/// with the `ref`.
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
        // Centered if it fits; scrollable with large Dynamic Type sizes.
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

#Preview("Without support action") {
    NonGrataSuspendedView(ref: "A1B2C3D4")
}

#Preview("With support action") {
    NonGrataSuspendedView(ref: "A1B2C3D4") {
        Button("Contact support") {}
            .buttonStyle(.borderedProminent)
    }
}
