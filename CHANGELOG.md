# Changelog

## 0.4.42 (2026-06-09)
- Change: Overlay-Bar immer 64px (kein Height-Übergang), Nav/Buttons faden per opacity – "Startseite" wandert nicht mehr
- Fix: TV-Sidebar schließt nach 2s ohne Mauskontakt (Polling via :hover statt Event-Propagation)

## 0.4.41 (2026-06-09)
- Fix: TV-Sidebar schließt bei Klick im Webview (preload-content.js forwarded 'sidebar-close' IPC)

## 0.4.40 (2026-06-09)
- Fix: TV-Sidebar schließt jetzt automatisch bei mouseleave (400ms Delay)

## 0.4.39 (2026-06-09)
- Fix: TV-Overlay erstes Rendering – Container vor Messung sichtbar (offsetHeight=0 bei display:none)

## 0.4.38 (2026-06-09)
- Fix: TV-Overlay – itemHeight jetzt live gemessen (offsetHeight + Margins) statt Hardcode 66px

## 0.4.37 (2026-06-09)
- Fix: TV-Overlay – letztes Item abgeschnitten (Container-Höhe +18px für border-box)
- Fix: Ton stumm bei schnellem Kanalwechsel (Volume/Mute-Zustand bleibt erhalten)

## 0.4.36 (2026-06-09)
- Change: TV-Kanal-Overlay zeigt max. 4 Sender (vorher 7), ausgewählter Sender zentriert

## 0.4.35 (2026-06-09)
- Change: `renderer.js` – `loadTvChannels` nutzt jetzt `applyChannelOverrides` + `applySortOrder` aus typed-core
- Change: `renderer.js` – `renderTvChannels` nutzt `filterChannels`, `groupChannels`, `separateFavorites` aus typed-core
- Fix: Logo-Overrides im Channel-Editor werden jetzt korrekt aufgelöst (Schlüssel `tvgLogo` statt `logo`)
- Change: ~35 Zeilen duplizierte Logik aus renderer.js entfernt

## 0.4.34 (2026-06-09)
- New: typed-core `parseM3UFull()` – M3U-Parser mit EPG-URL-Extraktion + Flat-Channels
- New: typed-core `flattenM3U()` – Channel-Gruppen → flaches Array
- New: `npm run dev:watch` – esbuild watch + Electron Dev-Start (live rebuild)
- New: `npm run watch` – eigenständiger esbuild watch mode
- Note: main.js `parseM3U` bleibt vorerst (ID-Gen unterschiedlich, Risk-Averse Migration)

## 0.4.33 (2026-06-09)

## 0.4.33 (2026-06-09)
- New: typed-core `mediathek.ts` – `buildSearchUrl()`, `parseSearchResponse()` für MediathekViewWeb-API
- New: Typen `MediathekSource`, `MediathekEntry`, `MediathekSearchResult` für ARD/ZDF/arte
- New: 5 Tests für Mediathek-Modul (38 total)

## 0.4.32 (2026-06-09)
- Change: `main.js` nutzt typed-core – `cmpVersions` → `compareVersions`, `cleanChannelName`, `parseEPG` → `parseXMLTV`
- New: typed-core `format.ts` + `cleanChannelName()`, `epg.ts` + `parseXMLTV()`

## 0.4.31 (2026-06-09)
- New: CI/CD-Pipeline – `test-typed-core` Job (Build + 33 Tests) in `.gitea/workflows/build.yaml`
- Change: ESLint Config aufgeräumt (`packages/`, `scripts/` ignoriert, `preload-content.js` eigene Browser-Konfig)
- Fix: Prettier-Formatierung auf allen JS-Dateien
- Fix: `renderer.js` – unbenutzte typed-core-Imports entfernt

## 0.4.30 (2026-06-09)
- Fix: User-Agent auf tatsächliche Chrome-Version (148) aktualisiert – Template per `process.versions.chrome` im Preload, kein Hardcode mehr
- Change: `preload.js` exposed `chromeVersion` für dynamische UA-Generierung

## 0.4.29 (2026-06-09)
- Fix: `renderer.js` – übersehener `buildTvChannelList()`-Aufruf im `did-finish-load` von contentView auf `buildChannelList()` umgestellt

## 0.4.28 (2026-06-09)
- New: `packages/typed-core` – TypeScript-Package mit Datenmodellen + Logik aus renderer.js
- New: `format.ts`, `epg.ts`, `tv.ts` – Datenlogik-Module mit 33 Unit-Tests (vitest)
- New: `npm run build:renderer` – esbuild-Bundler für renderer.js mit typed-core-Imports
- Change: `index.html` lädt jetzt `dist/renderer.js` (gebündelt) statt `logger.js` + `renderer.js`
- Change: Duplizierte Funktionen (`escapeHtml`, `parseEpgTime`, `buildEpgIndex`, etc.) aus renderer.js entfernt, stattdessen typed-core-Importe
- Change: npm Workspace `packages/typed-core` im Root eingetragen
- Change: `prestart`/`predev` baut automatisch typed-core + renderer

## 0.4.27 (2026-06-08)
- Fix: Streaming-Player (Netflix/YouTube) pausieren bei Wechsel zu TV – via `executeJavaScript` werden alle `video/audio`-Elemente gestoppt
- Code-Review: Event-Listener, webview-Referenzen, CSS-Regeln – keine weiteren Querfehler gefunden

## 0.4.26 (2026-06-08)
- Fix: TV-Stream stoppt jetzt beim Verlassen des TV-Modus – `tvView.loadURL('about:blank')` räumt den HLS.js-Stream auf (auch aus IIFE-Scope)
- Fix: `switchWebview()` entfernt `tvViewReady=false` – `did-attach` feuert nur einmalig, sonst bleibt TV-Modus tot

## 0.4.25 (2026-06-08)
- Fix: TV-Player unsichtbar – `switchWebview()` setzt `tvView.style.opacity = '1'` statt `''`
  ('' entfernte nur Inline-Style, CSS-Klasse opacity:0 blieb aktiv)
- Fix: TV-Stream läuft im Hintergrund weiter – `hlsInstance.destroy()` + `video.pause()` beim Verlassen des TV-Modus

## 0.4.24 (2026-06-08)
- Fix: TV-Player unsichtbar – `.tv-view` per CSS ausgeblendet, switchWebview() toggelt jetzt opacity statt display
- Change: Update-Mechanismus: neue Tags werden für Update-Erkennung benötigt

## 0.4.23 (2026-06-08)
- New: `logger.js` – Strukturiertes Logging mit Timestamp, Levels (debug/info/warn/error) und Kontext-Autoerkennung (Node/Browser)
- New: `eslint.config.js` – Migration zu ESLint Flat Config (v10.x), alle JS-Dateien linten sauber
- New: `.gitea/workflows/build.yaml` – CI/CD Pipeline (Lint + Build + Release via Gitea Actions)
- New: Error-Boundary für Webviews – `crashed`, `did-fail-load`, `unresponsive`-Handler mit Error-Overlay + „Neu laden"-Button
- New: Session-Partition – TV-Player (`tvView`) lädt in eigenem `<webview>` mit `partition="persist:tv"`, getrennt vom Streaming-Session (`persist:streaming`)
- Change: `console.*` in `main.js`, `renderer.js`, `updater.js` durch `logger.*` ersetzt
- Change: electron-builder auf `26.15.2` aktualisiert
- Change: eslint + prettier auf aktuellste Version aktualisiert
- Fix: 1 hochgradige npm-Sicherheitslücke (`tmp`) via `npm audit fix` geschlossen
- Housekeeping: `npm run audit` + `npm run outdated` als Scripts in package.json
- Housekeeping: `npm run lint` + `lint:fix` laufen jetzt via Flat Config
- Housekeeping: CHANGELOG v0.4.23 hinzugefügt

## 0.4.21 (2026-06-08)
- Fix: `updater.js` – User-Daten (services.json, tvsources.json, history.json) werden vor Update-Checkout gesichert und wiederhergestellt; Named-Stash via `git stash push`, nur bei tatsächlichen lokalen Änderungen; Nutzer-Hinweis bei Stash-Konflikten
- Fix: `main.js` – `app.relaunch()` startet nun die neue AppImage (`execPath: newAppImage`)
- Fix: `main.js` – `--no-sandbox` wird nur noch bei Nicht-Castlabs-Electron gesetzt (Castlabs-Erkennung via `ELECTRON_CUSTOM_VERSION`)
- Fix: `main.js` – TV-Quellen werden beim Hinzufügen per URL wiedererkannt, Overrides/Favoriten nicht verwaist
- Fix: `renderer.js` – Overrides nach Channel-Editor-Speichern sofort in tvSources aktualisiert (kein Race-Condition mehr)
- Fix: `renderer.js` – structuralChange-Erkennung prüft jetzt auch `channelOverrides`
- Fix: `renderer.js` + `main.js` – Relative Logo-URLs in channelOverrides werden gegen M3U-baseUrl aufgelöst
- Technical: Versionierung: nur Patch-Stelle (dritte Ziffer) wird automatisch erhöht

## 0.4.8 (2026-05-30)
- Change: EPG-Zeilen füllen Bildschirm (max. 7 sichtbar, flex: 1)
- Change: EPG-Schrift vergrößert (Titel 15px, Uhrzeit 12px, Kanal 15px, Logo 40×40)

## 0.4.7 (2026-05-30)
- Fix: `git fetch --tags` mit `--force` in updater.js (schlug fehl bei force-pushed Tags)
- Change: `install.sh` ebenfalls mit `--force` für Tags

## 0.4.6 (2026-05-30)
- Change: Kein Kanal-Overlay beim Senderstart aus EPG (nur noch bei Pfeiltasten)
- Technical: `selectTvChannel()` akzeptiert `options.suppressChannelList`

## 0.4.5 (2026-05-30)
- New: EPG-Programmübersicht für alle Favoriten (Vollbild-Overlay)
- New: Konfigurierbarer Zeitslot (2/4/8/12/24h), aktuelle Uhrzeit zentriert
- New: Jetzt-Linie + aktuelle Sendung hervorgehoben
- New: Detail-Popup mit „Sender öffnen" + „In Mediathek ansehen"
- New: Hervorgehobener EPG-Button in der TV-Seitenleiste
- New: Mediathek-Mapper (ARD/ZDF/Arte) für Programmlinks
- Technical: EpgView-Funktionen + CSS-Grid + Detail-Modal

## 0.4.4 (2026-05-30)
- Change: Overlay-Bar auf Startseite immer sichtbar (expanded + alle Icons sichtbar)
- Change: Bar klappt erst nach Auswahl eines Dienstes/TV ein (always-visible-Klasse)
- New: CSS-Klasse `.overlay-bar.always-visible`
- Technical: `overlayBar`-Referenz + class toggles in renderer.js

## 0.4.3 (2026-05-30)
- Change: overlayLocation zeigt immer „Startseite" (nie den Dienstnamen)
- Change: Klick auf „Startseite" navigiert zum Welcome-Screen
- Change: Hover auf „Startseite" skaliert wie Nav-Icons (scale 1.15)
- Cleanup: Alle `overlayLocation.textContent =`-Zuweisungen entfernt

## 0.4.2 (2026-05-30)
- Change: Rahmen von Nav-Icons entfernt (border: none) – Dienste-Farbe nur noch als Hintergrund
- Cleanup: `--icon-border`, `border-color`, `border-width` aus CSS + renderer.js entfernt
- Cleanup: `.nav-tv-icon` border-Regeln entfernt

## 0.4.1 (2026-05-30)
- Feature: TV-Kanal-Liste beim Senderwechsel (Pfeiltasten) – mittig, max. 7 sichtbar
- Feature: Aktueller Sender immer in der Mitte der Liste, smooth-scroll per CSS-Transform
- Feature: 4s Inaktivitäts-Timer blendet Liste aus
- Change: Senderlogos + -namen in EPG-Schriftgröße (40px) für Fernsichtbarkeit
- Technical: renderer.js buildTvChannelList() + channelList/channelIndex in switch-channel-msg
- Technical: tv.html channel-list-overlay + timer + keydown-reset

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
