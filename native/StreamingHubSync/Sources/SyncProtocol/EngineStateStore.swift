import Foundation

/// Persistierter Zustand des Helfers (CKSyncEngine-Zustand, Erstabgleich erledigt, letzter Abgleich).
public struct HelperState: Codable, Equatable, Sendable {
    public var engineState: Data?
    public var seeded: Bool
    public var lastSync: Double?
    public init(engineState: Data? = nil, seeded: Bool = false, lastSync: Double? = nil) {
        self.engineState = engineState; self.seeded = seeded; self.lastSync = lastSync
    }
}

public protocol HelperStateStore: AnyObject {
    func load() -> HelperState
    func save(_ state: HelperState)
}

/// Datei `state.json` im eigenen Ordner (`.../Streaming Hub/SyncHelper/`); berührt nie andere App-Daten.
public final class FileHelperStateStore: HelperStateStore {
    private let url: URL
    public init(directory: URL) { url = directory.appendingPathComponent("state.json") }

    public func load() -> HelperState {
        guard let d = try? Data(contentsOf: url), let s = try? JSONDecoder().decode(HelperState.self, from: d) else { return HelperState() }
        return s
    }

    public func save(_ state: HelperState) {
        guard let d = try? JSONEncoder().encode(state) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: url, options: .atomic)
    }
}

public final class MemoryHelperStateStore: HelperStateStore {
    public var state: HelperState
    public init(_ state: HelperState = HelperState()) { self.state = state }
    public func load() -> HelperState { state }
    public func save(_ state: HelperState) { self.state = state }
}
