import Foundation
import StreamingHubCore

/// Protokollversion (siehe PROTOCOL.md). Wird im `hello` abgeglichen.
public let syncProtocolVersion = 1

/// Record-Arten, die der Desktop abgleicht. Alles andere (Merklisten) bleibt unberührt und wird weder angewendet
/// noch hochgeladen.
public let desktopSyncKinds: Set<SyncRecordKind> = [.progress, .recent, .queue]

/// Fehlercodes der Antworten (`error.code`).
public enum HelperErrorCode: String, Sendable {
    case badRequest = "bad_request"
    case unknownCommand = "unknown_command"
    case notReady = "not_ready"
    case unsupportedProtocol = "unsupported_protocol"
    case noAccount = "no_account"
    case accountUnavailable = "account_unavailable"
    case syncFailed = "sync_failed"
}

public struct HelperError: Error, Equatable, Sendable {
    public let code: HelperErrorCode
    public let message: String
    public init(_ code: HelperErrorCode, _ message: String) { self.code = code; self.message = message }
}

/// Eingehender Befehl (nach dem Parsen).
public enum HelperCommand: Equatable, Sendable {
    case hello(protocolVersion: Int)
    case sync(local: [SyncRecord], pending: Set<String>)
    case status
    case shutdown
}

public struct ParsedRequest: Equatable, Sendable {
    public var id: String
    public var command: HelperCommand
}

/// Ergebnis eines Parse-Versuchs: Anfrage oder Fehler samt Korrelations-ID, soweit lesbar.
public enum RequestParse: Equatable, Sendable {
    case request(ParsedRequest)
    case failure(id: String?, error: HelperError)
}

public enum RequestParser {
    public static func parse(_ line: String) -> RequestParse {
        guard let data = line.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else {
            return .failure(id: nil, error: HelperError(.badRequest, "Zeile ist kein JSON-Objekt"))
        }
        guard let id = dict["id"] as? String, !id.isEmpty else {
            return .failure(id: nil, error: HelperError(.badRequest, "id (String) fehlt"))
        }
        guard let cmd = dict["cmd"] as? String else {
            return .failure(id: id, error: HelperError(.badRequest, "cmd fehlt"))
        }
        switch cmd {
        case "hello":
            guard let v = dict["protocol"] as? Int else {
                return .failure(id: id, error: HelperError(.badRequest, "protocol (Ganzzahl) fehlt"))
            }
            return .request(ParsedRequest(id: id, command: .hello(protocolVersion: v)))
        case "status":
            return .request(ParsedRequest(id: id, command: .status))
        case "shutdown":
            return .request(ParsedRequest(id: id, command: .shutdown))
        case "sync":
            guard let rawLocal = dict["local"] as? [Any],
                  let localData = try? JSONSerialization.data(withJSONObject: rawLocal),
                  let local = try? JSONDecoder().decode([SyncRecord].self, from: localData) else {
                return .failure(id: id, error: HelperError(.badRequest, "local (Liste gültiger Records) fehlt"))
            }
            var pending: Set<String> = []
            if let p = dict["pending"] {
                guard let names = p as? [String] else {
                    return .failure(id: id, error: HelperError(.badRequest, "pending muss eine Liste von Strings sein"))
                }
                pending = Set(names)
            }
            return .request(ParsedRequest(id: id, command: .sync(local: local, pending: pending)))
        default:
            return .failure(id: id, error: HelperError(.unknownCommand, "Unbekannter Befehl \(cmd)"))
        }
    }
}

/// Ausgehende Zeilen (Antworten und Ereignisse), als kompaktes JSON mit sortierten Schlüsseln.
public enum OutputLine {
    private static func encode(_ value: JSONValue) -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    public static func ok(id: String, result: JSONValue) -> String {
        encode(.object(["id": .string(id), "ok": .bool(true), "result": result]))
    }

    public static func error(id: String?, _ error: HelperError) -> String {
        encode(.object([
            "id": id.map { .string($0) } ?? .null,
            "ok": .bool(false),
            "error": .object(["code": .string(error.code.rawValue), "message": .string(error.message)]),
        ]))
    }

    public static func event(_ name: String, _ payload: [String: JSONValue] = [:]) -> String {
        var o = payload
        o["event"] = .string(name)
        return encode(.object(o))
    }
}

public extension CloudAccountStatus {
    /// Wert im Protokoll: `available`, `no_account`, `unavailable`.
    var wireName: String {
        switch self {
        case .available: return "available"
        case .noAccount: return "no_account"
        case .unavailable: return "unavailable"
        }
    }
}
