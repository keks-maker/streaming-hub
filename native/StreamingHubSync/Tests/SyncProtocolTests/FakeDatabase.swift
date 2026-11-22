import Foundation
import StreamingHubCore
@testable import SyncProtocol

@MainActor
final class FakeDatabase: CloudSyncDatabase {
    var onRemoteChange: (() -> Void)?
    var stateData: Data? = Data("state".utf8)
    var account: CloudAccountStatus = .available
    var fetchResults: [CloudFetch] = [CloudFetch()]
    var sendHandler: ([SyncRecord]) -> [CloudSendResult] = { $0.map { .saved($0) } }
    var fetchError: Error?
    private(set) var sent: [[SyncRecord]] = []
    private(set) var forgotten: [String] = []
    private(set) var fetchCount = 0

    func fetch() async throws -> CloudFetch {
        fetchCount += 1
        if let fetchError { throw fetchError }
        return fetchResults.count > 1 ? fetchResults.removeFirst() : (fetchResults.first ?? CloudFetch())
    }
    func send(_ records: [SyncRecord]) async throws -> [CloudSendResult] {
        sent.append(records)
        return sendHandler(records)
    }
    func currentAccountStatus() async -> CloudAccountStatus { account }
    func forget(_ names: [String]) { forgotten += names }
}

func progress(_ id: String, _ modified: Double, position: Double = 10, deleted: Bool = false) -> SyncRecord {
    SyncRecord(name: "p:\(id)", kind: .progress, modified: modified, deleted: deleted,
               fields: ["id": .string(id), "position": .number(position), "duration": .number(100)])
}
