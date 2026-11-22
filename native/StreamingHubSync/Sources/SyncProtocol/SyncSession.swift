import Foundation
import StreamingHubCore

/// Ergebnis eines Abgleichs (Antwort auf `sync`).
public struct SyncOutcome: Equatable, Sendable {
    /// Lokal anzuwenden (Gewinner ungleich dem gelieferten lokalen Stand).
    public var apply: [SyncRecord] = []
    /// Lokal entfallende Namen (abgelaufene Löschmarken).
    public var remove: [String] = []
    /// Auf dem Server gespeichert.
    public var uploaded: [String] = []
    /// Aus `pending` bzw. Upload erledigt (Remote gewann oder gespeichert); der Rest bleibt wartend.
    public var settled: [String] = []
    /// Senden fehlgeschlagen: bleibt wartend.
    public var failed: [String] = []
    public var zoneReset = false
    public var lastSync: Double = 0
}

/// Gleicht vom Desktop gelieferte lokale Records mit der CloudKit-Datenbank ab. Gleiche Regeln wie die Core-Engine
/// (`CloudSyncEngine.runOnce`: Erstabgleich/Zonen-Reset gleicht alles ab, fehlende Server-Records werden neu gesendet,
/// Konflikte neu gemerged, höchstens `maxSendRounds` Runden, eine Zonen-Neuanlage je Abgleich, wartende Löschmarken
/// bleiben über 30 Tage geschützt), aber ohne Core-Stores: die lokalen Daten liegen auf der JS-Seite.
@MainActor
public final class SyncSession {
    private let database: CloudSyncDatabase
    private let store: HelperStateStore
    private let now: () -> Double
    private var state: HelperState
    private var lastAccount: CloudAccountStatus?
    private var emit: (String) -> Void

    public init(database: CloudSyncDatabase, store: HelperStateStore, now: @escaping () -> Double = { Date().timeIntervalSince1970 },
                emit: @escaping (String) -> Void = { _ in }) {
        self.database = database; self.store = store; self.now = now; self.emit = emit
        state = store.load()
    }

    public var lastSync: Double? { state.lastSync }

    /// Hängt die Ereignis-Ausgabe ein und meldet Remote-Änderungen (Push) als Ereignis `remoteChange`.
    public func startEvents(_ emit: @escaping (String) -> Void) {
        self.emit = emit
        database.onRemoteChange = { [weak self] in self?.emit(OutputLine.event("remoteChange")) }
    }

    public func stopEvents() { database.onRemoteChange = nil }

    public func accountStatus() async -> CloudAccountStatus {
        let s = await database.currentAccountStatus()
        lastAccount = s
        return s
    }

    /// Kontowechsel/Abmeldung möglich (Aufrufer: `CKAccountChanged`): neu lesen und bei Änderung als Ereignis melden.
    public func accountMayHaveChanged() async {
        let previous = lastAccount
        let s = await accountStatus()
        if s != previous { emit(OutputLine.event("account", ["status": .string(s.wireName)])) }
    }

    public func sync(local: [SyncRecord], pending: Set<String>) async throws -> SyncOutcome {
        switch await accountStatus() {
        case .noAccount: throw HelperError(.noAccount, "Kein iCloud-Konto angemeldet oder eingeschränkt")
        case .unavailable: throw HelperError(.accountUnavailable, "iCloud ist vorübergehend nicht verfügbar")
        case .available: break
        }
        var outcome = SyncOutcome()
        var zoneRetries = 0
        do {
            var current = local
            var again = true
            while again {
                again = try await runOnce(local: current, pending: pending, outcome: &outcome, zoneRetries: &zoneRetries)
                if again {
                    // Folgedurchlauf (Zone neu angelegt) arbeitet auf dem bisherigen Zwischenstand.
                    var byName = Dictionary(current.map { ($0.name, $0) }, uniquingKeysWith: { $1 })
                    for r in outcome.apply { byName[r.name] = r }
                    for n in outcome.remove { byName[n] = nil }
                    current = Array(byName.values)
                }
            }
        } catch let e as HelperError { throw e } catch {
            persist()
            throw HelperError(.syncFailed, error.localizedDescription)
        }
        // `failed` hat Vorrang vor `settled` und `uploaded` (Namen sind disjunkt).
        let failedNames = Set(outcome.failed)
        outcome.settled.removeAll { failedNames.contains($0) }
        outcome.uploaded.removeAll { failedNames.contains($0) }
        // Erstabgleich gilt nach einem Lauf ohne geworfenen Fehler als erledigt: jeder nicht hochgeladene Record steht
        // namentlich in `failed`, JS hält ihn in `pending` und versucht ihn erneut. Bei einem Fehler (Wurf oder
        // Fehlerantwort ohne Namen) kommt dieser Punkt nicht und `seeded` bleibt unverändert.
        state.seeded = true
        state.lastSync = now()
        outcome.lastSync = state.lastSync ?? 0
        persist()
        return outcome
    }

    private func persist() {
        state.engineState = database.stateData
        store.save(state)
    }

    /// Ein Durchlauf; `true` = Zone wurde neu angelegt, noch einmal ausführen.
    private func runOnce(local: [SyncRecord], pending: Set<String>, outcome: inout SyncOutcome, zoneRetries: inout Int) async throws -> Bool {
        let fetched = try await database.fetch()
        let remote = fetched.records.filter { desktopSyncKinds.contains($0.kind) }
        var working: [String: SyncRecord] = [:]
        for r in local where desktopSyncKinds.contains(r.kind) { working[r.name] = r }
        let initial = working
        var removed = Set<String>()
        var pendingNow = pending.intersection(working.keys)

        var names = Set(remote.map(\.name)).union(pendingNow)
        if fetched.zoneReset || !state.seeded {
            names.formUnion(working.keys)
            pendingNow.formUnion(working.keys)
            outcome.zoneReset = outcome.zoneReset || fetched.zoneReset
        }
        if !fetched.deletedNames.isEmpty {
            // Auf dem Server gelöscht (wir löschen nie): lokaler Stand bleibt und wird neu hochgeladen.
            database.forget(fetched.deletedNames)
            let local = Set(fetched.deletedNames).intersection(working.keys)
            names.formUnion(local); pendingNow.formUnion(local)
        }

        func mergeStep(remote: [SyncRecord], names: Set<String>) -> [SyncRecord] {
            let loc = names.compactMap { working[$0] }
            let r = CloudSyncMerge.mergeKeepingPendingTombstones(local: loc, remote: remote, now: now(), pending: pendingNow)
            let mergedNames = Set(r.merged.map(\.name))
            for m in r.merged { working[m.name] = m }
            for gone in Set(loc.map(\.name)).subtracting(mergedNames) { working[gone] = nil; removed.insert(gone) }
            let uploadNames = Set(r.toUpload.map(\.name))
            for n in r.merged.map(\.name) where pendingNow.contains(n) && !uploadNames.contains(n) {
                pendingNow.remove(n)
                if !outcome.settled.contains(n) { outcome.settled.append(n) }
            }
            return r.toUpload
        }

        var toUpload = mergeStep(remote: remote, names: names)
        var round = 0, zoneMissing = false
        var uploaded = Set(outcome.uploaded), failed = Set<String>()
        while !toUpload.isEmpty, round < CloudSyncEngine.maxSendRounds {
            round += 1
            var retry: [SyncRecord] = []
            for result in try await database.send(toUpload) {
                switch result {
                case .saved(let rec):
                    uploaded.insert(rec.name); failed.remove(rec.name)
                    if pendingNow.remove(rec.name) != nil, !outcome.settled.contains(rec.name) { outcome.settled.append(rec.name) }
                case .conflict(let server):
                    if desktopSyncKinds.contains(server.kind) { retry += mergeStep(remote: [server], names: [server.name]) }
                case .recordMissing(let name):
                    database.forget([name])
                    pendingNow.insert(name)
                    if let r = working[name] { retry.append(r) }
                case .zoneMissing:
                    zoneMissing = true
                case .failed(let name):
                    failed.insert(name)
                }
            }
            toUpload = retry
            if zoneMissing { break }
        }
        // Nach `maxSendRounds` noch offene Records wurden nicht gesendet: wartend melden.
        if !zoneMissing { for r in toUpload { failed.insert(r.name) } }
        // Abschluss des Durchlaufs in die Ausgabe übernehmen.
        let changed = working.values.filter { initial[$0.name] != $0 }.sorted { $0.name < $1.name }
        var applied = Dictionary(outcome.apply.map { ($0.name, $0) }, uniquingKeysWith: { $1 })
        for c in changed { applied[c.name] = c }
        outcome.apply = applied.values.sorted { $0.name < $1.name }
        outcome.remove = Array(Set(outcome.remove).union(removed)).sorted()
        outcome.uploaded = uploaded.sorted()
        outcome.failed = failed.sorted()
        if zoneMissing {
            guard zoneRetries < 1 else { throw HelperError(.syncFailed, "Die iCloud-Zone konnte nicht angelegt werden") }
            zoneRetries += 1
            outcome.zoneReset = true
            state.seeded = false   // nächster Durchlauf gleicht den gesamten Bestand ab
            return true
        }
        return false
    }
}
