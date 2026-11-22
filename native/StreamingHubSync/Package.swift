// swift-tools-version: 6.0
import PackageDescription

// Mac-Hilfs-App StreamingHubSync (D10). Linkt den Core (`StreamingHubCore` mit CloudSyncEngine/CKCloudSyncDatabase/
// SyncMerge) aus dem Apple-Repo per lokalem Pfad (Geschwisterordner `StreamingHub-tvOS`); das Build-Skript prüft
// dessen Stand und schreibt ihn in die Release-Notizen.
let package = Package(
    name: "StreamingHubSync",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "StreamingHubSync", targets: ["StreamingHubSync"]),
    ],
    dependencies: [
        .package(name: "StreamingHubTV", path: "../../../StreamingHub-tvOS"),
    ],
    targets: [
        // Protokoll, Sitzung und Server ohne iCloud-Zugriff (testbar mit Fake-Datenbank).
        .target(
            name: "SyncProtocol",
            dependencies: [.product(name: "StreamingHubCore", package: "StreamingHubTV")]
        ),
        .executableTarget(
            name: "StreamingHubSync",
            dependencies: ["SyncProtocol", .product(name: "StreamingHubCore", package: "StreamingHubTV")]
        ),
        .testTarget(
            name: "SyncProtocolTests",
            dependencies: ["SyncProtocol", .product(name: "StreamingHubCore", package: "StreamingHubTV")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
