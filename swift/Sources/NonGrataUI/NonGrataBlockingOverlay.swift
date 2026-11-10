import NonGrata
import SwiftUI

/// Covers the content with `NonGrataSuspendedView` while the verdict is `.blocked`.
/// With `.allowed` or `.unknown` it does nothing: `.unknown` is the SDK's fail-open.
struct NonGrataBlockingOverlay<SupportAction: View>: ViewModifier {
    let nonGrata: NonGrata
    let title: LocalizedStringResource
    let message: LocalizedStringResource
    let supportAction: (String) -> SupportAction

    func body(content: Content) -> some View {
        let ref = nonGrata.verdict.blockedRef

        content
            // Nothing underneath the block may be usable, not even with VoiceOver or a keyboard.
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
    /// Covers this view with the suspended screen while `nonGrata.verdict` is `.blocked`, and
    /// removes it on its own when the Worker answers `ok`. Optional: the app can draw its own
    /// screen by reading `verdict`. It doesn't sign the user out; that is up to the app.
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

    /// Same, without a contact-support action.
    public func nonGrataBlockingOverlay(
        _ nonGrata: NonGrata,
        title: LocalizedStringResource = NonGrataUIStrings.suspendedTitle,
        message: LocalizedStringResource = NonGrataUIStrings.suspendedMessage
    ) -> some View {
        nonGrataBlockingOverlay(nonGrata, title: title, message: message) { _ in EmptyView() }
    }
}
