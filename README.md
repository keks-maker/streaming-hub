# Streaming Hub

Zentrale Streaming-Anwendung mit Widevine-DRM-Unterstützung über Castlabs Electron. Bündelt beliebte Streaming-Dienste in einer einheitlichen Oberfläche.

## Unterstützte Dienste

### Streaming
| Dienst | URL |
|---|---|
| Netflix | https://www.netflix.com |
| YouTube | https://www.youtube.com |
| Disney+ | https://www.disneyplus.com |
| Prime Video | https://www.primevideo.com |
| Twitch | https://www.twitch.tv |
| Spotify | https://open.spotify.com |

### Mediatheken
| Dienst | URL |
|---|---|
| ARD Mediathek | https://www.ardmediathek.de/ |
| ZDF Mediathek | https://www.zdf.de/ |
| ARTE | https://www.arte.tv/de/ |

## Funktionen

- **Dienst-Navigation** – Icon-Leiste mit Gruppen (Streaming/Mediatheken); erscheint bei Hover auf der kompakten Leiste
- **Live-TV** – M3U-Playlists laden, EPG, integrierter HLS-Player mit Sendersuche und Channel-Editor
- **EPG (Electronic Program Guide)** – XMLTV-Parsing mit Vollbild-Overlay, Favoriten-Ansicht, Zeitslots (2/4/8/12/24h)
- **Mediathek-Integration** – ARD/ZDF/arte-Suche via MediathekViewWeb-API
- **Picture-in-Picture** – Schwebe-Fenster für paralleles Streamen (auch TV-Streams)
- **Browser-Navigation** – Zurück, Vorwärts und Neu-laden über Webview-API
- **Compact-Overlay** – Leiste standardmäßig 24px, expandiert bei Hover auf 64px
- **Draggable Titlebar** – Fenster per Leiste verschiebbar
- **Widevine DRM** – Castlabs Electron mit VMP-Support (Netflix, Disney+, Prime Video)
- **Chrome Widevine Fallback** – Nutzt `/opt/google/chrome/WidevineCdm/` falls vorhanden
- **Custom User-Agent** – Chrome-identischer User-Agent (dynamisch via `process.versions.chrome`)
- **Session-Persistenz** – Persistente Partitionen (`persist:streaming`, `persist:tv`)
- **Permission-Handling** – Automatische Freigabe für Medien- und DRM-Anfragen
- **Willkommensbildschirm** – Logo-Hintergrund, animierter Pfeil, Hinweistext
- **Dark-UI** – Glasmorphismus mit anbieter-spezifischen Akzentfarben
- **Auto-Update** – Git-basiertes Update-System mit Gitea-API
- **Backup/Restore** – Einstellungen, Dienste, TV-Quellen, Verlauf sichern/wiederherstellen
- **Tastaturkürzel** – Strg+T (TV), Strg+H (History), Strg+P (PiP), F11 (Fullscreen)
- **typed-core Package** – TypeScript-Datenlogik (M3U-Parsing, EPG, TV-Channel) mit Unit-Tests

## Voraussetzungen

| Abhängigkeit | Version |
|---|---|
| **Node.js** | >= 22.12 |
| **npm** | (kommt mit Node.js) |
| **electron** (castlabs) | `v42.0.0+wvcus` |

## Installation

```bash
curl -fsSL http://192.168.4.105:3000/kekskarlo/Streaming-Hub/raw/branch/master/install.sh | bash
```

## Projektstruktur

```
Streaming-Hub/
├── main.js              # Electron-Hauptprozess (Fenster, DRM, Auto-Update)
├── preload.js           # Preload für Hauptfenster
├── preload-content.js   # Preload für Webview-Inhalte (Anti-Detection)
├── renderer.js          # UI-Logik, Webview-Steuerung (Source)
├── dist/renderer.js     # Gebündelte UI-Logik (esbuild)
├── logger.js            # Strukturiertes Logging
├── updater.js           # Auto-Update via Git/Gitea
├── index.html           # Haupt-UI
├── tv.html              # HLS-TV-Player
├── pip.html             # Picture-in-Picture-Fenster
├── styles.css           # Dark-UI, Animationen
├── start.sh             # Startskript (Linux/macOS)
├── start.cmd            # Startskript (Windows)
├── install.sh           # One-Line-Installer
├── package.json         # Abhängigkeiten + Workspaces
├── CHANGELOG.md         # Versionshistorie
├── services.json        # Streaming-Dienst-Konfiguration
├── tvsources.json       # TV-Quellen-Konfiguration
├── packages/
│   └── typed-core/      # TypeScript-Package (Datenlogik, M3U, EPG, TV)
│       ├── src/         # TypeScript-Source (format.ts, epg.ts, tv.ts, mediathek.ts)
│       ├── dist/        # Kompiliertes JS
│       └── tests/       # Vitest Unit-Tests
├── scripts/
│   ├── build-renderer.js  # esbuild-Bundler
│   └── watch-renderer.js  # Watch-Mode
└── assets/
    ├── icons/           # Dienst-Icons
    └── icon.svg         # App-Icon
```

## Lizenz

MIT
