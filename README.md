# Streaming Hub

Zentrale Streaming-Anwendung mit Widevine-DRM-Unterstützung über Castlabs Electron. Bündelt beliebte Streaming-Dienste in einer einheitlichen Oberfläche.

## Unterstützte Dienste

| Dienst | URL |
|---|---|
| Netflix | https://www.netflix.com |
| YouTube | https://www.youtube.com |
| Disney+ | https://www.disneyplus.com |
| Prime Video | https://www.primevideo.com |
| Twitch | https://www.twitch.tv |
| Spotify | https://open.spotify.com |

## Funktionen

- **Dienst-Navigation** – Icon-Leiste zum schnellen Wechseln; erscheint bei Hover auf der kompakten Leiste
- **Browser-Navigation** – Zurück, Vorwärts und Neu-laden über Webview-API
- **Compact-Overlay** – Leiste standardmäßig 24px, expandiert bei Hover auf 64px
- **Draggable Titlebar** – Fenster per Leiste verschiebbar
- **Widevine DRM** – Castlabs Electron mit VMP-Support (Netflix, Disney+, Prime Video)
- **Chrome Widevine Fallback** – Nutzt `/opt/google/chrome/WidevineCdm/` falls vorhanden
- **Custom User-Agent** – Chrome-identischer User-Agent
- **Session-Persistenz** – Persistente Partition (`persist:streaming`)
- **Permission-Handling** – Automatische Freigabe für Medien- und DRM-Anfragen
- **Willkommensbildschirm** – Logo-Hintergrund, animierter Pfeil, Hinweistext
- **Dark-UI** – Glasmorphismus mit anbieter-spezifischen Akzentfarben

## Voraussetzungen

| Abhängigkeit | Version |
|---|---|
| **Node.js** | >= 22.12 |
| **npm** | (kommt mit Node.js) |
| **electron** (castlabs) | `v42.0.0+wvcus` |

## Installation

```bash
cd /home/keks/Dokumente/opencode/Streaming-Hub
npm install
```

## Starten

```bash
./start.sh
# oder
npm start
```

## Projektstruktur

```
Streaming-Hub/
├── main.js              # Electron-Hauptprozess (Fenster, DRM)
├── preload.js           # Preload für Hauptfenster
├── preload-content.js   # Preload für Webview-Inhalte
├── renderer.js          # UI-Logik, Webview-Steuerung
├── index.html           # Haupt-UI
├── styles.css           # Dark-UI, Animationen
├── start.sh             # Startskript
├── package.json         # Abhängigkeiten
├── CHANGELOG.md         # Versionshistorie
├── setup-castlabs.js    # Castlabs-Einrichtungshilfe
└── assets/
    ├── icons/           # Dienst-Icons
    └── icon.svg         # App-Icon
```

## Lizenz

MIT
