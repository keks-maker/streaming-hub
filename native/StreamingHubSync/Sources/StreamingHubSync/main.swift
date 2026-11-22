import Foundation
import CloudKit
import StreamingHubCore
import SyncProtocol

// StreamingHubSync: Hilfs-App (LSUIElement) für den iCloud-Abgleich des Desktops. Spricht JSON-Zeilen über
// stdin/stdout (PROTOCOL.md), loggt nur nach stderr. Beendet sich bei EOF auf stdin.
// Aufruf: StreamingHubSync [--state-dir <Ordner>]

func stateDirectory() -> URL {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--state-dir"), i + 1 < args.count { return URL(fileURLWithPath: args[i + 1], isDirectory: true) }
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("Streaming Hub/SyncHelper", isDirectory: true)
}

private let outLock = NSLock()
func writeLine(_ s: String) {
    outLock.lock(); defer { outLock.unlock() }
    FileHandle.standardOutput.write(Data((s + "\n").utf8))
}

/// stdin als Zeilenstrom; Ende des Stroms = EOF.
func stdinLines() -> AsyncStream<String> {
    AsyncStream { continuation in
        let thread = Thread {
            while let line = readLine(strippingNewline: true) { continuation.yield(line) }
            continuation.finish()
        }
        thread.start()
    }
}

let dir = stateDirectory()
Task { @MainActor in
    let store = FileHelperStateStore(directory: dir)
    var session: SyncSession?
    let server = HelperServer(makeSession: {
        let db = CKCloudSyncDatabase(stateData: store.load().engineState)
        let s = SyncSession(database: db, store: store)
        session = s
        NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { _ in
            Task { @MainActor in await session?.accountMayHaveChanged() }
        }
        return s
    }, write: writeLine)
    let code = await server.run(lines: stdinLines())
    exit(code)
}
dispatchMain()
