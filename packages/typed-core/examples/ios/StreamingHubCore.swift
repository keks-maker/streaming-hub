// Beispiel: iOS-App nutzt JSON-Schemas aus typed-core
// (Swift natives Codable – kein TypeScript-Compiler nötig)
//
// Generiert aus: packages/typed-core/dist/schemas/*.json
// (via ts-json-schema-generator, Teil des Builds)

import Foundation

// MARK: - Automatisch generiert aus TypeScript-Types

struct StreamService: Codable, Identifiable {
    let id: String
    let name: String
    let url: String
    let icon: String
    let iosAppScheme: String?
    let tvosAppScheme: String?
}

struct TvChannel: Codable, Identifiable {
    let id: String
    let name: String
    let logo: String?
    let url: String
    let group: String
    let epgId: String?
}

struct HistoryEntry: Codable, Identifiable {
    let title: String
    let serviceKey: String
    let serviceName: String
    let timestamp: String

    var id: String { "\(serviceKey):\(title)" }
}

// MARK: - iOS/AppleTV-Adapter

protocol StreamingServiceOpener {
    /// Öffnet die native App für einen Dienst
    func open(_ service: StreamService)

    /// Öffnet einen TV-Sender im AVPlayer
    func playTvChannel(_ channel: TvChannel)
}

class DefaultStreamingServiceOpener: StreamingServiceOpener {

    func open(_ service: StreamService) {
        guard let scheme = service.iosAppScheme,
              let url = URL(string: scheme) else {
            // Fallback: WebView öffnen (wenn kein Scheme)
            return
        }
        // UIApplication.shared.open(url)
    }

    func playTvChannel(_ channel: TvChannel) {
        guard let url = URL(string: channel.url) else { return }
        // AVPlayer(url: url) – HLS native in iOS/tvOS
        // AVPictureInPictureController – PiP native
    }
}

// MARK: - Beispiel: History-Ansicht (SwiftUI)

import SwiftUI

struct HistoryView: View {
    let entries: [HistoryEntry]

    var body: some View {
        List(entries, id: \.id) { entry in
            HStack {
                VStack(alignment: .leading) {
                    Text(entry.title).font(.headline)
                    Text(entry.serviceName).font(.caption).foregroundColor(.gray)
                }
                Spacer()
                Text(entry.timestamp).font(.caption2).foregroundColor(.secondary)
            }
        }
    }
}
