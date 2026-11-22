import XCTest
import StreamingHubCore
@testable import SyncProtocol

@MainActor
final class ProtocolTests: XCTestCase {
    private var db: FakeDatabase!
    private var store: MemoryHelperStateStore!
    private var out: [String] = []

    override func setUp() async throws {
        db = FakeDatabase(); store = MemoryHelperStateStore(); out = []
    }

    private func server() -> HelperServer {
        HelperServer(makeSession: { [db, store] in SyncSession(database: db!, store: store!, now: { 1_000_000 }) },
                     write: { [weak self] in self?.out.append($0) })
    }

    private func run(_ lines: [String], server s: HelperServer? = nil) async -> Int32 {
        let stream = AsyncStream<String> { c in lines.forEach { c.yield($0) }; c.finish() }
        return await (s ?? server()).run(lines: stream)
    }

    private func obj(_ i: Int) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(out[i].utf8))) as? [String: Any] ?? [:]
    }

    func testHelloHandshakeReportsAccountAndVersion() async {
        let code = await run([#"{"id":"1","cmd":"hello","protocol":1}"#])
        XCTAssertEqual(code, 0)
        let r = obj(0)
        XCTAssertEqual(r["id"] as? String, "1"); XCTAssertEqual(r["ok"] as? Bool, true)
        let res = r["result"] as? [String: Any]
        XCTAssertEqual(res?["protocol"] as? Int, 1)
        XCTAssertEqual(res?["account"] as? String, "available")
        XCTAssertEqual(res?["kinds"] as? [String], ["Progress", "Recent", "Queue"])
    }

    func testHelloReportsNoAccount() async {
        db.account = .noAccount
        _ = await run([#"{"id":"1","cmd":"hello","protocol":1}"#])
        XCTAssertEqual((obj(0)["result"] as? [String: Any])?["account"] as? String, "no_account")
    }

    func testUnsupportedProtocolVersion() async {
        _ = await run([#"{"id":"1","cmd":"hello","protocol":99}"#])
        XCTAssertEqual(obj(0)["ok"] as? Bool, false)
        XCTAssertEqual((obj(0)["error"] as? [String: Any])?["code"] as? String, "unsupported_protocol")
    }

    func testSyncBeforeHelloIsNotReady() async {
        _ = await run([#"{"id":"7","cmd":"sync","local":[]}"#])
        XCTAssertEqual((obj(0)["error"] as? [String: Any])?["code"] as? String, "not_ready")
        XCTAssertEqual(obj(0)["id"] as? String, "7")
    }

    func testMalformedLinesAndUnknownCommand() async {
        _ = await run(["kein json", #"{"cmd":"hello"}"#, #"{"id":"a"}"#, #"{"id":"b","cmd":"wat"}"#,
                       #"{"id":"c","cmd":"sync","local":[{"name":"x","kind":"Bogus","modified":1}]}"#,
                       #"{"id":"d","cmd":"hello","protocol":"1"}"#, ""])
        let codes = (0..<out.count).map { (obj($0)["error"] as? [String: Any])?["code"] as? String }
        XCTAssertEqual(codes, ["bad_request", "bad_request", "bad_request", "unknown_command", "bad_request", "bad_request"])
        XCTAssertTrue(obj(0)["id"] is NSNull)
        XCTAssertEqual(obj(2)["id"] as? String, "a")
    }

    func testEOFEndsCleanlyWithoutOutput() async {
        let code = await run([])
        XCTAssertEqual(code, 0); XCTAssertTrue(out.isEmpty)
    }

    func testShutdownRepliesAndStopsReading() async {
        let code = await run([#"{"id":"1","cmd":"shutdown"}"#, #"{"id":"2","cmd":"status"}"#])
        XCTAssertEqual(code, 0); XCTAssertEqual(out.count, 1)
        XCTAssertEqual(obj(0)["ok"] as? Bool, true)
    }

    func testSyncUploadsPendingAndAppliesNewerRemote() async throws {
        db.fetchResults = [CloudFetch(records: [progress("remote", 500, position: 77)])]
        let local = [progress("a", 100), progress("remote", 100, position: 5)]
        let line = try String(decoding: JSONSerialization.data(withJSONObject: [
            "id": "s", "cmd": "sync", "pending": ["p:a"],
            "local": local.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }]), as: UTF8.self)
        _ = await run([#"{"id":"1","cmd":"hello","protocol":1}"#, line])
        let res = obj(1)["result"] as? [String: Any]
        XCTAssertTrue((res?["uploaded"] as? [String])?.contains("p:a") == true)
        let applied = res?["apply"] as? [[String: Any]]
        XCTAssertEqual(applied?.map { $0["name"] as? String }, ["p:remote"])
        XCTAssertEqual(store.state.seeded, true)
        XCTAssertEqual(store.state.lastSync, 1_000_000)
        XCTAssertEqual(store.state.engineState, Data("state".utf8))
    }

    func testSyncWithoutAccountReturnsError() async {
        db.account = .noAccount
        _ = await run([#"{"id":"1","cmd":"hello","protocol":1}"#, #"{"id":"2","cmd":"sync","local":[]}"#])
        XCTAssertEqual((obj(1)["error"] as? [String: Any])?["code"] as? String, "no_account")
        XCTAssertEqual(db.fetchCount, 0)
    }

    func testFetchErrorBecomesSyncFailed() async {
        struct Boom: LocalizedError { var errorDescription: String? { "netz" } }
        db.fetchError = Boom()
        _ = await run([#"{"id":"1","cmd":"hello","protocol":1}"#, #"{"id":"2","cmd":"sync","local":[]}"#])
        let e = obj(1)["error"] as? [String: Any]
        XCTAssertEqual(e?["code"] as? String, "sync_failed"); XCTAssertEqual(e?["message"] as? String, "netz")
    }

    func testRemoteChangeAndAccountEventsAreEmitted() async {
        let s = server()
        let stream = AsyncStream<String> { c in
            c.yield(#"{"id":"1","cmd":"hello","protocol":1}"#)
            c.finish()
        }
        _ = await s.run(lines: stream)
        // Nach EOF sind die Ereignisse abgehängt.
        db.onRemoteChange?()
        XCTAssertEqual(out.count, 1)
        // Mit laufender Sitzung: direkt über die Sitzung.
        let session = SyncSession(database: db, store: store, emit: { [weak self] in self?.out.append($0) })
        session.startEvents { [weak self] in self?.out.append($0) }
        db.onRemoteChange?()
        XCTAssertEqual(obj(1)["event"] as? String, "remoteChange")
        _ = await session.accountStatus()
        db.account = .noAccount
        await session.accountMayHaveChanged()
        XCTAssertEqual(obj(2)["event"] as? String, "account")
        XCTAssertEqual(obj(2)["status"] as? String, "no_account")
        await session.accountMayHaveChanged()   // unverändert: kein weiteres Ereignis
        XCTAssertEqual(out.count, 3)
    }

    func testOnlyDesktopKindsAreSyncedAndRemoteMerklistenIgnored() async throws {
        db.fetchResults = [CloudFetch(records: [SyncRecord(name: "l:1", kind: .mlist, modified: 9, fields: ["id": .string("1")])])]
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        let o = try await session.sync(local: [], pending: [])
        XCTAssertTrue(o.apply.isEmpty); XCTAssertTrue(db.sent.isEmpty)
    }

    func testPendingTombstoneOlderThan30DaysIsStillUploaded() async throws {
        let old = 1_000_000 - 40 * 86_400.0
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        let o = try await session.sync(local: [progress("x", old, deleted: true)], pending: ["p:x"])
        XCTAssertEqual(o.uploaded, ["p:x"]); XCTAssertTrue(o.remove.isEmpty)
    }

    func testConflictIsMergedAndFailedStaysPending() async throws {
        db.sendHandler = { recs in recs.map { r in
            r.name == "p:c" ? .conflict(server: progress("c", 900, position: 1)) : (r.name == "p:f" ? .failed(name: r.name) : .saved(r))
        } }
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        let o = try await session.sync(local: [progress("c", 100), progress("f", 100), progress("ok", 100)],
                                       pending: ["p:c", "p:f", "p:ok"])
        XCTAssertEqual(o.apply.map(\.name), ["p:c"])
        XCTAssertEqual(o.failed, ["p:f"])
        XCTAssertEqual(Set(o.settled), ["p:c", "p:ok"])
    }

    func testZoneMissingRetriesOnceThenFails() async {
        db.sendHandler = { $0.map { .zoneMissing(name: $0.name) } }
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        do { _ = try await session.sync(local: [progress("a", 1)], pending: ["p:a"]); XCTFail("erwartet Fehler") }
        catch let e as HelperError { XCTAssertEqual(e.code, .syncFailed) } catch { XCTFail("\(error)") }
        XCTAssertEqual(db.sent.count, 2)
    }

    func testFailedFirstRunIsRetriedViaPending() async throws {
        let local = [progress("a", 1), progress("b", 1)]
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        db.sendHandler = { $0.map { .failed(name: $0.name) } }
        let o1 = try await session.sync(local: local, pending: [])
        XCTAssertEqual(o1.failed, ["p:a", "p:b"]); XCTAssertEqual(store.state.seeded, true)
        db.sendHandler = { $0.map { .saved($0) } }
        let o2 = try await session.sync(local: local, pending: ["p:a", "p:b"])
        XCTAssertEqual(o2.uploaded, ["p:a", "p:b"]); XCTAssertTrue(o2.failed.isEmpty)
        XCTAssertEqual(store.state.seeded, true)
    }

    func testThrownSendErrorInFirstRunDoesNotMarkSeeded() async throws {
        struct Net: Error {}
        let local = [progress("a", 1)]
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        db.sendError = Net()
        do { _ = try await session.sync(local: local, pending: []); XCTFail("erwartet Fehler") } catch {}
        XCTAssertNotEqual(store.state.seeded, true)
        db.sendError = nil
        let o = try await session.sync(local: local, pending: [])
        XCTAssertEqual(o.uploaded, ["p:a"]); XCTAssertEqual(store.state.seeded, true)
    }

    func testRecordsOpenAfterMaxSendRoundsAreFailed() async throws {
        let rec = progress("a", 100)
        db.sendHandler = { _ in [.conflict(server: progress("a", 50, position: 99))] }
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        // Server-Stand stets älter: lokaler Stand gewinnt, der Konflikt wiederholt sich, bis die Runden erschöpft sind.
        let o = try await session.sync(local: [rec], pending: [])
        XCTAssertLessThanOrEqual(db.sent.count, CloudSyncEngine.maxSendRounds)
        XCTAssertTrue(Set(o.failed).isDisjoint(with: Set(o.settled)))
        XCTAssertEqual(db.sent.count, CloudSyncEngine.maxSendRounds)
        XCTAssertEqual(o.failed, ["p:a"]); XCTAssertEqual(store.state.seeded, true)
    }

    func testSettledAndFailedAreDisjointAfterZoneReset() async throws {
        var calls = 0
        db.sendHandler = { recs in calls += 1
            if calls == 1 { return recs.map { $0.name == "p:a" ? .saved($0) : .zoneMissing(name: $0.name) } }
            return recs.map { .failed(name: $0.name) } }
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        let o = try await session.sync(local: [progress("a", 1), progress("b", 1)], pending: ["p:a", "p:b"])
        XCTAssertEqual(o.settled, [])
        XCTAssertEqual(o.failed, ["p:a", "p:b"])
        XCTAssertEqual(o.uploaded, [])
    }

    func testPermanentFailureStillMarksSeededAndSecondRunUploadsOnlyPending() async throws {
        let local = [progress("a", 1), progress("b", 1)]
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        db.sendHandler = { $0.map { $0.name == "p:a" ? .failed(name: $0.name) : .saved($0) } }
        let o1 = try await session.sync(local: local, pending: [])
        XCTAssertEqual(o1.failed, ["p:a"]); XCTAssertEqual(o1.uploaded, ["p:b"])
        XCTAssertEqual(store.state.seeded, true)
        let sentBefore = db.sent.count
        let o2 = try await session.sync(local: local, pending: ["p:a"])
        XCTAssertEqual(db.sent.count, sentBefore + 1)
        XCTAssertEqual(db.sent.last?.map(\.name), ["p:a"])
        XCTAssertEqual(o2.failed, ["p:a"])
    }

    func testExpiredTombstoneLeavesGuardAfterSeeding() async throws {
        let old = 1_000_000 - 40 * 86_400.0
        let tomb = progress("x", old, deleted: true)
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        db.sendHandler = { $0.map { $0.name == "p:a" ? .failed(name: $0.name) : .saved($0) } }
        let o1 = try await session.sync(local: [progress("a", 1), tomb], pending: [])
        XCTAssertEqual(o1.uploaded, ["p:x"]); XCTAssertEqual(store.state.seeded, true)
        // Server kennt die Löschmarke jetzt; ohne Erstabgleich ist sie nicht mehr geschützt und entfällt lokal.
        db.fetchResults = [CloudFetch(records: [tomb])]
        let o2 = try await session.sync(local: [progress("a", 1), tomb], pending: ["p:a"])
        XCTAssertEqual(o2.remove, ["p:x"]); XCTAssertFalse(o2.uploaded.contains("p:x"))
    }

    func testUploadedAndFailedAreDisjoint() async throws {
        var calls = 0
        db.sendHandler = { recs in calls += 1
            if calls == 1 { return recs.map { $0.name == "p:a" ? .saved($0) : .zoneMissing(name: $0.name) } }
            return recs.map { .failed(name: $0.name) } }
        let session = SyncSession(database: db, store: store, now: { 1_000_000 })
        let o = try await session.sync(local: [progress("a", 1), progress("b", 1)], pending: ["p:a", "p:b"])
        XCTAssertTrue(Set(o.uploaded).isDisjoint(with: Set(o.failed)))
        XCTAssertEqual(o.failed, ["p:a", "p:b"])
    }
}
