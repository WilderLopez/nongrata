import Foundation

/// Default texts of `NonGrataUI`, in the package's String Catalog (English as the base language,
/// plus Spanish). The app can pass its own to `NonGrataSuspendedView`.
public enum NonGrataUIStrings {
    public static var suspendedTitle: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.title",
            defaultValue: "Access suspended",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Title of the screen shown when this device is blocked."
        )
    }

    public static var suspendedMessage: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.message",
            defaultValue: "This device can't use the app. If you think this is a mistake, contact support and give them the code below.",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Explanation under the title of the blocking screen. \"The code below\" is the support code."
        )
    }

    public static var supportCodeLabel: LocalizedStringResource {
        LocalizedStringResource(
            "nongrata.suspended.supportCode",
            defaultValue: "Support code",
            bundle: .atURL(#bundle.bundleURL),
            comment: "Label above the 8-character code the user reads out to support."
        )
    }
}
