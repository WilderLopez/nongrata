import SwiftUI

@main
struct NonGrataDemoApp: App {
    @State private var model = DemoModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                // Same moments a real app would use: once at launch…
                .task {
                    await model.check(.launch)
                    await model.testDeviceCheck()
                }
        }
        // …and every time the app comes back to the foreground. While the device is not
        // blocked, the SDK skips these if the last check was recent (`foregroundInterval`);
        // while it is blocked, it always checks, so an unban is picked up right away.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.check(.foreground) } }
        }
    }
}
