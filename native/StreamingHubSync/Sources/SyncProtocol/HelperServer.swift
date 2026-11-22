import Foundation
import StreamingHubCore

/// Liest JSON-Zeilen, beantwortet sie und beendet sich bei EOF (Eingabe-Strom zu Ende) oder `shutdown`.
/// Befehle werden nacheinander verarbeitet; Ereignisse (`account`, `remoteChange`) kommen unaufgefordert dazwischen.
@MainActor
public final class HelperServer {
    public static let helperVersion = "1.0.0"

    private let makeSession: () -> SyncSession
    private var session: SyncSession?
    private let write: (String) -> Void
    private var ready = false

    /// `makeSession` wird erst beim `hello` gerufen (CloudKit wird vorher nicht berührt).
    public init(makeSession: @escaping () -> SyncSession, write: @escaping (String) -> Void) {
        self.makeSession = makeSession; self.write = write
    }

    /// Verarbeitet alle Zeilen bis EOF bzw. `shutdown`. Rückgabe: Exit-Code (0 = sauber).
    @discardableResult
    public func run(lines: AsyncStream<String>) async -> Int32 {
        for await raw in lines {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if await handle(line) == .shutdown { break }
        }
        session?.stopEvents()
        return 0
    }

    private enum Next { case more, shutdown }

    private func handle(_ line: String) async -> Next {
        switch RequestParser.parse(line) {
        case .failure(let id, let error):
            write(OutputLine.error(id: id, error))
            return .more
        case .request(let req):
            return await dispatch(req)
        }
    }

    private func dispatch(_ req: ParsedRequest) async -> Next {
        switch req.command {
        case .hello(let version):
            guard version == syncProtocolVersion else {
                write(OutputLine.error(id: req.id, HelperError(.unsupportedProtocol,
                    "Protokoll \(version) nicht unterstützt, Helfer spricht \(syncProtocolVersion)")))
                return .more
            }
            let s = session ?? makeSession()
            session = s
            ready = true
            s.startEvents(write)
            let account = await s.accountStatus()
            write(OutputLine.ok(id: req.id, result: .object([
                "protocol": .number(Double(syncProtocolVersion)),
                "helperVersion": .string(Self.helperVersion),
                "account": .string(account.wireName),
                "kinds": .array(["Progress", "Recent", "Queue"].map { .string($0) }),
                "lastSync": s.lastSync.map { .number($0) } ?? .null,
            ])))
        case .status:
            guard ready, let s = session else { return notReady(req.id) }
            let account = await s.accountStatus()
            write(OutputLine.ok(id: req.id, result: .object([
                "account": .string(account.wireName),
                "lastSync": s.lastSync.map { .number($0) } ?? .null,
            ])))
        case .sync(let local, let pending):
            guard ready, let s = session else { return notReady(req.id) }
            do {
                let o = try await s.sync(local: local, pending: pending)
                write(OutputLine.ok(id: req.id, result: Self.json(o)))
            } catch let e as HelperError {
                write(OutputLine.error(id: req.id, e))
            } catch {
                write(OutputLine.error(id: req.id, HelperError(.syncFailed, error.localizedDescription)))
            }
        case .shutdown:
            write(OutputLine.ok(id: req.id, result: .object([:])))
            return .shutdown
        }
        return .more
    }

    private func notReady(_ id: String) -> Next {
        write(OutputLine.error(id: id, HelperError(.notReady, "Zuerst hello senden")))
        return .more
    }

    static func json(_ o: SyncOutcome) -> JSONValue {
        let records = o.apply.compactMap { r -> JSONValue? in
            guard let d = try? JSONEncoder().encode(r) else { return nil }
            return try? JSONDecoder().decode(JSONValue.self, from: d)
        }
        func names(_ a: [String]) -> JSONValue { .array(a.map { .string($0) }) }
        return .object([
            "apply": .array(records), "remove": names(o.remove), "uploaded": names(o.uploaded),
            "settled": names(o.settled.sorted()), "failed": names(o.failed),
            "zoneReset": .bool(o.zoneReset), "lastSync": .number(o.lastSync),
        ])
    }
}
