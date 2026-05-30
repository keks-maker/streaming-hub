# Changelog

## 0.4.0 (2026-05-30)
- Feature: ARD Mediathek, ZDF Mediathek, ARTE als neue Dienste integriert
- Feature: Nav-Leiste in Gruppen eingeteilt – LiveTV | Streaming | Mediatheken
- New: Gruppen-Label („LiveTV", „Streaming", „Mediatheken") + Divider zwischen Gruppen
- New: `group`-Feld in services.json (streaming/mediathek), rückwärtskompatibel

## 0.3.9 (2026-05-26)
- Fix: EPG im TV-Player wird jetzt alle 30s aktualisiert (Sendungswechsel erkannt)
- Technical: sendEpgUpdate in renderer.js, updateEpgBar + Polling in tv.html
- Version bump auf 0.3.9

## 0.3.8 (2026-05-26)
- Change: EPG-Schrift im TV-Player auf 56px verdoppelt (epg-next auf 40px)
- Version bump auf 0.3.8

## 0.3.7 (2026-05-26)
- Fix: Kanalwechsel per Pfeiltasten beendet nicht mehr das Vollbild (postMessage statt page-reload)
- Fix: Kanalwechsel-Reihenfolge folgt jetzt der Sidebar-Anzeige (sortOrder), nicht dem favorites-Array

## 0.3.6 (2026-05-26)
- Change: TV-UI – Schriftgrößen/Skalierung per vh statt px (besser auf verschiedenen Bildschirmen)
- Change: Kanalwechsel im Vollbild jetzt auch über Pfeiltasten links/rechts (neben Mausrad)
- Fix: Favoriten-Channels werden beim Wechseln priorisiert
- Version bump auf 0.3.6

## 0.3.5 (2026-05-26)
- Fix: install.sh – workaround für npm hänger bei extract-zip mit Node.js 26 (--foreground-scripts)
- Version bump auf 0.3.5

## 0.3.4 (2026-05-26)
- Change: Update-Button blendet sich wie andere Buttons mit aus (opacity/scale)
- Change: TV-Icon durch PNG-Icon (icons8-retro-tv) ersetzt
- Fix: Alte `.tv-btn`-CSS-Regeln aus styles.css entfernt (dead code)

## 0.3.4 (2026-05-22)
- Change: Update-Button blendet sich wie andere Buttons mit aus (opacity/scale)
- Change: TV-Icon durch PNG-Icon (icons8-retro-tv) ersetzt
- Fix: Alte `.tv-btn`-CSS-Regeln aus styles.css entfernt (dead code)

## 0.3.3 (2026-05-22)
- Change: Update-Button immer sichtbar – grüner Haken (aktuell), roter Pfeil+Puls (Update)
- Change: TV-Button aus Leiste entfernt → als erstes Icon in der Navigationsleiste (wie Dienste-Icons)
- Version bump auf 0.3.3

## 0.3.2 (2026-05-22)
- New: Backup/Restore für Settings (Dienste, TV-Quellen, Verlauf) – Zahnrad-Button in der Leiste
- Version bump auf 0.3.2

## 0.3.1 (2026-05-22)
- Fix: `start.sh` löst Symlink auf (readlink -f), damit Aufruf über `~/.local/bin/streaming-hub` funktioniert
- New: Autoupdate-Infrastruktur – updater.js (Git-Fork) + Gitea-API (AppImage)
- New: install.sh – One-Line-Installer (curl | bash) mit Dependency-Prüfung
- Version bump auf 0.3.1

## 0.3.0 (2026-05-22)
- Feature: Live-TV-Integration – M3U-Playlists laden und daraus streamen
- Feature: TV-Sidebar mit Sendersuche, Quellenverwaltung und EPG-Anzeige
- Feature: Eingebauter HLS-Player (tv.html) mit Play/Pause, Lautstärke, Vollbild, Audiospuren
- Feature: EPG (Electronic Program Guide) – XMLTV-Parsing mit aktueller Sendungsinfo
- Feature: Channel-Editor – Sender umbenennen, URL/Logo/Gruppe bearbeiten
- Feature: TV-Quellen-Verwaltung (M3U-URL, lokale Datei, EPG-URL, Farbe)
- Feature: Tastaturkürzel `Strg+T` – TV-Sidebar umschalten
- Feature: `autoplay-policy: no-user-gesture-required` für nahtlose TV-Wiedergabe
- New: `tv.html` – eigenständiger HLS-Player für TV-Streams
- New: `tvsources.json` – persistente TV-Quellen-Konfiguration
- Fix: PiP erkennt jetzt TV-Stream-URLs (`.m3u8`, `.mpd`, `.ts`) und lädt TV-Player
- Version bump auf 0.3.0

## 0.2.8 (2026-05-21)
- Fix: History pollt jetzt `navigator.mediaSession?.metadata?.title` via `webview.executeJavaScript` alle 3s (funktioniert mit contextIsolation)
- Fix: contextBridge-Ansatz verworfen (unbrauchbar mit contextIsolation im webview)
- preload-content.js: auf Original zurückgesetzt (nur Anti-Detection + Keyboard)
- Version bump auf 0.2.8

## 0.2.7 (2026-05-21)
- Fix: History erfasst jetzt echte Medientitel via `navigator.mediaSession.metadata` (Injection in preload-content.js)
- Fix: `page-title-updated` entfernt (fing nur Dienstnamen, keine Inhalte)
- Feature: contextBridge `__mediaBridge` für Kommunikation Injected Script → main process
- Verbesserung: polling alle 2s + bei `play`-Event auf Video-Elementen
- Version bump auf 0.2.7

## 0.2.6 (2026-05-21)
- Feature: Verlauf der zuletzt abgespielten Inhalte (Titel, Dienst, Datum/Uhrzeit)
- Feature: Uhr-Icon in der Overlay-Bar öffnet mittiges History-Overlay
- Feature: `Strg+H` – Verlauf öffnen/schließen
- Fix: Escape schließt jetzt auch History-Overlay
- Version bump auf 0.2.6

## 0.2.5 (2026-05-21)
- Feature: Media Session API – globale Medientasten (Play/Pause, Next, Previous, Stop)
- Feature: Tastaturkürzel dauerhaft auf dem Startbildschirm sichtbar
- Fix: HardwareMediaKeyHandling nicht mehr deaktiviert (wurde von disable-features blockiert)
- Version bump auf 0.2.5

## 0.2.4 (2026-05-21)
- Feature: Dienst-Liste mit Entfernen-Button im Modal
- Feature: Tastaturkürzel (Strg+Tab, Strg+P, F11, Escape, ?)
- Feature: Shortcuts-Übersicht per `?` (halbtransparentes Overlay)
- Fix: Escape schließt Modal/Overlay auch bei fokussierten Inputs
- Refactor: Hardcodierte nav-icon/active-CSS entfernt (dynamisch generiert)

## 0.2.3 (2026-05-21)
- Feature: Dienste aus services.json (external config, nicht mehr hartcodiert)
- Feature: Eingabemaske zum Hinzufügen eigener Streamingdienste (Name, URL, Icon, Farbe)
- Feature: Dynamische Nav-Generierung aus services.json
- Feature: IPC-Handler für CRUD auf services.json
- Fix: Dynamische Styles für Dienste-Farben im Document-Head (nicht in Buttons)

## 0.2.2 (2026-05-21)
- Fix: `process.platform` in renderer.js per contextBridge exposed (Runtime-Error behoben)
- Fix: `--no-sandbox` nur noch aktiv wenn Chrome-Widevine-Fallback verwendet wird
- Fix: `did-navigate`-Listener aktualisiert jetzt die Standort-Anzeige
- Fix: `makePlugin`-Funktion entfernt (dead code)
- Fix: `var` → `let/const` in preload-content.js
- Fix: Welcome-Screen-Logos werden jetzt dynamisch generiert (keine Inline-Styles mehr)
- Fix: Dead `.bg-logo:hover`-CSS-Regel entfernt (blockiert durch `pointer-events: none`)
- Fix: `closeWindow`/`minimizeWindow`-IPC entfernt (nicht verwendet + Sicherheit)
- Fix: `ipcRenderer.on`-Listener mit Cleanup-Funktion
- Fix: Hard-coded Node.js-Pfade in start.sh entfernt
- Fix: Doppelte CSS-Werte in pip.html konsolidiert (nutzt jetzt styles.css-Variablen)
- Fix: `npx electron .` → `npm start` in start.sh/start.cmd
- Fix: README.md aktualisiert (Struktur + PiP-Feature)
- Version bump auf 0.2.2

## 0.2.1 (2026-05-19)
- Cross-Plattform: macOS & Windows Build-Targets in package.json hinzugefügt
- Cross-Plattform: Widevine-Pfad (main.js) sucht jetzt automatisch auf Linux, macOS und Windows
- Cross-Plattform: `--no-zygote` nur noch unter Linux
- Cross-Plattform: `platform` in preload-content.js dynamisch (Linux/macOS/Windows)
- Cross-Plattform: start.sh mit POSIX-kompatiblem Pfad (auch macOS)
- Windows: start.cmd für direkte Ausführung hinzugefügt
- macOS: Build als `.zip` (portabel, keine Installation)
- Windows: Build als portable `.exe` (keine Installation)
- Fix: postinstall-Script lädt Castlabs-Electron-Binary nach `npm install` herunter
- Fix: User-Agent in renderer.js dynamisch pro Plattform (Linux/macOS/Windows)
- Fix: PiP-Webview in pip.html lädt jetzt preload-content.js (fehlendes Spoofing)
- Fix: try/catch um Chrome-Widevine-Manifest-Parsing (main.js)
- Fix: asar: true für verschlüsselte Builds (Sicherheit)
- Fix: package-lock.json wieder im Repository (reproduzierbare Builds)
- Fix: Zusätzliche Chromium/Brave/Edge-Widevine-Pfade (main.js)
- Fix: Windows LOCALAPPDATA-Fallback auf USERPROFILE
- Cleanup: toolbar toter Code entfernt (index.html, styles.css, renderer.js)
- Cleanup: setup-castlabs.js entfernt (kaputter Paket-Check)
- Cleanup: bak_disney.png entfernt (unbenutzt)
- Cleanup: .gitignore – überflüssige Negationen entfernt

## 0.1.11 (2026-05-18)
- Google-Login-Fix: --disable-blink-features=AutomationControlled
- chrome.runtime, chrome.loadTimes(), chrome.csi(), chrome.app via executeJavaScript injiziert
- navigator.webdriver im page context überschrieben
- User-Agent auf Chrome 134 aktualisiert

## 0.1.10 (2026-05-18)
- Picture-in-Picture-Modus (Mini-Player-Fenster)
- Neues pip.html mit Webview + Close-Button + Titelzeile
- PiP-Button in der Overlay-Bar (sichtbar bei Hover)
- Immer im Vordergrund, gleiche Session (persist:streaming)
- Automatische 16:9-Berechnung der Fenstergröße

## 0.1.9 (2026-05-18)
- Farbiger Strich (5px dick, 120px breit) am unteren Rand der Overlay-Bar
- Farbverlauf in Akzentfarbe (purple), immer sichtbar

## 0.1.8 (2026-05-18)
- Startseite: Logos auf 120px vergrößert (mind. doppelt), opacities auf .18–.25 erhöht
- Text auf 28px vergrößert (doppelt)
- Pfeil: Stroke 4px, weiße Farbe mit Farbverlauf für besseren Kontrast
- Arrow-Wrap auf 180px Höhe vergrößert

## 0.1.7 (2026-05-18)
- Startseite: Logos vergrößert (56px) und heller (opacity .13–.18)
- Startseite: Pfeil + Text nach oben unter die Overlay-Leiste verschoben
- Pfeil-SVG gestrafft, Text als kompakte Glas-Kapsel

## 0.1.6 (2026-05-18)
- Startseite: vollflächiger Logo-Hintergrund (20 Logos verteilt, gedreht, schwebend)
- Startseite: großer animierter Pfeil von unten nach oben zur Leiste
- Startseite: Hinweistext mit Glas-Effekt am unteren Rand
- Float-Animation für Logos, Puls-Animation für Pfeil

## 0.1.5 (2026-05-18)
- Startseite: Logos der Streaminganbieter als dekoratives Raster
- Startseite: Hinweistext "Hier kannst du einen Streamingdienst mit der Maus auswählen."
- Startseite: Animierter Pfeil zeigt Richtung Overlay-Bar
- Alten Willkommensbildschrim (Icon + Überschrift) entfernt

## 0.1.4 (2026-05-18)
- Native OS-Fensterleiste wieder aktiviert (close/minimize/maximize)
- Standort-Text immer sichtbar (nicht nur bei Hover)

## 0.1.3 (2026-05-18)
- Toolbar (URL-Leiste + Nav-Buttons) standardmäßig ausgeblendet
- Standort-Anzeige in der Overlay-Bar (linke Seite): Startseite / Netflix / YouTube usw.

## 0.1.2 (2026-05-18)
- Webview statt BrowserView implementiert
- Overlay-Bar immer kompakt (24px), vergrößert sich bei Hover
- Fullscreen-Button entfernt
- Navigation (Zurück/Vor/Neu laden) läuft direkt über Webview-API
- Preloads und IPC verschlankt, überflüssige Handler entfernt

## 0.1.1 (2026-05-18)
- GPU-Beschleunigung aktiviert (--disable-gpu Flags entfernt)
- Doppelte CSS-Regeln entfernt
- Unbenutzten IPC-Channel navigate-overlay entfernt
- Harte Pfade in start.sh korrigiert
- app.html gelöscht (unbenutzt)
- app.html aus README-Projektstruktur entfernt

## 0.1.0 (2026-05-18)
- Node.js 22 installiert
- PATH in .bashrc und start.sh gesetzt
- npm-Abhängigkeiten installiert
- Desktop-Starter erstellt
