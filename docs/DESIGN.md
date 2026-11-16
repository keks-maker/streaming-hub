# Streaming Hub – Designvorgabe

Stand: 2026-11-16

## Zweck und Geltungsbereich

Verbindliche Designsprache für alle drei Streaming-Hub-Apps: Desktop (Electron, macOS und Linux), iPad und Apple TV. Der Umbau in Schritten steht in `docs/design-umbau-plan.md`, dort auch die Spec der Senderkachel mit Vorschaubild.

- **Eine Wahrheit:** Das Original liegt nur hier (`streaming-hub/docs/DESIGN.md`). Das Apple-Repo hat keine Kopie, sondern verweist per `../streaming-hub/docs/DESIGN.md` darauf; `docs/ipad-desktop-angleichung.md` geht darin auf (Plan Schritt 0b).
- **Grundlage:** `styles.css`, `index.html`, `renderer.js` der Desktop-App sowie Swift-Code und Navigation von iPad und Apple TV (Abgleich 2026-11-16).
- **Werte:** „Ist“ = Wert aus dem heutigen Code. „Entscheidung“ = am 2026-11-16 festgelegt. „Vorschlag“ = noch nicht gegen den Code geprüft.
- **Änderungen:** Token-Änderungen gelten für alle drei Apps und werden im Commit vermerkt.

## Design-Grundsätze

Der heutige Look bleibt; modernisiert wird durch Konsequenz, nicht durch einen neuen Stil.

1. **Dunkle, ruhige Grundfläche** mit weichem Farbschimmer am Rand. Hell- und Dunkelmodus sind gleichwertig und folgen der Systemeinstellung. Ausnahme: Apple TV ist fest dunkel (siehe Plattform-Regeln).
2. **Glasflächen** für Karten, Panels und Navigation, mit feinem Rand statt Schatten-Wucht.
3. **Große, fette Überschrift** pro Bereich, darüber ein kleines Label in Versalien („LIVE FERNSEHEN“).
4. **Schwebende Pillen-Navigation** oben.
5. **Jeder Bereich hat eine Farbe** und nutzt sie überall in diesem Bereich: Kachel, aktive Navigation, Schimmer, Fortschritt.
6. **Inhalt vor Beschriftung:** keine Texte, die nur wiederholen, was die Fläche schon sagt („Öffnen“, „Bereich öffnen“).
7. **Ein Icon-Set** für alles, keine Emojis, keine Schriftzeichen als Icons.
8. **Bilder zeigen Inhalte:** Sendungsbilder, Cover und Logos sind die farbigsten Elemente, nicht die Deko.
9. **Alles aus Tokens:** keine Farbe, kein Radius, kein Abstand ohne Token.

## Design-Tokens

Ein Token hat überall denselben Namen: in CSS als Variable in kebab-case (`--surface-1`), in Swift als Eigenschaft in camelCase (`surface1`). Die Swift-Tokens liegen in **`Sources/StreamingHubCore/Utils/DesignTokens.swift`** als dynamische Farben (je Systemstil, Muster `EpgTheme.dyn`), nicht im Asset-Katalog; die Asset-Kataloge enthalten keine Farben, und iPad, Apple TV und TopShelf nutzen dieselbe Datei. `EpgTheme` und `EpgDarkPalette` gehen darin auf.

Jedes Farb-Token hat einen Wert für Dunkel und einen für Hell: in CSS per `light-dark()`, in Swift als dynamische Farbe. Ein Token ohne beide Werte ist unvollständig (Apple TV nutzt nur den Dunkelwert, bleibt aber im Token-Satz vollständig).

### Flächen

Vier Stufen plus Navigation ersetzen die heute rund zehn Flächen-Variablen. Die alten Namen mit identischem Wert bleiben zunächst als Alias auf die neuen bestehen.

| Token | Zweck | Dunkel | Hell | Ersetzt (Ist, identischer Wert) |
| --- | --- | --- | --- | --- |
| `surface-0` | Seite | #0a0a0f (Ist) | #f3f5f8 (Ist) | `--bg` |
| `surface-1` | Karte, Kachel | #11151d (Ist) | #ffffff (Ist) | `--c-card` |
| `surface-2` | Panel, Eingabefeld | rgba(22,27,38,.78) (Ist) | rgba(255,255,255,.9) (Ist) | `--c-panel` |
| `surface-3` | Dialog, Popup | #12121a (Ist) | #ffffff (Ist) | `--c-modal` |
| `surface-nav` | Navigationsleiste | #171717 (Ist, alle drei Apps) | #ffffff (Ist) | `--nav-bg` |
| `scrim` | Abdunkelung über Bild/Video | rgba(0,0,0,.6) (Ist) | rgba(20,28,48,.42) (Ist) | `--scrim` |

**Abweichende Variablen.** Schritt 1 biegt nur Variablen mit identischem Wert um (Spalte oben). Die folgenden haben andere Werte; sie bleiben in Schritt 1 unverändert und werden in Schritt 4 („Text-Stufen und Flächen vereinheitlichen“) bewusst auf das genannte Token gebracht (sichtbare Änderung, in Hell und Dunkel per Screenshot geprüft):

| Variable | Ist-Wert (Dunkel / Hell) | Ziel-Token |
| --- | --- | --- |
| `--bg-dash` | #090b10 / #f3f5f8 | `surface-0` |
| `--bg-content` | #0b0e15 / #eef1f6 | `surface-0` |
| `--c-card2` | #171b25 / #ffffff | `surface-1` |
| `--surface-card` | rgba(255,255,255,.04) / rgba(255,255,255,.8) | `surface-1` |
| `--c-glass-panel` | rgba(18,18,26,.85) / rgba(255,255,255,.95) | `surface-2` |
| `--c-field` | #161b26 / #ffffff | `surface-2` |
| `--c-modal-glass` | rgba(17,21,29,.96) / rgba(255,255,255,.97) | `surface-3` |
| `--c-pop` | #1a1a2e / #ffffff | `surface-3` |
| `--media-scrim` | rgba(10,10,15,.78), ohne Hell/Dunkel | `scrim` |

Abweichung: Ist-Wert wie in der Tabelle, wird in Schritt 4 bewusst auf das Ziel-Token vereinheitlicht. Einzelfälle, bei denen die Abweichung gewollt ist (z. B. `--c-field` als deckendes Eingabefeld), entscheidet dev in Schritt 4 und vermerkt sie hier.

`surface-nav` ist deckend und neutral, `surface-2` durchscheinend und bläulich; deshalb zwei Tokens (Entscheidung A5). Der Rand der Navigation ist `border-nav`.

### Text und Ränder

Kontrast: nachgerechnet nach WCAG-Formel auf `surface-0` (dunkel / hell).

| Token | Zweck | Dunkel | Hell | Kontrast |
| --- | --- | --- | --- | --- |
| `text-primary` | Überschriften, Titel | #f0f0f5 (Ist) | #14161c (Ist) | 17,4 : 1 / 16,6 : 1 |
| `text-secondary` | Untertitel, Meta | rgba(240,240,245,.70) (Entscheidung, Ist .55) | rgba(20,22,28,.78) (Entscheidung, Ist .68) | 8,6 : 1 / 8,5 : 1 |
| `text-muted` | Hinweise, Platzhalter | rgba(240,240,245,.50) (Ist) | rgba(20,22,28,.60) (Ist) | 4,8 : 1 / 4,6 : 1 |
| `border` | Standardrand | rgba(255,255,255,.07) (Ist) | rgba(20,22,28,.13) (Ist) | – |
| `border-strong` | Hover | rgba(255,255,255,.16) (Ist) | rgba(20,22,28,.26) (Ist) | – |
| `border-nav` | Rand der Navigation | rgba(255,255,255,.14) (Ist) | rgba(0,0,0,.12) (Ist) | – |
| `focus-ring` | Fokusring, 2 px | = `text-primary` (Entscheidung) | = `text-primary` (Entscheidung) | wie `text-primary` |

`text-muted` bleibt auf dem Ist-Wert, weil das die Untergrenze für 4,5 : 1 ist. `text-secondary` wird heller bzw. dunkler, damit sich beide Stufen sichtbar unterscheiden (altes `--text-dim` .55 vs. `text-muted` .50 kaum unterscheidbar).

### Bereichsfarben

Jeder Bereich hat genau eine Farbe. Sie ersetzt Farbnamen wie `--violet`, `--violet-deep`, `--orange-play`, `--brand-red`, `--md-teal-deep` und die Einzelfarben der Startkacheln; Claude Code ordnet jede Verwendung einer Rolle zu. Werte = Navigationsfarben des Desktops (Entscheidung A1), auf allen drei Plattformen schon sichtbar.

| Token | Bereich | Dunkel | Hell | Kontrast `surface-0` (dunkel / hell) |
| --- | --- | --- | --- | --- |
| `area-livetv` | LiveTV, EPG, Aufnahmen | #9B80E8 | #6A47C7 | 6,25 / 5,76 |
| `area-radio` | Radio | #F5940F | #A35500 | 8,58 / 4,99 |
| `area-streaming` | Streaming; auf dem iPad auch YouTube | #FF5C66 | #C8101C | 6,56 / 5,42 |
| `area-mediathek` | Mediatheken | #1AB8E0 | #066982 | 8,44 / 5,74 |
| `area-podcast` | Podcasts | #5AF2A6 | #087349 | 13,81 / 5,40 |
| `area-settings` | Einstellungen | #8C9EB8 | #5A6678 | 7,24 / 5,33 |

**Fokus ist keine Farbe:** Fokus zeigt einen 2-px-Ring in `focus-ring` (= `text-primary`). `accent` (#6c5ce7, Ist) gilt nur für Links und Auswahl außerhalb eines Bereichs. So ist im LiveTV-Bereich eindeutig: Lila ist der Bereich, der Ring ist der Fokus.

**Kontrastziel WCAG AA:** Text mindestens 4,5 : 1, große Schrift und Bedienelemente (Icons, Ränder, Fortschritt) mindestens 3 : 1, jeweils gegen die Fläche, auf der sie stehen. Nachrechnung 2026-11-16: Alle sechs `area-*`-Werte erreichen auf `surface-0` und `surface-1` mindestens 4,99 : 1 (hell, Radio) bzw. 5,79 : 1 (dunkel, LiveTV auf `surface-1`). Die frühere Ausnahme für `area-livetv` dunkel (#6c5ce7: 4,07 : 1) entfällt damit, die Bereichsfarben sind auch für kleinen Text geeignet. `accent` #6c5ce7 dunkel erreicht nur 4,07 : 1 und ist deshalb nicht für kleinen Text auf dunkler Fläche gedacht.

### Status

| Token | Zweck | Wert (Ist, dunkel / hell) |
| --- | --- | --- |
| `status-live` | LIVE-Badge | #d62f52 (`--live-badge`) |
| `status-rec` | Aufnahme-Punkt, Jetzt-Linie | #ff5d5d / #c62828 (`--rec`) |
| `status-ok` | Erfolg | #22c55e / #126b34 (`--ok`) |
| `status-warn` | Warnung | #fbbf24 / #a04a08 (`--warn`) |
| `status-error` | Fehler | #ef4444 / #c62828 (`--err`) |
| `status-danger` | Destruktive Aktion (Löschen, Abmelden), Alias auf `status-error`; Ist Apple TV: festes `.red` (`Sources/StreamingHubTV/Views/Shell/TVSettingsComponents.swift:130`), bei Fokus #BF1A1A auf weißer Fläche | wie `status-error` |

### EPG-Genrefarben

Die Apple-Apps haben neun Genrefarben mit Hell- und Dunkelwert (`Sources/StreamingHubCore/Utils/EpgTokens.swift`, `Sources/StreamingHubiPad/iPadEpgTheme.swift`), die Desktop-App eigene Werte. Sie werden als Token-Gruppe `genre-*` übernommen; die Werte legt Plan Schritt 8 fest. Die EPG-Flächen der Apple-Apps (surface #12121B, surface2 #191925, line .16) werden auf `surface-1`, `surface-2` und `border-strong` abgebildet.

### Merklistenfarben

Apple TV bietet für YouTube-Merklisten zehn feste Farben (`Sources/StreamingHubTV/YouTube/TVMerklistenHub.swift:104-113`, `MerklisteColor.color`). Sie werden als Token-Gruppe `list-*` übernommen, wie bei den Genrefarben mit Hell- und Dunkelwert. Ist (nur Dunkelwert, TV ist fest dunkel; RGB 0 bis 1 im Code):

| Token | Ist (dunkel) | Token | Ist (dunkel) |
| --- | --- | --- | --- |
| `list-red` | .93 / .27 / .27 | `list-blue` | .20 / .50 / .96 |
| `list-orange` | .98 / .55 / .13 | `list-indigo` | .36 / .34 / .84 |
| `list-yellow` | .98 / .80 / .14 | `list-purple` | .62 / .40 / .95 |
| `list-green` | .24 / .74 / .38 | `list-pink` | .95 / .36 / .63 |
| `list-teal` | .13 / .70 / .72 | `list-gray` | .56 / .58 / .62 |

Die Hellwerte legt der Apple-Schritt A1 fest (Kontrastziel wie bei `area-*`), sobald Merklisten auf dem iPad oder Desktop vorkommen; bis dahin gilt der Dunkelwert.

### Radien, Abstände, Schrift, Bewegung

- **Radien** (Ist am Desktop: 3, 4, 6, 8, 10, 12, 14, 16, 18, 24 px, 999 px und 50 %): `radius-xs` 6 · `radius-sm` 8 · `radius-md` 12 · `radius-lg` 16 · `radius-xl` 24 · `radius-full`. Entscheidung: Kacheln und Icon-Platten `lg` 16; Navigationseintrag `md` 12; Badges `xs`; Navigationsleiste `full`; Bildkarten und Cover `md`; iPad-Startkacheln `xl` 24 (heute 28). Apple TV skaliert mit dem Schriftfaktor (Startkachel 32, Platte 24).
- **Abstände:** 4 · 8 · 12 · 16 · 24 · 32 · 48 px (`space-1` bis `space-7`). Apple nutzt heute auch 6, 10, 14, 20, 28; diese werden beim Umbau auf die Stufen gelegt.
- **Schrift:** Systemschrift (auf Apple-Geräten SF Pro; Desktop-Stack wie heute). Stufen:

| Stufe | Desktop | iPad | Apple TV |
| --- | --- | --- | --- |
| `eyebrow` | 12, Versalien, Laufweite .14em (Ist) | 12, Versalien, Laufweite wie Desktop | × Faktor |
| `title` | `clamp(30px, 4vw, 54px)` fett, Laufweite −.04em (Ist, Entscheidung 54) | 48, einheitlich für Startseite und Seiten (Entscheidung; Ist 44/48) | × Faktor |
| `section` | 20 halbfett | 20 | × Faktor |
| `body` | 14 | 14 (Zuordnung `cardTitle` fett) | × Faktor |
| `meta` | 12 | 12 (Zuordnung `caption`) | × Faktor |

  Faktor Apple TV: 1,5 bis 2. Zuordnung iPad `iPadType` (Systemstile) → Stufen: `pageTitle` → `section`, `cardTitle` → `body` fett, `caption` → `meta`.
- **Bewegung:** `motion-base` 0,25 s cubic-bezier(0.4,0,0.2,1) (Ist `--t`) · `motion-fast` 0,15 s · `motion-crossfade` 0,3 s für Bild-zu-Video-Überblendung.

## Komponenten-Katalog

Jede Komponente gibt es einmal pro App und überall in derselben Form; neue Ansichten bauen nur aus diesen Teilen.

### Bereichskachel (Startseite)

- Illustration oben in Bereichsfarbe (`area-*`), Icon-Platte (`radius-lg`), Titel. Der Kachelgrund bleibt fest dunkel (theme-literal, Ist auf allen Plattformen).
- Entfällt: Untertitel „Bereich öffnen“. Die ganze Kachel ist der Klick.
- Icons: Startkacheln des Desktops nutzen PNG-Bilder (`tv-icon.png`, `radio-icon.png`, `podcast-icon.png`, Dienst-Logos); nur Einstellungen hat das Zeichen ⚙. Es gilt die Icon-Zuordnung unten.

### Senderkachel (LiveTV-Favoriten, EPG „Jetzt & Gleich“)

- Hintergrund ohne Interaktion: Vorschaubild der laufenden Sendung, abgedunkelt mit `scrim`. Ohne Bild: heutiger Verlauf (Desktop: Quellenfarbe, künftig `area-livetv`).
- Davor: Senderlogo in Icon-Platte, Sendungstitel (`body`, fett), darunter Sender und Restzeit (`meta`).
- Fortschritt als 3-px-Linie an der Unterkante in `area-livetv`.
- Hover (Desktop), Tippen (iPad) bzw. Fokus (Apple TV) startet die stumme Vorschau; Bild-zu-Video-Überblendung mit `motion-crossfade`. Es läuft immer nur eine Vorschau.
- Entfällt: „Sender öffnen“ und das LIVE-Badge, denn im LiveTV-Bereich ist jeder Sender live.
- Dieselbe Komponente nutzt „Jetzt & Gleich“ im EPG. Umsetzung des Vorschaubilds: Spec im Umbauplan.

### Dienstkachel (Streaming, Mediatheken)

- Logo in Icon-Platte, Name. Schimmer in der Markenfarbe des Dienstes wie heute.
- Entfällt: Untertitel „Streaming“ und „Öffnen“.

### Große Karte

- Zum Beispiel „Programmübersicht“ und „Aufnahmen“: Icon-Platte, Titel, Statuszeile, eine Zeile Beschreibung, Pfeil. Ränder und Radien aus Tokens.

### Navigation

- Ist-Stand ist Vorgabe: die Navigationsleiste im Apple-Design (`styles.css` ab Zeile 3709, `Sources/StreamingHubiPad/iPadNavigation.swift`, `Sources/StreamingHubTV/Views/Shell/TVNavigation.swift`). Aktiver Eintrag mit Bereichsfarbe und Unterstrich.
- Tokens: `surface-nav`, `border-nav`, `area-*`; Eintrag `radius-md`, Leiste `radius-full`. `--nav-bg` bleibt auf `.overlay-bar` im „theme-literal“-Block gesetzt, Wert `surface-nav`.
- Die Bereichs-Icons der Desktop-Navigation sind schon Inline-SVG; sie werden an die Zuordnung angeglichen.
- Fokus: Desktop und iPad `focus-ring` (nicht mehr die Bereichsfarbe). Apple TV behält den eigenen TV-Fokusstil (weiße Fläche, schwarze Schrift, Vergrößerung 1,06).
- Aufnahme-Punkt am LiveTV-Eintrag bleibt (`status-rec`).
- Auf dem iPad heißt der Streaming-Bereich YouTube (Label bleibt, Farbe `area-streaming`), weil DRM-Dienste dort nicht möglich sind.
- Apple TV hat ebenfalls einen YouTube-Bereich (`Sources/StreamingHubTV/Views/Shell/TVNavigation.swift:15, 43, 61`, Symbol `play.rectangle.fill`, Ist-Farbe #FF5A5A, hinter `YOUTUBE_NATIVE`). Wie am iPad: Farbe `area-streaming`, Label „YouTube“.

### Mini-Player

- Eine gemeinsame Leiste unten für Video (YouTube), Radio und Podcasts (Ist auf Desktop und iPad, Vorrang Video vor Podcast vor Radio): Cover oder Senderlogo, Titel, Quelle, Play/Pause, Fortschritt bei Podcasts. Akzent in der Farbe der Quelle.
- Apple TV hat dieselbe feste Leiste für Radio und Podcast (Ist, Entscheidung A6).
- **YouTube-Variante (Apple TV):** Video läuft als schwebendes Eckfenster (400 × 225, Standard unten rechts) statt in der Leiste (`Sources/StreamingHubTV/YouTube/TVYouTubeMini.swift`). Es nutzt dieselbe Player-Instanz, reserviert keinen Platz, ist nicht fokussierbar und weicht dem Fokus aus: Berührt das fokussierte Element das Fenster, wechselt es in die am weitesten entfernte Ecke und kehrt in die Heimecke unten rechts zurück, sobald sie frei ist (`Sources/StreamingHubCore/Services/YouTubeMiniCorner.swift`, nur Geometrie; Ecken `bottomTrailing`, `bottomLeading`, `topTrailing`, `topLeading`). Steht unten die Radio-/Podcast-Leiste, liegen die unteren Ecken darüber. Bedienung: „Jetzt läuft“ (Auswählen = Vollbild, Langdruck = Menü), Play/Pause der Fernbedienung steuert das Fenster.
- **Einmal-Hinweis:** Am Mini-Fenster erscheint die ersten drei Male fünf Sekunden lang „Nach oben zu „Jetzt läuft“ · Play/Pause halten = Vollbild“ (`Sources/StreamingHubCore/Services/YouTubeMiniHint.swift`, Zähler in UserDefaults). Gilt nur für Apple TV; Desktop und iPad nutzen die gemeinsame Leiste.

### „Läuft gerade“ (Startseite)

- Neue Leiste unter den Bereichskacheln mit bis zu vier kleinen Karten: zuletzt gehörter Radiosender, laufende Aufnahme, Weiterschauen bzw. Weiterhören aus dem Verlauf.
- Leer, wenn nichts da ist; kein Platzhaltertext. Gilt für alle Plattformen, auf Apple TV zusätzlich zur Mini-Player-Leiste.

### Cover-Raster und Bildkarte

Zwei Varianten derselben Komponente, beide mit `radius-md`, Titel und Meta darunter, „Neu“-Badge und Fortschrittslinie wie bei der Senderkachel:
- **Cover-Raster** quadratisch für Podcasts (fester Token-Radius statt Anteil der Größe).
- **Bildkarte 16:9** für Mediatheken (Ist auf Desktop und iPad).

### Icons

- **Einheitlich, nicht identisch:** iPad und Apple TV nutzen SF Symbols, der Desktop ein Linien-Set (Lucide) als SVG. Verbindlich ist die Zuordnung unten: Jeder Zweck hat genau ein Icon pro Plattform. Was Apple schon nutzt, gewinnt.
- Auf dem Desktop sind die Navigations-Icons schon SVG und die Startkacheln PNG. Zu ersetzen sind das Zeichen ⚙ sowie Zeichen-Icons: 📁, ↻, ⌃, `&times;`/✕, +, `●✕■` (EPG-Raster), ★☆, ☰ und ✓/✗/⚠ in Statusmeldungen.
- Lucide-Namen vor Einsatz gegen die eingesetzte Lucide-Version prüfen (Namen ändern sich gelegentlich).

| Zweck | SF Symbols (iPad, Apple TV) | Desktop (Lucide) |
| --- | --- | --- |
| LiveTV, EPG | `tv` | `tv-minimal` |
| Radio | `dot.radiowaves.left.and.right` | `radio` |
| Podcasts | `mic.fill` | `mic` |
| Mediatheken | `play.rectangle` | `square-play` |
| Streaming | `play.tv` | `monitor-play` |
| YouTube (iPad, Apple TV) | `play.rectangle.fill`; Markenlogo bleibt Bild | – |
| Leerzustand Konto („Keine Konto-Inhalte“) | `tray` (Apple TV, `TVYouTubeAccountViews.swift:164`) | `inbox` |
| Playlist-Platzhalter ohne Vorschaubild | `list.bullet.rectangle` (Apple TV, `TVYouTubeAccountViews.swift:228`) | `list-video` |
| Start | `house` | `house` |
| Einstellungen | `gearshape` | `settings` |
| Verlauf | `clock` | `clock` |
| Aufnahme | `record.circle` (Vorschlag, keine Aufnahme auf Apple) | `circle-dot` |
| Speicherort | `folder` | `folder` |
| Neu laden | `arrow.clockwise` | `rotate-cw` |
| Schließen | `xmark` | `x` |
| Feld leeren | `xmark.circle.fill` | `circle-x` |
| Hinzufügen | `plus` (überall, auch statt `plus.circle`) | `plus` |
| Zurück (Navigation) | `arrow.left` | `arrow-left` |
| Ebene zurück | `chevron.left` | `chevron-left` |
| Suche | `magnifyingglass` | `search` |
| Abspielen / Pause / Stopp | `play.fill` / `pause.fill` / `stop.fill` | `play` / `pause` / `square` |
| Favorit | `star` / `star.fill` / `star.slash` | `star` / `star-off` |
| Warnung, Fehler | `exclamationmark.triangle.fill` | `triangle-alert` |
| Offline | `wifi.exclamationmark` | `wifi-off` |
| Info | `info.circle` | `info` |
| Löschen | `trash` | `trash-2` |
| Gesperrt (FSK, Geo) | `lock.fill` | `lock` |
| Sprung zurück / vor | `gobackward.10/30`, `goforward.10/30` | `rotate-ccw` / `rotate-cw` mit Zahl |
| Ausgewählt | `checkmark` | `check` |
| Mehr | `ellipsis` | `ellipsis` |
| Aufklappen / Zuklappen | `chevron.down` / `chevron.up` | `chevron-down` / `chevron-up` |

### Badges und Zustände

- LIVE (`status-live`, `radius-xs`) nur, wo Live- und Abrufinhalte gemischt sind, z. B. in „Läuft gerade“ oder der Suche.
- Fehler auf Kacheln: Icon und ein kurzer Satz, was passiert ist und was hilft. Leere Bereiche: eine Einladung mit Aktion statt „Noch keine Einträge“.

## Plattform-Regeln

Tokens und Komponenten sind gleich; nur die Bedienung passt sich an: Desktop hat Hover, iPad Touch, Apple TV Fokus.

| Thema | Desktop | iPad | Apple TV |
| --- | --- | --- | --- |
| Senderkachel-Vorschau | Hover, 350 ms Verzögerung (Ist), auch bei Tastaturfokus | Einmal Tippen: stumme Vorschau in der Kachel; zweimal Tippen oder Play-Knopf: Vollbild (Ist) | Fokus startet Vorschau nach 350 ms (Entscheidung; Ist sofort) |
| Hervorhebung | `border-strong`, leichtes Anheben | Druckzustand beim Tippen | Fokuseffekt des Systems (Anheben, Schatten) |
| Fokus | Ring `focus-ring` | Ring `focus-ring` (Hardware-Tastatur) | Systemeffekt; Navigation: weiße Fokusfläche, schwarze Schrift, Vergrößerung 1,06 (TV-Fokusstil) |
| Navigation | Schwebende Pille oben | Tab-Leiste oben im selben Pillen-Look | Tab-Leiste oben, Bereichsfarbe für den aktiven Eintrag |
| Schrift | Stufen wie oben | Stufen wie oben | Faktor 1,5 bis 2 |
| Hell/Dunkel | folgt dem System | folgt dem System | **fest dunkel** (Ausnahme: Fernsehen im dunklen Raum, Video im Mittelpunkt); Tokens trotzdem mit beiden Werten |
| Mini-Player | Leiste unten (Video, Radio, Podcast) | Leiste unten (Video, Radio, Podcast) | Leiste unten (Radio, Podcast); YouTube als schwebendes Eckfenster; „Läuft gerade“ zusätzlich |
| Bereiche | LiveTV, Radio, Streaming, Mediatheken, Podcasts, Einstellungen | wie Desktop; Streaming = YouTube | wie Desktop; Streaming = YouTube (hinter `YOUTUBE_NATIVE`) |
| Mindestgröße Bedienelemente | Maus, keine Vorgabe | 44 pt | durch Fokus geregelt |
| Tastenkürzel | wie heute | Hardware-Tastatur: dieselben Kürzel | Fernbedienung |

## Offen

- Lucide-Namen gegen die eingesetzte Version prüfen; Motive ohne klares Pendant: „Kein Sender / kein Signal“ (SF `antenna.radiowaves.left.and.right.slash`, `tv.slash`), Sprung zurück/vor (kollidiert motivisch mit `rotate-cw` für Neu laden).
- Ob die Start-PNGs des Desktops Emoji-Grafiken sind (Plan Schritt 2).
- Werte der `genre-*`-Token (Plan Schritt 8) und Hellwerte der `list-*`-Token (Plan A1).
- Apple-TV-Player-Seitenspalte (`Sources/StreamingHubTV/YouTube/TVPlayerInfoViews.swift`): Schrift 20 bis 34 pt auf die TV-Stufen (Faktor 1,5 bis 2) bringen, Eckradius `cornerRadius: 28` (Z. 38) auf `radius-xl` × TV-Faktor (Plan A3).

## Regeln für Claude Code

Der Abschnitt „Design“ steht in der `CLAUDE.md` jedes App-Repos; dort ist die gültige Fassung.
