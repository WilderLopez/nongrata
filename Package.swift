// swift-tools-version: 6.0
import PackageDescription

// En la raíz del repo para que SPM lo resuelva por URL (github.com/WilderLopez/nongrata).
// El código vive en swift/; cada target lleva su ruta.
let package = Package(
    name: "NonGrata",
    defaultLocalization: "es",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NonGrata", targets: ["NonGrata"]),
        // Opcional: pantalla de suspendido por defecto. El núcleo no depende de SwiftUI.
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
