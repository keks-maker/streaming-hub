# Design-Umbau: Plan und Status

Stand: 2026-11-16. Der Abgleich mit dem Apple-Repo basierte auf `main` vor dem YouTube-Merge; Nachtrag auf Stand `931bacf`. Vorgabe: `docs/DESIGN.md` (nur im Desktop-Repo). Neue Sessions starten mit diesem Dokument und der Vorgabe.

**Arbeitsweise:** Ein Schritt pro Commit, Commit-Präfix `design(<schritt>): …` (z. B. `design(1): Tokens bereinigen`). Jeder Schritt läuft über dev und qa; App nach jedem Schritt im Hintergrund starten und in Hell und Dunkel prüfen. Token-Änderungen gelten für alle drei Apps und werden im Commit vermerkt. Push, Merge nach `main`, Tag und Release nur nach ausdrücklicher Freigabe des Users.

Repos: Desktop = `streaming-hub` (Branch `design/umbau`), Apple = `StreamingHub-tvOS` (Branch je Schritt, von `main`).

## Checkliste

| Schritt | Repo | Branch | Status | Commit |
| --- | --- | --- | --- | --- |
| 0a. `DESIGN.md`, Umbauplan, Design-Regeln in `CLAUDE.md` | Desktop | `design/umbau` | erledigt | `375436a` |
| 0b. `docs/ipad-desktop-angleichung.md` durch Verweis auf `../streaming-hub/docs/DESIGN.md` ersetzen; Designabschnitt in `CLAUDE.md`; Funktions-Merkpunkte bleiben dort unter „Nicht-Design-Themen“, überholte Design-Aussagen einzeln markiert | Apple | `design/umbau` (Apple-Repo) | erledigt | `b667845`, `f2d54f9`, `f363ff8` |
| 1. Tokens bereinigen | Desktop | `design/umbau` | erledigt (QA bestanden) | 19e0bd6 |
| 2. Icon-Set einführen | Desktop | `design/umbau` | erledigt (QA bestanden) | 7b59994 |
| 3. Texte aufräumen | Desktop | `design/umbau` | erledigt (QA bestanden) | 8d21214 |
| 4. Text-Stufen und Flächen vereinheitlichen | Desktop | `design/umbau` | erledigt (QA ausstehend) | a0cda0d |
| 5. Fokus-Ring und Bereichsfarbe durchziehen | Desktop | `design/umbau` | erledigt (QA ausstehend) | siehe git log |
| 6. Startseite „Läuft gerade“ | Desktop | `design/umbau` | offen | – |
| 7. Einstellungen gruppieren | Desktop | `design/umbau` | offen | – |
| 8. Restliche Bereiche angleichen | Desktop | `design/umbau` | offen | – |
| A1. `Sources/StreamingHubCore/Utils/DesignTokens.swift` | Apple | offen | offen (nach 0b) | – |
| A2. Hellwerte iPad angleichen | Apple | offen | offen | – |
| A3. Radien und Schrift | Apple | offen | offen | – |
| A4. TV-Vorschau-Verzögerung 350 ms | Apple | offen | offen | – |
| A5. Texte und Komponenten (Apple) | Apple | offen | offen | – |
| S. Senderkachel mit Vorschaubild | Desktop, später Apple | eigener Branch | offen (nach Schritt 1) | – |

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

### Schritt 6: Startseite „Läuft gerade“
- Leiste unter den Bereichskacheln aus Verlauf, Radio-Status und laufenden Aufnahmen; leer, wenn nichts da ist.

### Schritt 7: Einstellungen gruppieren
- Seitenleiste mit Gruppen-Überschriften (LiveTV, Radio, Podcasts, Mediatheken, Streaming, Allgemein) statt Präfixen wie „LiveTV: Quellen“.

### Schritt 8: Restliche Bereiche angleichen
- Mini-Player: Video, Radio und Podcast nutzen schon eine Leiste (`radio-miniplayer-view.js`); nur Optik und Tokens prüfen.
- Cover-Raster (Podcasts, quadratisch) und Bildkarte 16:9 (Mediatheken) nach Katalog.
- EPG: Raster, Liste und Details auf Tokens; `genre-*`-Token-Werte festlegen.
- Verlauf-Overlay (Farbpunkt je Zeile als Komponente beschreiben), Dialoge und Fehlerzustände auf Komponenten und Texte prüfen.
- Danach: README-Screenshots erneuern, kurzes GIF der Hover-Vorschau.

## Apple (nach 0b und Desktop-Schritt 1)

- **A1. `Sources/StreamingHubCore/Utils/DesignTokens.swift`:** dynamische Farben je Systemstil (Muster `EpgTheme.dyn`), Namen wie CSS in camelCase (`surface0`, `areaLiveTV` …), beide Werte je Token. `EpgTheme` und `EpgDarkPalette` gehen darin auf; feste Farben in Swift (`Color(red:)`, `hex()`, Systemfarben, `.accentColor`) schrittweise auf Tokens umstellen; neue Tokens `list-*` (Merklistenfarben, `TVMerklistenHub.swift:104-113`) und `status-danger` (Alias auf `status-error`, `TVSettingsComponents.swift:130`). Kein Asset-Katalog.
- **A2. Hellwerte iPad angleichen:** Radio, Podcasts und Mediathek (Navigation und Kacheln) auf die `area-*`-Hellwerte (Ist erreichen auf Weiß nur 3,8 bis 4,2 : 1); Startkacheln beider Apps auf `area-*` (Fundstelle Apple TV: feste Kachelfarben `Sources/StreamingHubTV/Views/Shell/TVStartScreen.swift:33-41`, inkl. YouTube); YouTube auf `area-streaming`; Navigationshintergrund `surface-nav`/`border-nav`.
- **A3. Radien und Schrift:** iPad-Startkachel 28 → 24, Platten 16, Podcast-Cover fester Radius statt 16 % der Größe; Schrift-Stufen (`title` 48 auf dem iPad, Zuordnung `iPadType`), Apple TV mit Faktor 1,5 bis 2; TV-Player-Seitenspalte (`Sources/StreamingHubTV/YouTube/TVPlayerInfoViews.swift`, Schrift 20 bis 34 pt, `cornerRadius: 28` Z. 38) auf TV-Stufen und `radius-xl` × TV-Faktor; Abstände 6/10/14/20/28 auf Stufen.
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
