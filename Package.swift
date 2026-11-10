// swift-tools-version: 6.0
import PackageDescription

// At the repo root so SPM can resolve it by URL (github.com/WilderLopez/nongrata).
// The code lives in swift/; each target sets its own path.
let package = Package(
    name: "NonGrata",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NonGrata", targets: ["NonGrata"]),
        // Optional: default suspended screen. The core doesn't depend on SwiftUI.
        .library(name: "NonGrataUI", targets: ["NonGrataUI"]),
    ],
    targets: [
        .target(name: "NonGrata", path: "swift/Sources/NonGrata"),
        .target(
            name: "NonGrataUI",
            dependencies: ["NonGrata"],
            path: "swift/Sources/NonGrataUI",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "NonGrataTests",
            dependencies: ["NonGrata"],
            path: "swift/Tests/NonGrataTests"
        ),
        .testTarget(
            name: "NonGrataUITests",
            dependencies: ["NonGrataUI"],
            path: "swift/Tests/NonGrataUITests"
        ),
    ]
)
