# Changelog

## 0.2.6 (2026-05-21)
- Feature: Verlauf der zuletzt abgespielten Inhalte (Titel, Dienst, Datum/Uhrzeit)
- Feature: Uhr-Icon in der Overlay-Bar öffnet mittiges History-Overlay
- Feature: `Strg+H` – Verlauf öffnen/schließen
- Feature: `page-title-updated`-Event speichert Titel automatisch in `history.json`
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
