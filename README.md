# Streaming Hub

Zentrale Streaming-Anwendung mit Widevine-DRM-Unterstützung über Castlabs Electron. Bündelt Streaming-Dienste, Mediatheken und Live-TV in einer einheitlichen Oberfläche. Der Installer unterstützt Linux x86_64 sowie macOS auf Intel- und Apple-Silicon-Macs.

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

- **Start-Dashboard** – Schnellzugriff auf Live-TV, Streaming-Dienste, Mediatheken und Einstellungen
- **Live-TV-Dashboard** – Sender-Kacheln, Favoriten, EPG-Status und aktuell laufende Sendungen
- **Senderverwaltung** – M3U-Quellen, Suche, Favoriten, Sortierung und Channel-Editor
- **EPG (Electronic Program Guide)** – XMLTV-Parsing mit Vollbild-Overlay, Favoriten-Ansicht und Zeitslots (2/4/8/12/24h)
- **DVR-Timeshift** – Bei unterstützten Live-Streams Sendungen zurückspulen und per EPG-Marker direkt anspringen
- **Mediathek-Integration** – ARD/ZDF/arte-Suche via MediathekViewWeb-API
- **Picture-in-Picture** – Schwebe-Fenster für paralleles Streamen (auch TV-Streams)
- **Browser-Navigation** – Zurück, Vorwärts und Neu-laden über Webview-API
- **Kompakte Navigationsleiste** – Erweitert sich bei Hover
- **Verschiebbare Titelleiste** – Fenster per Leiste verschieben
- **Widevine DRM** – Castlabs Electron mit VMP-Support (Netflix, Disney+, Prime Video)
- **Chrome-Widevine-Fallback** – Nutzt ein vorhandenes Widevine-CDM von Chrome, abhängig vom Betriebssystem
- **Custom User-Agent** – Chrome-identischer User-Agent (dynamisch via `process.versions.chrome`)
- **Session-Persistenz** – Persistente Partitionen (`persist:streaming`, `persist:tv`)
- **Permission-Handling** – Automatische Freigabe für Medien- und DRM-Anfragen
- **Dark-UI** – Glasmorphismus mit anbieter-spezifischen Akzentfarben
- **Plattform-Icons** – Eigenes App- und Dock-Icon auf macOS
- **Auto-Update** – Git-basiertes Update-System
- **Backup/Restore** – Einstellungen, Dienste, TV-Quellen und Verlauf sichern/wiederherstellen
- **Tastaturkürzel** – Strg+T (TV), Strg+H (Verlauf), Strg+P (PiP), F11 (Vollbild)
- **typed-core Package** – TypeScript-Datenlogik (M3U-Parsing, EPG, TV-Channel) mit Unit-Tests

## Voraussetzungen

| Voraussetzung | Unterstützung |
|---|---|
| **Node.js** | >= 22.12 |
| **npm** | Kommt mit Node.js |
| **Castlabs Electron** | `v42.0.0+wvcus` |
| **Linux** | x86_64; Paketmanager apt, dnf, pacman oder zypper |
| **macOS** | Intel (x64) und Apple Silicon (arm64) |

## Installation

Unter Linux und macOS erkennt der Installer Betriebssystem und Architektur automatisch:

```bash
curl -fsSL https://raw.githubusercontent.com/keks-maker/streaming-hub/main/install.sh | bash
```

Unter Linux wird die App standardmäßig nach `~/.local/share/streaming-hub` installiert und im Anwendungsmenü eingetragen. Unter macOS liegen die App-Dateien standardmäßig in `~/Library/Application Support/Streaming Hub`; das native App-Bundle für Finder und Dock wird unter `~/Applications/Streaming Hub.app` installiert. Ein abweichender Installationspfad kann über `INSTALL_DIR` gesetzt werden.

Der Installer kann Node.js unter Linux über den jeweiligen Paketmanager installieren. Auf macOS nutzt er Homebrew, falls Node.js fehlt oder zu alt ist und Homebrew bereits installiert ist

Homebrew-Installation (https://brew.sh/):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Andernfalls müssen Node.js und npm vorher installiert sein. Windows wird von `install.sh` nicht unterstützt.

### macOS-Release-Layout und Signaturprüfung

Neue GitHub-macOS-ZIPs werden mit `asar: false` gebaut. Ihr Inhalt ist deshalb
`Streaming Hub.app/Contents/Resources/app/` als echtes Verzeichnis; das entspricht
dem Checkout-Installer und dem In-App-Updater (`Contents/Resources/app`). Bereits
veröffentlichte 0.5.x-ZIPs mit `app.asar` werden von Installer und Updater per
`@electron/asar` in dasselbe Verzeichnislayout entpackt. Der Installer baut
Wrapper und Plist zunächst in einem Staging-Bundle und ersetzt die bestehende
Installation erst nach erfolgreicher EVS- oder `codesign`-Prüfung.
Fehlt EVS, ist `codesign` nicht verfügbar oder schlägt die finale Prüfung fehl,
bricht der Installer ab und lässt den bisherigen Stand unverändert.

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
├── install.sh           # Installer (Linux/macOS)
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
    ├── screenshots/     # Aktuelle UI-Screenshots
    ├── icon.svg         # Vektor-App-Icon
    ├── icon.png         # App- und Dock-Icon
    └── icon.icns        # macOS-App-Icon
```

## Bedienung

### Startseite

Die Startseite bündelt die vier Bereiche Live-TV, Streaming, Mediatheken und Einstellungen. Wähle eine Kachel, um den Bereich zu öffnen.

![Start-Dashboard der Version 0.4.84](assets/screenshots/startseite.png)

### Navigationsleiste

In den Bereichen erscheint die Navigationsleiste am oberen Bildschirmrand. Sie wechselt zwischen Live-TV, Streaming, Mediatheken und Einstellungen.

![Navigationsleiste und Streaming-Dashboard, Version 0.4.84](assets/screenshots/navbar.png)

### Streaming-Dienste nutzen

Nach dem Klick auf einen Dienst wird die Webseite im Hauptbereich geladen. Deine Login-Daten und Sessions werden gespeichert – du musst dich nur einmal anmelden.

### Live-TV

#### Live-TV-Dashboard öffnen

Wähle in der Navigationsleiste **LiveTV**. Das Dashboard zeigt geladene Sender als Kacheln, Favoriten sowie die aktuelle EPG-Programmübersicht. Über **Alle Sender** öffnest du die Senderverwaltung.

![Live-TV-Dashboard, Version 0.4.84](assets/screenshots/livetv-dashboard.png)

#### Sender verwalten

Die Senderverwaltung bietet eine Suche, getrennte Ansichten für alle Sender und Favoriten sowie Sortierung und Senderbearbeitung.

![Senderverwaltung, Version 0.4.84](assets/screenshots/tv-senderverwaltung.png)

#### TV-Quellen verwalten

Öffne **Einstellungen** und wähle **TV-Quellen verwalten**, um TV-Quellen zu pflegen:
- **Quellen-Name** – z.B. "Deutsche Sender"
- **M3U-URL** – Link zu einer M3U-Playlist (oder lokale Datei über 📁)
- **EPG-URL** (optional) – Link zu einer XMLTV-Datei für Programminformationen
- **Akzentfarbe** – Farbe für die Quellen-Kennzeichnung

Eine vorkonfigurierte Quelle (Deutsche Öffentlich-Rechtliche) ist bereits enthalten.

#### Sender auswählen

Klicke eine Sender-Kachel im Live-TV-Dashboard oder einen Eintrag in der Senderverwaltung an, um den Stream zu starten. Die Senderverwaltung lässt sich über **Alle Sender** öffnen und bietet Suche sowie Gruppen.

#### Favoriten

Klicke in der Senderverwaltung auf den Stern (☆), um einen Sender als Favorit zu markieren. Im Tab **Favoriten** kannst du die Favoriten separat ansehen und sortieren.

#### Favoriten sortieren

Öffne in der Senderverwaltung den Tab **Favoriten**, wähle **Reihenfolge bearbeiten** und verschiebe Sender per Drag & Drop. Die Sortierung wird gespeichert.

#### Kanalwechsel im TV-Modus

Im laufenden TV-Stream kannst du die Sender wechseln:
- **Pfeiltasten hoch/runter** – nächster/vorheriger Sender

Beim Wechsel erscheint kurz ein Kanal-Overlay mit dem aktuellen Sender und den umgebenden Kanälen (inkl. EPG-Info).

#### TV-Player Steuerung

Bewege die Maus, um die Steuerungs-Overlays einzublenden:

**Oben links:** Sendername + Logo

**Unten:** Komplette Player-Steuerung:
- **EPG-Leiste** – Aktuelle Sendung mit Uhrzeit
- **DVR-Leiste** – Sendungsmarker anklicken, zurückspulen oder mit `L` zur Live-Kante springen (bei unterstützten Streams)
- **Play/Pause** – Button oder `Leertaste` / `K`
- **Lautstärke** – Slider oder `+` / `-`
- **Stumm** – Button oder `M`
- **Audiospur** – Dropdown bei Sendern mit mehreren Tonspuren
- **Vollbild** – Button oder `F`

#### Sender bearbeiten (Channel-Editor)

Öffne in den Einstellungen **Sender bearbeiten**, um den Channel-Editor aufzurufen:
- **Name** – Anzeigename des Senders
- **URL** – Stream-URL überschreiben
- **tvg-id** – Zuordnung für EPG-Daten (mit Autovervollständigung aus EPG-Quellen)
- **Logo-URL** – Senderlogo überschreiben

Die Änderungen werden pro TV-Quelle gespeichert und sind sofort aktiv.

### EPG – Programmübersicht

Klicke im Live-TV-Dashboard auf **EPG öffnen**, um die vollständige Programmübersicht aufzurufen.

![EPG-Programmübersicht, Version 0.4.84](assets/screenshots/epg-uebersicht.png)

Die EPG-Ansicht zeigt:
- **Zeitleiste** – Alle Favoriten-Sender mit Sendungen als Balken
- **Jetzt-Linie** – Vertikale Linie für die aktuelle Uhrzeit
- **Zeitslots** – Wähle 2h, 4h, 8h, 12h oder 24h Ansicht

Klicke auf eine Sendung für Details:
- **Sender öffnen** – Sender direkt starten
- **In Mediathek ansehen** – Sendung in ARD/ZDF/arte Mediathek suchen (falls verfügbar)

![EPG-Sendungsdetails mit Aktionen, Version 0.4.84](assets/screenshots/epg-sendung.png)

### Mediathek-Suche

Aus der EPG-Übersicht kannst du Sendungen direkt in den Mediatheken suchen. Der Button "In Mediathek ansehen" öffnet den entsprechenden Dienst (ARD, ZDF oder ARTE) mit dem Sendungstitel als Suchbegriff.

### Verlauf

Klicke auf das Uhr-Icon in der Navigationsleiste oder drücke `Strg+H`, um den Verlauf zu öffnen. Er zeigt die zuletzt abgespielten Inhalte mit Titel, Dienst und Zeitstempel.

Ein Klick auf einen Eintrag springt direkt zum entsprechenden Dienst oder TV-Sender. Mit "Löschen" kannst du den gesamten Verlauf leeren.

![Wiedergabeverlauf, Version 0.4.84](assets/screenshots/verlauf.png)

### Einstellungen

Klicke auf das Zahnrad-Icon in der Navigationsleiste, um die Einstellungen zu öffnen.

![Einstellungen mit Diensteverwaltung und TV-Modus, Version 0.4.84](assets/screenshots/settings.png)

#### Backup & Restore
- **Backup erstellen** – Speichert Dienste, TV-Quellen und Verlauf als Datei
- **Backup einspielen** – Stellt ein vorheriges Backup wieder her

#### Dienste verwalten
- **Dienste hinzufügen** – Eigene Streaming-Dienste oder Mediatheken hinzufügen (Name, URL, Icon, Farbe, Gruppe)
- **Dienste entfernen** – Dienste mit dem ×-Button entfernen

#### TV-Modus
- **FreeTV** – TV-Button öffnet die Sidebar mit eigenen M3U-Sendern
- **MagentaTV** – TV-Button öffnet web.magentatv.de im Webview

### Tastaturkürzel

Drücke `?` für eine Übersicht aller Kürzel:

| Kürzel | Funktion |
|---|---|
| `Strg` + `Tab` | Nächster Dienst |
| `Strg` + `Umsch` + `Tab` | Vorheriger Dienst |
| `Strg` + `H` | Verlauf anzeigen |
| `Strg` + `T` | TV-Sidebar umschalten |
| `Strg` + `P` | Bild-in-Bild umschalten |
| `F11` | Vollbild umschalten |
| `?` | Kürzel-Übersicht |
| `Escape` | Modal / Overlay schließen |

**Im TV-Player zusätzlich:**

| Kürzel | Funktion |
|---|---|
| `Leertaste` / `K` | Play / Pause |
| `F` | Vollbild |
| `M` | Stumm schalten |
| `←` / `→` | 10s zurück / vor |
| `L` | Zur Live-Kante springen (DVR-Streams) |
| `+` / `-` | Lautstärke hoch / runter |

### Auto-Update

Der Update-Button in der Navigationsleiste zeigt den Status:
- **Grüner Haken** – App ist aktuell
- **Roter Pfeil (pulsierend)** – Update verfügbar

Klicke auf den Button, um das Update zu starten. Die App lädt die neue Version herunter und startet automatisch neu.

## E2E-Tests

Playwright-Smoke-Test der Desktop-App (`e2e/smoke.spec.js`), gestartet über `_electron.launch()` mit dem Castlabs-Electron aus `node_modules` — es wird kein Browser heruntergeladen (bei der Installation optional `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

```bash
npm run test:e2e                                   # electron . (Standard)
E2E_APP_PATH="release/mac-arm64/Streaming Hub.app" npm run test:e2e   # gegen das gepackte Artefakt
```

- Prüft: Hauptfenster + Kern-DOM, keine uncaught Exceptions/Konsolen-Errors beim Start (bekannte harmlose Meldungen stehen kommentiert in `KNOWN_HARMLESS`), Favoriten-UI (LiveTV → Alle Sender → Favoriten) und Aufnahmen-Einstieg (Dashboard + Speicherort-Einstellung).
- Isoliert: `userData` und `HOME` liegen in einem Temp-Verzeichnis (Env `STREAMING_HUB_USER_DATA`, siehe `main.js`), das Netz ist gesperrt, der Updater wird nie ausgelöst. Echte Nutzerdaten werden nicht berührt; ein Build ohne diesen Hook (zu alt) wird vor dem Start abgelehnt.
- `E2E_APP_PATH` akzeptiert eine `.app` (macOS) oder eine ausführbare Datei; ohne Variable läuft `electron .`.
- Läuft bewusst nicht in `npm test` (braucht ein Display und startet echte Electron-Prozesse).

## Lizenz

MIT
