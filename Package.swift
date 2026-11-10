// swift-tools-version: 6.0
import PackageDescription

// En la raíz del repo para que SPM lo resuelva por URL (github.com/WilderLopez/device-guard).
// El código vive en swift/; cada target lleva su ruta.
let package = Package(
    name: "DeviceGuard",
    defaultLocalization: "es",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "DeviceGuard", targets: ["DeviceGuard"]),
        // Opcional: pantalla de suspendido por defecto. El núcleo no depende de SwiftUI.
        .library(name: "DeviceGuardUI", targets: ["DeviceGuardUI"]),
    ],
    targets: [
        .target(name: "DeviceGuard", path: "swift/Sources/DeviceGuard"),
        .target(
            name: "DeviceGuardUI",
            dependencies: ["DeviceGuard"],
            path: "swift/Sources/DeviceGuardUI",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "DeviceGuardTests",
            dependencies: ["DeviceGuard"],
            path: "swift/Tests/DeviceGuardTests"
        ),
        .testTarget(
            name: "DeviceGuardUITests",
            dependencies: ["DeviceGuardUI"],
            path: "swift/Tests/DeviceGuardUITests"
        ),
    ]
)
