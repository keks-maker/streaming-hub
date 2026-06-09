# Streaming-Hub Projekt – Übergabeprompt

## Projektüberblick

Streaming-Hub ist eine Desktop-App unter Electron (Castlabs-Widevine) zum Streamen von TV (HLS) und Streaming-Diensten (Netflix, YouTube, Prime, Twitch, Spotify) in einem Fenster. Das gesamte Projekt liegt auf einem lokalen Gitea-Server.

Es gibt **drei** Repos, die zusammenhängen:

| Repo | URL | Technologie | Zweck |
|------|-----|-------------|-------|
| Streaming-Hub | http://192.168.4.105:3000/kekskarlo/Streaming-Hub.git | Electron/JS | Desktop-App (TV + ALLE Streaming-Dienste) |
| StreamingHub-tvOS | http://192.168.4.105:3000/kekskarlo/StreamingHub-tvOS.git | Swift/SwiftUI (tvOS 18) | AppleTV – nur TV + Mediatheken |
| StreamingHub-iOS | http://192.168.4.105:3000/kekskarlo/StreamingHub-iOS.git | Swift/SwiftUI (iOS 18) | iPhone/iPad – nur TV + Mediatheken |

Gitea-Zugang: `kekskarlo` / Token im Klartext bei Bedarf erfragen.

## Architekturentscheidung (bereits getroffen)

**iOS/tvOS kann keine Streaming-Dienste embedded anzeigen** (kein Widevine-CDM, kein App-Wechsel unter tvOS). Daher:
- **Desktop**: bleibt Electron – bekommt TV + ALLE Streaming-Dienste (Netflix, YouTube, Prime, etc.)
- **iOS/tvOS**: reine TV-Sender + Mediatheken (ARD, ZDF, arte) – per AVPlayer, native HLS
- **typed-core** (geplant): gemeinsame TypeScript-Library für Modelle + Logik, Desktop nutzt direkt, iOS/tvOS per JSON-Schema-Brücke

Der Desktop wird **nicht** nach TypeScript migriert. typed-core extrahiert nur die Datenlogik, der UI-Teil (renderer.js) bleibt JS.

## Desktop-Repo (Streaming-Hub) – Aktueller Stand

- **Version**: v0.4.30
- **Branch**: master
- **Remote**: http://192.168.4.105:3000/kekskarlo/Streaming-Hub.git
- **Lokaler Pfad**: `/home/keks/Dokumente/opencode/Streaming-Hub`
- **Aktive Python-Toolchain**: uv (kein pip, PEP 668 aktiv)
- **Projekt-Ordner liegt nicht im Home-Tree**

### Desktop: Features
- Zwei Webview-Architektur: `contentView` (Netflix/Youtube/Prime/Spotify) + `tvView` (TV-Sender via HLS.js/tv.html)
- Session-Partition: `persist:tv` für tvView
- Logger (`logger.js`)
- Error-Boundary für Webviews
- CI/CD via Gitea Actions (`.gitea/workflows/build.yaml`)
- ESLint Flat Config
- Update-Mechanismus: Updater (updater.js) vergleicht git-Tags via `git ls-remote --tags origin`

### Desktop: Letzte Bugs (gefixt)
- v0.4.24: TV-Bild unsichtbar – CSS `display:none` auf tvView → `opacity:0`
- v0.4.25: `opacity: ''` vs `opacity: '1'` nach Webview-Wechsel
- v0.4.26: TV-Stream lief nach Wechsel zurück weiter → `about:blank` beim Verlassen
- v0.4.27: Netflix/YouTube liefen nach TV-Wechsel im Hintergrund weiter → `executeJavaScript()` pausiert alle video/audio-Elemente

### Desktop: Wichtige Commit-Regel
Nach **jeder** Änderung MUSS ein systematischer Code-Review gemacht werden, bevor committet wird. Prüfen:
- Event-Listener (fehlen welche, hängen sie am richtigen Objekt?)
- Webview-Referenzen (webview, contentView, tvView)
- CSS-Regeln (überschreiben Klassen die Inline-Styles?)
- Side-Effects (welche Komponenten sind indirekt betroffen?)
- BEIDE Richtungen bei Toggles prüfen (contentView→tvView UND tvView→contentView)

### Desktop: Update-Workflow
1. Änderung committen
2. Patch-Version (3. Stelle) in `package.json` erhöhen
3. CHANGELOG.md aktualisieren
4. git-Tag erstellen (`v0.4.x`)
5. `git push --tags`
6. Ohne neuen Tag kein Update-Button im Client

## iOS/tvOS-Repo – Aktueller Stand

Beide wurden frisch initialisiert mit:
- `.gitignore` (Swift/Xcode)
- `Package.swift` (Swift 6, iOS/tvOS 18)
- `project.yml` (XcodeGen)
- `setup.sh` (Setup-Script)

### Gemeinsamer Core (`Sources/StreamingHubCore/`)
Modelle:
- `TvSource` – TV-Quelle (M3U/JSON-URL)
- `TvChannel` – Ein TV-Sender mit HLS-URL
- `EpgEntry` – EPG-Eintrag (Titel, Start/Ende)
- `EpgData` – EPG-Daten pro Kanal
- `HistoryEntry` – Wiedergabe-Verlauf
- `MediathekSource` – ARD/ZDF/arte-API-Konfiguration
- `MediathekEntry` – Ein Mediatheken-Video
- `AppConfig` – App-Konfiguration

Services:
- `M3UParser` – M3U-Playlist → `[TvChannelGroup]`
- `EPGService` – EPG-Ladung (XMLTV/JSON), aktor-basiert, mit Cache
- `PlayerService` – AVPlayer-Management (`@Observable`)
- `MediathekService` – API-Abruf für ARD/ZDF/arte

### tvOS Views (`Sources/StreamingHubTV/`)
- `ContentView.swift` – TabView (TV/EPG/Mediathek/Verlauf) + MiniPlayer
- `ChannelListView.swift` – Senderliste mit Suche
- `EPGView.swift` – 7-Tage-EPG
- `PlayerView.swift` – Fullscreen-Player + PiP
- `MediathekView.swift` – API-basierte Mediatheken
- `HistoryView.swift` – Datumsgruppierter Verlauf

### iOS Views (`Sources/StreamingHubiOS/`)
Gleiche Struktur wie tvOS, aber iOS-optimiert (Touch, NavigationStack, TabView kompakter).

### Nächste Schritte iOS/tvOS
Die Apps sind als **SwiftUI-Skelette** angelegt, aber noch nicht buildbar (es fehlen Xcode-Projekt-Dateien, die erst auf macOS via `xed .` oder `xcodegen` generiert werden müssen). Konkrete Todos:
1. `xed .` auf macOS im jeweiligen Repo-Ordner
2. Target auswählen und builden
3. Echte TV-Quellen und M3U-URLs konfigurieren
4. Mediatheken-API-Parsing implementieren (`parseResponse` in `MediathekService.swift` ist Platzhalter)
5. PiP-Integration für tvOS (AVPictureInPictureController)
6. Hintergrundwiedergabe iOS

## typed-core (beide Phasen abgeschlossen)

Liegt unter `packages/typed-core/` im Desktop-Repo.
- **TypeScript-Package** mit Datenmodellen (`types.ts`) + Logik aus dem Desktop-App-Kern
- **Module**:
  - `types.ts` – Alle Datenmodelle (aufgeräumt, an renderer.js-Datenformat angepasst)
  - `config.ts`, `history.ts`, `services.ts`, `tvsources.ts`, `updater.ts` – bestehende Logik
  - `format.ts` – Utility-Funktionen: `escapeHtml`, `decodeEntities`, `normalizeUrl`, `formatTimestamp`
  - `epg.ts` – EPG-Logik: `parseEpgTime`, `formatEpgTime`, `buildEpgIndex`, `getEpgChannelList`, `findCurrentEpg`
  - `tv.ts` – TV-Logik: `getMediathekForChannel`, `normalizeTvId`, `isFavorite`, `filterChannels`, `groupChannels`, `separateFavorites`, `buildChannelList`, `getNextChannelId`, `applyChannelOverrides`, `applySortOrder`
- **Tests**: 33 Tests, alle grün (vitest)
- **Build**: `npm run build` (tsc) + `npm run build:schemas` (ts-json-schema-generator, 43 Typen)
- **npm Workspace**: im Root als `"workspaces": ["packages/typed-core"]` eingetragen
- **Import**: `require('@streaming-hub/typed-core')` und `require('@streaming-hub/typed-core/schemas.json')` funktionieren
- **renderer.js**: Nutzt jetzt typed-core per `require('@streaming-hub/typed-core')` – wird per esbuild in `dist/renderer.js` gebündelt. Duplizierte Funktionen (`escapeHtml`, `parseEpgTime`, `buildEpgIndex`, etc.) wurden aus renderer.js entfernt.
- **Build-Script**: `npm run build:renderer` (esbuild) / `npm run build:all` (typed-core + renderer)
- **index.html**: Lädt nur noch `dist/renderer.js` (ein Skript statt vorher logger.js + renderer.js)

## Wichtige technische Details

- **Host**: Linux 7.0.11-1-cachyos
- **User**: keks
- **Home**: /home/keks
- **Python**: 3.14.5, kein pip, uv vorhanden
- **Git-Config**: user.email=kekskarlo@users.noreply.gitea.home, user.name=kekskarlo
- **Sprache**: Deutsch (User erwartet deutsche Antworten, präzise und handlungsorientiert)
- **Neue Skills/Workflows bitte als Skill speichern** (nicht nur in Memory)

## Offene Aufgaben (Priorität)

1. ~~**typed-core aufsetzen** (Build-Pipeline, Tests, Workspace)~~ ✅
2. ~~**typed-core: Datenlogik aus renderer.js extrahieren**~~ ✅
3. ~~**renderer.js: Bundler einrichten (esbuild)**~~ ✅
4. ~~**v0.4.28–30: Releases + Bugfixes**~~ ✅
5. **CI/CD-Pipeline aktualisieren** – typed-core-Build + Tests in `.gitea/workflows/build.yaml` einbauen
6. **main.js auf typed-core migrieren** – duplizierte Logik (`parseM3U`, `parseEPG`, `loadServices`) durch typed-core-Importe ersetzen
7. **Mediatheken-API anbinden** – ARD/ZDF/arte HLS-Endpunkte recherchieren, Parsing in typed-core, Swift-Seite vorbereiten
8. **iOS/tvOS buildbar machen** – Xcode-Projekt via `xcodegen` generieren (benötigt macOS)
9. **Desktop: renderer.js weiter entkoppeln** – `switchTvChannel`, `reorderChannel`, `renderEpg` enthalten noch inline Datenlogik
10. **Desktop-Dev-Mode** – esbuild watch mode statt Neubau bei jedem Start

## Ansprechpartner / Quellen

- Alles in Gitea: http://192.168.4.105:3000/kekskarlo/
- Desktop-Code: `/home/keks/Dokumente/opencode/Streaming-Hub`
- Token für Gitea-API: `bb665c643de4087e4221e640c0ca204333288b68`
