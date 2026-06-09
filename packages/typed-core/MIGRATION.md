# Migrationspfad: Streaming-Hub → Desktop + iOS/tvOS

## Zielplattformen & Funktionsumfang

| Plattform | Enthält | Code | Status |
|-----------|---------|------|--------|
| 💻 Desktop (Linux) | TV + EPG + **Streaming-Dienste** (Netflix, YouTube, Prime, Twitch, Spotify) | Electron + Castlabs (Widevine) | ✅ **aktiv** v0.4.27 |
| 📱 iOS | TV + EPG + **Mediatheken** (ARD, ZDF, arte, …) | Swift/SwiftUI + AVPlayer | 🔜 geplant |
| 📺 AppleTV | TV + EPG + **Mediatheken** (ARD, ZDF, arte, …) | Swift/SwiftUI + AVPlayer | 🔜 geplant |

## Warum iOS/tvOS keine Streaming-Dienste enthält

- Kein Widevine-CDM auf iOS/tvOS verfügbar
- Fremde Webseiten mit DRM-Inhalt können nicht in WKWebView embedded werden
- URL-Schemes (App-Wechsel zu Netflix etc.) unterbrechen den Verlauf und das App-Erlebnis

**iOS/tvOS fokussiert daher auf**: TV-Linear (HLS via AVPlayer), EPG-Browser, und Mediatheken-Zugriff (API-basiert, ebenfalls AVPlayer).

## Gemeinsame Basis: `typed-core`

```
packages/typed-core/          ← TypeScript, von Desktop + iOS/tvOS genutzt
├── src/
│   ├── types.ts              ← TvChannel, EpgEntry, HistoryEntry, AppConfig …
│   ├── tvsources.ts          ← M3U-Parser, Kanal-Suche, EPG-Logik
│   ├── updater.ts            ← Semver-Vergleich, Tag-Parser (Desktop)
│   ├── history.ts            ← Verlauf (nur TV-bezogen)
│   ├── config.ts             ← Konfiguration
│   └── index.ts              ← Public API
├── tests/
├── package.json
└── tsconfig.json
```

**Desktop** importiert per `npm workspace`.
**iOS/tvOS** importiert per JSON Schema → Swift `Codable`.

## Desktop – bleibt wie gehabt

Electron + Castlabs-Widevine + Webview-Architektur. Keine Änderung an der UI oder den Streaming-Diensten. `typed-core` ersetzt schrittweise die Logik-Teile (M3U-Parser, Update-Check, History).

## iOS/tvOS – reine TV/Mediatheken-App

Neue Swift/SwiftUI-Codebase, getrenntes Repository. Kein Legacy-Code aus der Desktop-App.

### Features
- **TV-Linear**: AVPlayer für HLS-Streams
- **EPG**: Senderliste mit Live-Programm, 7-Tage-Übersicht
- **Mediatheken**: API-basierter Zugriff auf ARD, ZDF, arte (HLS via AVPlayer)
- **PiP**: AVPictureInPictureController (nativ)
- **Background Audio**: Wiedergabe im Hintergrund, Control Center
- **Suche**: Über Sender, EPG-Titel und Mediatheken-Inhalte
- **Verlauf**: Nur TV/Mediatheken-Inhalte

### Nicht enthalten
- Netflix, YouTube, Prime Video, Twitch, Spotify (Desktop-exklusiv)

### Architektur
```
apps/
├── streaminghub-ios/          ← iOS (iPhone/iPad)
│   ├── StreamingHub/          ← SwiftUI App
│   │   ├── Models/            ← Swift-Codable-Mirror von typed-core
│   │   ├── Views/             ← SwiftUI Views
│   │   ├── Services/          ← AVPlayer, Mediatheken-API
│   │   └── Resources/         ← Assets, Config
│   └── StreamingHub.xcodeproj
│
└── streaminghub-tvos/         ← AppleTV
    ├── StreamingHubTV/        ← SwiftUI App (tvOS)
    │   ├── Models/            ← Gleiche Modelle wie iOS
    │   ├── Views/             ← tvOS-optimierte SwiftUI Views
    │   ├── Services/          ← AVPlayer, Mediatheken-API
    │   └── Resources/
    └── StreamingHubTV.xcodeproj
```

### Datenfluss

```
typed-core (TypeScript)
    │
    ├── build:json-schema ──────────► JSON Schema
    │                                      │
    │                               Swift Gen (sourcery/gyb)
    │                                      │
    │                                      ▼
    │                              Swift Codable Models
    │
    ├── tvsources.json ──────────────────► App Bundle (iOS/tvOS)
    ├── services.json  ──────────────────► (nur Desktop)
    └── epg/          ──────────────────► EPG-Daten (beide Plattformen)
```

### tvOS-Besonderheiten

- **Kein App-Wechsel** per URL-Scheme (tvOS erlaubt das nicht)
- Mediatheken daher als **native AVPlayer-Wiedergabe** (HLS-Streams)
- Focus-basierte Navigation (Remote Control)
- Top Shelf Widget für "Weiterschauen"

## Zeitplan (grob)

1. **typed-core aufsetzen** – Paket-Struktur, Types, Build
2. **Desktop schluckt typed-core** – Schrittweise Migration
3. **Mediatheken-APIs analysieren** – ARD, ZDF, arte HLS-Endpunkte
4. **tvOS MVP** – Senderliste + AVPlayer + EPG
5. **iOS MVP** – iPhone-Adaption
6. **Erweiterungen** – PiP, Background Audio, Suche, Top Shelf
