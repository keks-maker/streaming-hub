# Design-Umbau: Plan und Status

Stand: 2026-11-17 (Desktop fertig, alles in `main` gepusht bis `a888eba`, kein Release). Der Abgleich mit dem Apple-Repo basierte auf `main` vor dem YouTube-Merge; Nachtrag auf Stand `931bacf`. Vorgabe: `docs/DESIGN.md` (nur im Desktop-Repo). Neue Sessions starten mit diesem Dokument und der Vorgabe.

**Arbeitsweise:** Ein Schritt pro Commit, Commit-Präfix `design(<schritt>): …` (z. B. `design(1): Tokens bereinigen`). Jeder Schritt läuft über dev und qa; App nach jedem Schritt im Hintergrund starten und in Hell und Dunkel prüfen. Token-Änderungen gelten für alle drei Apps und werden im Commit vermerkt. Push, Merge nach `main`, Tag und Release nur nach ausdrücklicher Freigabe des Users.

Repos: Desktop = `streaming-hub` (Branch `design/umbau` ist in `main` aufgegangen und gelöscht; neue Desktop-Arbeit je Thema auf eigenem Branch von `main`), Apple = `StreamingHub-tvOS` (Branch je Schritt, von `main`).

## Checkliste

| Schritt | Repo | Branch | Status | Commit |
| --- | --- | --- | --- | --- |
| 0a. `DESIGN.md`, Umbauplan, Design-Regeln in `CLAUDE.md` | Desktop | `design/umbau` | erledigt | `375436a` |
| 0b. `docs/ipad-desktop-angleichung.md` durch Verweis auf `../streaming-hub/docs/DESIGN.md` ersetzen; Designabschnitt in `CLAUDE.md`; Funktions-Merkpunkte bleiben dort unter „Nicht-Design-Themen“, überholte Design-Aussagen einzeln markiert | Apple | `design/umbau` (Apple-Repo) | erledigt | `b667845`, `f2d54f9`, `f363ff8` |
| 1. Tokens bereinigen | Desktop | `design/umbau` | erledigt (QA bestanden) | 19e0bd6 |
| 2. Icon-Set einführen | Desktop | `design/umbau` | erledigt (QA bestanden) | 7b59994 |
| 3. Texte aufräumen | Desktop | `design/umbau` | erledigt (QA bestanden) | 8d21214 |
| 4. Text-Stufen und Flächen vereinheitlichen | Desktop | `design/umbau` → `main` | erledigt (QA bestanden) | a0cda0d |
| 5. Fokus-Ring und Bereichsfarbe durchziehen | Desktop | `design/umbau` → `main` | erledigt (QA bestanden) | aeb79e9 |
| 6. Startseite „Fortsetzen“ | Desktop | `design/umbau` → `main` | erledigt (QA bestanden) | 73c0c2e, c17ba2a |
| 7. Einstellungen gruppieren | Desktop | `design/umbau` → `main` | erledigt (QA bestanden) | 4ebaefc … 0240630 |
| 8. Restliche Bereiche angleichen | Desktop | `design/umbau` → `main` | erledigt (8a–8c, QA bestanden); Rest siehe Abschnitt Schritt 8 „Offen“ | 0fe2770, afb15a2 |
| N. Navigation: Eintrag „Start“ (`house`, Strg+Umsch+H; Leiste auf der Startseite ausgeblendet, daher kein aktiver Zustand) | Desktop | `design/start-nav` → `main` | erledigt (QA bestanden) | 78c934c, 63f1a1b |
| A1. `Sources/StreamingHubCore/Utils/DesignTokens.swift` | Apple | `design/umbau` (Apple-Repo) | erledigt (QA bestanden); `list-*`-Hellwerte von dev festgelegt, Bestätigung offen | `23daa7f`, `5f4efa9` |
| A2. Hellwerte iPad angleichen | Apple | `design/umbau` (Apple-Repo) | erledigt (QA bestanden, 3 Runden) | `25426a1`, `688b478`, `88decc6` |
| A3. Radien und Schrift | Apple | `design/umbau` (Apple-Repo) | erledigt (QA bestanden); TV-Radius, Rundung 14/20, TV außerhalb Player offen | `e25b35a`, `5edba09`, `36f56ec` |
| A4. TV-Vorschau-Verzögerung 350 ms | Apple | `design/umbau` (Apple-Repo) | erledigt (QA bestanden, Timing nur per Code geprüft) | `25b7788` |
| A5. Texte und Komponenten (Apple) | Apple | `design/umbau` (Apple-Repo) | erledigt (QA bestanden, 3 Runden); voller Senderkachel-Aufbau → Schritt S | `1bbd3fd`, `0171cee`, `f081dac`, `f8278a8`, `751e354` |
| A3b. Radien-Rundung 14 → `md`, 20 → `lg`; iPad-Schrift mit Dynamic Type | Apple | `design/umbau` (Apple-Repo) | offen (Entscheidung 2026-11-17) | – |
| A6. Apple TV Rest auf Tokens (Radien, Schrift außerhalb Player), `list-indigo` dunkel #7672dd, TV-Senderliste Fokusstil | Apple | `design/umbau` (Apple-Repo) | offen (Entscheidung 2026-11-17) | – |
| S-Apple. Senderkachel nach DESIGN.md mit Vorschaubild (iPad, Apple TV) | Apple | `design/umbau` (Apple-Repo) | offen (Entscheidung 2026-11-17) | – |
| S. Senderkachel mit Vorschaubild | Desktop, später Apple | `design/umbau`, `design/jetzt-gleich` → `main` | Desktop erledigt (QA bestanden): S1 Kachel, S2 EPG-Bild im Main (Cache `epg-images/`, `epg-image:get`, gehärtet). S3 Kachel für „Jetzt & Gleich“ verworfen (User 2026-11-17): Spaltenansicht bleibt, größer (Zeile 112 px, Bild 96 × 54 über den Main-Bild-Cache, Logo-Plakette 56 px), Aufnahme als Icon-Knopf ohne Ring. Apple-Umsetzung offen | f7cabd5, 106ccc5, f4da291, bccb825 … 3feb09f |

## Desktop

### Schritt 1: Tokens bereinigen (`styles.css`, `:root`)
- Tokens laut DESIGN.md anlegen: Flächen (inkl. `surface-nav`), Text, `border`, `border-strong`, `border-nav`, `focus-ring`, `area-*`, `status-*`, Radien, Abstände, Bewegung; `light-dark()` wie heute.
- Nur Variablen mit identischem Wert (Spalte „Ersetzt“ in DESIGN.md) als Alias auf die neuen umbiegen; abweichende Variablen bleiben unverändert und folgen in Schritt 4. Verwendungen schrittweise umstellen, Aliase entfernen. Startkachel-Farben (`renderer.js:1020-1026`) und Navigationsfarben (`styles.css:3720-3725`) auf `area-*` umstellen.
- `--nav-bg` bleibt auf `.overlay-bar` (theme-literal) mit Wert `surface-nav`; `--icon-bg` und `--active-glow` stehen in `styles.css` (~1767/1771) und laufen über `--accent` (kein Eingriff nötig).
- Radien auf Tokens: Kachel 18 → 16 (nur Basisregel; Bereichskachel bleibt `radius-xl` 24), Navigationseintrag 14 → 12; 4, 10, 18 und 999 px je Fall einer Stufe zuordnen.
- Feste Farben außerhalb von `:root` ersetzen. Ausnahme: Kachel-Illustrationen (theme-literal), diese in `--illu-*`-Tokens ziehen.
- `title`: `clamp(30px, 4vw, 54px)` bleibt.
- Abnahme: Hell und Dunkel sehen aus wie vorher (bis auf die genannten Radien); Hex-Suche außerhalb von `:root` und Illustrationen ergibt nichts.

### Schritt 2: Icon-Set einführen
- Lucide als SVG-Sprite nach der Zuordnungstabelle; Namen gegen die Version prüfen.
- Navigation hat schon SVG, Startkacheln PNG: prüfen, ob die PNGs Emoji-Grafiken sind, und ggf. ersetzen. Nav-SVGs an die Zuordnung angleichen (u. a. Einstellungen-Sonne → `settings`).
- Ersetzen: ⚙ (Startkachel Einstellungen) und die Zeichen-Icons 📁, ↻, ⌃, `&times;`/✕, +, `●✕■`, ★☆, ☰, ✓/✗/⚠ in Statusmeldungen.

### Schritt 3: Texte aufräumen
- Entfernen: „Bereich öffnen“ (Startseite), „Streaming“ und „Öffnen“ (Dienstkacheln), „Sender öffnen“ und LIVE-Badge (LiveTV-Kacheln).
- Barrierefreiheit: Kachel bekommt ein `aria-label` („LiveTV öffnen“).

### Schritt 4: Text-Stufen und Flächen vereinheitlichen
- Status: erledigt (QA bestanden).
- `text-secondary` auf die neuen Werte (dunkel .70, hell .78).
- Flächen vereinheitlichen: die abweichenden Variablen aus DESIGN.md (Abschnitt „Abweichende Variablen“: `--bg-dash`, `--bg-content`, `--c-card2`, `--surface-card`, `--c-glass-panel`, `--c-field`, `--c-modal-glass`, `--c-pop`, `--media-scrim`) auf `surface-0` bis `surface-3` bzw. `scrim` umstellen. Sichtbare Änderung, bewusst.
- Abnahme: alle Texte erfüllen das Kontrastziel in Hell und Dunkel; Unterschied der vereinheitlichten Flächen in Hell und Dunkel per Screenshot geprüft.

### Schritt 5: Fokus-Ring und Bereichsfarbe durchziehen
- Status: erledigt (QA bestanden). Commit `aeb79e9`, Nachbesserung Fokusring Vorschau-Kachel: siehe git log.
- Fokus-Ring `focus-ring` (2 px, `text-primary`) statt Bereichsfarbe: ändert die Fokusfarbe der Navigation (`styles.css:3743`, `--nav-c`) und der Mediathek (`styles.css:3792`, `--md-accent`).
- Bereichsfarbe: Navigation ist fertig. Offen: Schimmer hinter der Überschrift, Fortschrittslinien und Equalizer in der Farbe des Bereichs; Senderkachel-Farbe von Quellenfarbe auf `area-livetv`.

### Schritt 6: Startseite „Fortsetzen“
- Status: erledigt (QA bestanden). Commit `73c0c2e`.
- Leiste unter den Bereichskacheln aus Verlauf, Radio-Status und laufenden Aufnahmen; leer, wenn nichts da ist.
- Umsetzung: `running-now-model.js` (Auswahl, Reihenfolge), `running-now-view.js`, Verdrahtung in `renderer.js`. Eine Karte je Quelle (Aufnahme, Radio, Podcast, Verlauf), laufende zuerst. Quellen: `recording:list` + `recording:changed`, Radio-Zustand/-Einstellungen (`lastStation`), Podcast-Hörzustand (`podcastHub.data`, Player-Zustand), `get-history`. Weggelassen: Mediathek-„Weiterschauen“ (nur über Netzabruf der Hub-Daten, nicht ohne neues IPC/Netz auf der Startseite).

### Schritt 7: Einstellungen gruppieren
- Status: erledigt (QA bestanden). Commit `design(7)` (nach `73c0c2e`).
- Seitenleiste mit Gruppen-Überschriften (LiveTV, Radio, Podcasts, Mediatheken, Streaming, Allgemein) statt Präfixen wie „LiveTV: Quellen“.
- Umsetzung: `settings-view.js` (alle Gruppen immer offen, `h2` je Gruppe, `tablist` je Gruppe mit `aria-labelledby`), Seitentitel in `index.html` ohne Präfix, Streaming-Eintrag „Dienste“, Allgemein-Eintrag „Sicherung“. Gruppenreihenfolge unverändert (Allgemein, LiveTV, Radio, Podcasts, Streaming, Mediatheken), damit Home/Pfeiltasten wie vorher laufen. „Downloads: …“-Einträge der Mediatheken bleiben (Unterthema, keine Gruppe).

### Schritt 8: Restliche Bereiche angleichen
- 8a, erledigt (QA bestanden): Mini-Player (`--mini-c` je Modus) sowie Cover-Raster und Bildkarte auf Tokens; Details und Ausnahmen in DESIGN.md (Mini-Player, Cover-Raster und Bildkarte).
- 8b, erledigt (QA bestanden): EPG (Raster, Liste, Details) auf Tokens (Schrift 12/14/20, `space-*`, `radius-*`, `--epg-*` auf `surface-1`/`surface-inset`/`border-strong`/`text-secondary`/`area-livetv`); `genre-*` und `on-genre` in `:root` mit getesteten Werten (DESIGN.md „EPG-Genrefarben“); neues Token `surface-inset` (auch Mediathek-Vorschau-Grund); Komponenten Dialog, Verlauf-Zeile, Fehler-/Leerzustand und Bauteilmaße (Ausnahmen) in DESIGN.md; Dialog-Panels einheitlich `surface-3`/`radius-xl`; EPG-Fehlerzustand mit Icon; Nachzügler aus 8a erledigt.
- Offen (nicht 8b): Mediathek-Palette `--md-*` und Bereichs-Dialoge der Einstellungen/Aufnahmen-Liste nur teilweise auf Tokens (Abstände/Schrift ja, Flächen `--md-*` bleiben).
- 8c, erledigt: README-Screenshots (alle 19 eingebundenen Bilder, dunkel, Testdaten) erneuert, GIF der Hover-Vorschau `livetv-hover-vorschau.gif` ergänzt. Erzeugung: `scripts/readme-screenshots.js`, `-radio.js`, `-epg.js` (EPG, Aufnahme-Dialog, GIF). Schritt 8 damit erledigt.

## Apple (nach 0b und Desktop-Schritt 1)

- **A1. `Sources/StreamingHubCore/Utils/DesignTokens.swift`:** dynamische Farben je Systemstil (Muster `EpgTheme.dyn`), Namen wie CSS in camelCase (`surface0`, `areaLiveTV` …), beide Werte je Token. `EpgTheme` und `EpgDarkPalette` gehen darin auf; feste Farben in Swift (`Color(red:)`, `hex()`, Systemfarben, `.accentColor`) schrittweise auf Tokens umstellen; neue Tokens `list-*` (Merklistenfarben, `TVMerklistenHub.swift:104-113`) und `status-danger` (Alias auf `status-error`, `TVSettingsComponents.swift:130`). Kein Asset-Katalog.
- **A2. Hellwerte iPad angleichen:** Radio, Podcasts und Mediathek (Navigation und Kacheln) auf die `area-*`-Hellwerte (Ist erreichen auf Weiß nur 3,8 bis 4,2 : 1); Startkacheln beider Apps auf `area-*` (Fundstelle Apple TV: feste Kachelfarben `Sources/StreamingHubTV/Views/Shell/TVStartScreen.swift:33-41`, inkl. YouTube); YouTube auf `area-streaming`; Navigationshintergrund `surface-nav`/`border-nav`.
- **A3. Radien und Schrift:** iPad-Startkachel 28 → 24, Platten 16, Podcast-Cover fester Radius statt 16 % der Größe; Schrift-Stufen (`title` 48 auf dem iPad, Zuordnung `iPadType`), Apple TV mit Faktor 1,75 (Entscheidung 2026-11-17); TV-Player-Seitenspalte (`Sources/StreamingHubTV/YouTube/TVPlayerInfoViews.swift`, Schrift 20 bis 34 pt, `cornerRadius: 28` Z. 38) auf TV-Stufen und `tv-radius-xl` (32, feste TV-Radien laut DESIGN.md); Abstände 6/10/14/20/28 auf Stufen.
- **A4. TV-Vorschau-Verzögerung 350 ms:** Fokus startet die Vorschau erst nach 350 ms (Ist: sofort, `Sources/StreamingHubTV/Views/Shell/TVLiveTVHubView.swift:206-220`), wie am Desktop.
- **A5. Texte und Komponenten:** „Bereich öffnen“ entfernen, Senderkachel iPad ohne LIVE-Badge und „Sender öffnen“, Fortschritt in `area-livetv` statt System-Blau, Icon-Zuordnung (u. a. `plus.circle` → `plus`, `books.vertical` → `play.rectangle`), „Läuft gerade“.
- Apple TV bleibt fest dunkel (Ausnahme laut DESIGN.md).

## Spec: Senderkachel mit Vorschaubild

Eigener Branch, unabhängig vom Design-Umbau, erst nach Schritt 1 sinnvoll. Die Kachel zeigt ohne Maus das Bild der laufenden Sendung statt des Verlaufs.

- **Bildquelle:** EPG-Daten der laufenden Sendung, dieselbe Quelle wie „Jetzt & Gleich“. Vorher prüfen, welche EPG-Quellen Bilder liefern und in welcher Größe (bisher nicht geprüft; es gibt keinen EPG-Bild-Cache).
- **Verarbeitung im Main-Prozess:** Bild laden, mit `nativeImage.resize()` auf die doppelte Kachelbreite verkleinern, als JPEG ablegen; Dateiname = Hash der Bild-URL.
- **Ablage:** In einem Cache-Unterordner (z. B. `epg-images/` unter dem Cache-Pfad der App), der folgenlos gelöscht werden kann. Nicht zwischen produktive Daten in userData mischen. Testisolation über `STREAMING_HUB_USER_DATA` beachten.
- **Cache-Regeln (Entscheidung):** Limit 50 MB; Aufräumen beim Start: Bilder, deren Sendung seit einem Tag beendet ist, löschen; bei Überschreiten des Limits älteste zuerst.
- **Anzeige im Renderer:** `<img decoding="async">` mit fester Größe, abgedunkelt mit `scrim`. Beim Sendungswechsel wechselt das Bild.
- **Hover:** Das Bild bleibt sichtbar, bis der Stream das erste Videobild liefert, dann Überblendung mit `motion-crossfade`; beim Verlassen stoppt der Stream und das Bild blendet zurück. Heute (`renderer.js:893-933`) ist die Vorschau ein `<video>` mit hls.js, und Video-Element und Klasse `is-previewing` werden sofort gesetzt (daher der schwarze Moment, `styles.css:2824-2825`). Signal für „erstes Bild“: `video.requestVideoFrameCallback()` (Fallback Ereignis `playing`, schon für das Vollbild genutzt, `renderer.js:905-912`); Klasse und Überblendung erst dann setzen.
- **Weiterhin:** nur eine Vorschau gleichzeitig, 350 ms Verzögerung.
- **Fallback:** kein Bild oder Ladefehler → heutiger Look.
- **Abnahme:** LiveTV öffnet ohne spürbare Verzögerung; beim Hovern kein schwarzer oder leerer Moment; Cache bleibt unter dem Limit; Hell und Dunkel geprüft.
- **Apple-Apps:** gleiche Bildquelle und gleiches Verhalten (iPad Tippen, Apple TV Fokus); Signal dort `AVPlayerLayer.isReadyForDisplay` bzw. `AVPlayerItem.status == .readyToPlay` (nicht im Code geprüft); Umsetzung in Swift separat.
