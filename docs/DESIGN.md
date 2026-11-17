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

Vier Stufen plus Navigation ersetzen die früheren rund zehn Flächen-Variablen; alte Namen sind entfernt.

| Token | Zweck | Dunkel | Hell | Ersetzt (Ist, identischer Wert) |
| --- | --- | --- | --- | --- |
| `surface-0` | Seite | #0a0a0f (Ist) | #f3f5f8 (Ist) | `--bg` |
| `surface-1` | Karte, Kachel | #11151d (Ist) | #ffffff (Ist) | `--c-card` |
| `surface-2` | Panel, Eingabefeld | rgba(22,27,38,.78) (Ist) | rgba(255,255,255,.9) (Ist) | `--c-panel` |
| `surface-3` | Dialog, Popup | #12121a (Ist) | #ffffff (Ist) | `--c-modal` |
| `surface-nav` | Navigationsleiste | #171717 (Ist, alle drei Apps) | #ffffff (Ist) | `--nav-bg` |
| `surface-inset` | Vertiefte Fläche: Bildgrund vor dem Laden (Mediathek-Vorschau), Kopfzeilen im EPG | #191925 (Entscheidung 8b, = frühere `--epg-surface-2`) | #eceff6 (Entscheidung 8b; ersetzt `surface-2` als Bildgrund, das auf `surface-0` kaum sichtbar war) | – |
| `scrim` | Abdunkelung über Bild/Video | rgba(0,0,0,.6) (Ist) | rgba(20,28,48,.42) (Ist) | `--scrim` |
| `scrim-media` | Pille/Knopf hinter weißem Symbol auf Bild | rgba(10,10,15,.78) (Ist) | wie Dunkel (Ist, Ausnahme) | `--media-scrim` |
| `scrim-media-strong` | Wie `scrim-media`, Hover und Toast | rgba(10,10,15,.95) (Ist) | wie Dunkel (Ist, Ausnahme) | `--media-scrim-strong` |

**Abweichende Variablen (Schritt 4, erledigt).** Die neun Variablen mit anderem Ist-Wert sind auf die Ziel-Token umgestellt und aus `:root` entfernt (sichtbare Änderung: Flächen überall gleich, Hell und Dunkel per Screenshot geprüft):

| Alte Variable | Ziel-Token |
| --- | --- |
| `--bg-dash`, `--bg-content` | `surface-0` |
| `--c-card2`, `--surface-card` | `surface-1` |
| `--c-glass-panel`, `--c-field` | `surface-2` |
| `--c-modal-glass`, `--c-pop` | `surface-3` |
| `--media-scrim` (+ `-strong`) | **Ausnahme:** Token `scrim-media` (+ `scrim-media-strong`), siehe unten |

Begründete Ausnahme `scrim-media`: rgba(10,10,15,.78) bzw. .95 (Ist), in beiden Designs gleich. Es liegt hinter weißen Symbolen und Beschriftungen auf Bildern (Pillen, Info-/Stern-Knöpfe, Abo-Marke, Rück-Knopf, Toast) und braucht deshalb in Hell dieselbe Dunkelheit wie in Dunkel. `scrim` (hell .42 bläulich) würde dort die Lesbarkeit weißer Symbole auf hellen Bildern verschlechtern. Es wird mehrfach gebraucht, daher ein eigenes Token statt Alias; `scrim` bleibt für Abdunkelung ganzer Flächen (Senderkachel-Vorschaubild, Dialog-Hintergrund).

Beobachtungen der Vereinheitlichung: Die Karten der Einstellungen (`--surface-card`, vorher 4 % Weiß, durchscheinend) sind jetzt deckend (`surface-1`) und blenden den Farbschimmer des Hintergrunds nicht mehr durch; die Glas-Dialoge (Verlauf, Aufnahmen, Kürzel) behalten `backdrop-filter: blur`, sind in Dunkel aber leicht durchsichtiger (.78 statt .85) und in Hell etwas weniger deckend (.9 statt .95); Dialoge und Popups sind deckend (`surface-3`).

`surface-nav` ist deckend und neutral, `surface-2` durchscheinend und bläulich; deshalb zwei Tokens (Entscheidung A5). Der Rand der Navigation ist `border-nav`.

### Text und Ränder

Kontrast: nachgerechnet nach WCAG-Formel (Schritt 4, Stand 2026-11-17) gegen jede Fläche, auf der der Text steht (`surface-0` bis `surface-3`, `surface-nav`; halbtransparente Flächen über `surface-0` gemischt). Angegeben ist der Mindestwert über alle fünf Flächen (dunkel / hell); die Werte auf `surface-0` stehen in Klammern. Geprüft von `tests/theme-contrast.test.js`.

| Token | Zweck | Dunkel | Hell | Kontrast min. (auf `surface-0`) |
| --- | --- | --- | --- | --- |
| `text-primary` | Überschriften, Titel | #f0f0f5 (Ist) | #14161c (Ist) | 15,7 : 1 / 16,6 : 1 (17,4 / 16,6) |
| `text-secondary` | Untertitel, Meta | rgba(240,240,245,.70) (Entscheidung, umgesetzt; Ist .55) | rgba(20,22,28,.78) (Entscheidung, umgesetzt; Ist .68) | 8,2 : 1 / 8,5 : 1 (8,6 / 8,5) |
| `text-muted` | Hinweise, Platzhalter | rgba(240,240,245,.50) (Ist) | rgba(20,22,28,.60) (Ist) | 4,76 : 1 / 4,59 : 1 (4,8 / 4,6) |
| `border` | Standardrand | rgba(255,255,255,.07) (Ist) | rgba(20,22,28,.13) (Ist) | – |
| `border-strong` | Hover | rgba(255,255,255,.16) (Ist) | rgba(20,22,28,.26) (Ist) | – |
| `border-nav` | Rand der Navigation | rgba(255,255,255,.14) (Ist) | rgba(0,0,0,.12) (Ist) | – |
| `focus-ring` | Fokusring, 2 px | = `text-primary` (Entscheidung) | = `text-primary` (Entscheidung) | wie `text-primary` |

`text-muted` bleibt auf dem Ist-Wert, weil das die Untergrenze für 4,5 : 1 ist (kleinster Wert 4,59 : 1, hell auf `surface-0`). `text-secondary` ist heller bzw. dunkler als das frühere `--text-dim`, damit sich beide Stufen sichtbar unterscheiden (.55 vs. .50 war kaum unterscheidbar); `--text-dim` ist entfernt, alle 79 Verwendungen stehen auf `text-secondary`.

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

**Umsetzung Fokus am Desktop (Schritt 5):** Eine globale Regel am Ende von `styles.css` (`:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }`) gilt für alle Elemente; nur Tastaturfokus, kein Ring bei Mausklick. Einzelregeln setzen höchstens `outline-offset` (negativ bei beschnittenen Listen, Segmenten und Menüzeilen). Keine Fokusdarstellung über `accent`, `--nav-c`, `--md-accent`, Podcast-/Radio-Akzent oder `box-shadow`. Texteingaben zeigen den Ring auch beim Klick (Browserverhalten bei `:focus-visible`), der Rand wechselt auf `border-strong`. Dunkle Kacheln auf heller Seite (Startkacheln, `.theme-dark-scope`) nutzen `--focus-ring-page`, damit der Ring zur Seite passt und nicht zur Kachel.

**Umsetzung Bereichsfarbe am Desktop (Schritt 5):** Der aktuelle Bereich ergibt sich aus dem aktiven Navigationseintrag (`body:has(.overlay-bar [data-section=…].active)` setzt `--area-c`; Startseite ohne Eintrag: `accent`). Der Schimmer hinter der Überschrift (`.content-area`) nutzt `--area-c`. Fortschrittslinien: LiveTV-Kachel und EPG `area-livetv`, Podcast `area-podcast`, Mediathek `area-mediathek` (`--md-accent`). Equalizer: Radio-Kachel `area-radio`, Podcast `area-podcast`. Senderkachel (`--tile-color`) und Radiokachel stehen auf `area-livetv` bzw. `area-radio` statt Quellen-/Festfarbe. Ausnahme: Die Wiedergabe-Hervorhebung (Titel, Rand) einer Podcast-Folge bleibt orange (`--orange-play`), damit sie sich von der grünen Auswahl abhebt (Testvorgabe `podcast-dashboard-split.test.js`).

**Begründete Ausnahme Podcast:** Equalizer und Wiedergabe-Hervorhebung der Podcast-Folge bleiben orange (`--orange-play`), nicht `area-podcast`. Der Zustand „läuft“ muss sich von der grünen Auswahl (`area-podcast`) unterscheiden (Tests `podcasts.spec`, `podcast-dashboard-split`).

**Hinweis Deaktivierte Knöpfe:** Deckkraft .5, in Hell rund 3,3 : 1. Nach WCAG 2.x sind deaktivierte Bedienelemente vom Kontrastziel ausgenommen.

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

Neun Genre-Token (Schritt 8b, Entscheidung 2026-11-17, am Desktop umgesetzt). Dunkelwerte = Desktop = Apple (`EpgTokens.swift`); Hellwerte = Desktop-Ist, `genre-doku` hell von #a8690c auf #a36508 abgedunkelt (4,48 auf 4,75 : 1). Die Apple-Hellwerte (z. B. `sport` #1E9E58, 3,4 : 1 mit weißer Schrift) erreichen 4,5 : 1 nicht; der Apple-Schritt A1 übernimmt die Werte unten.

Verwendung: Streifen (4 px links an Zeile, Block, Karte; 3 px in der Jetzt-&-Gleich-Zelle) und Punkt (8 px im Genre-Chip, Detail) in `genre-*`; Schrift auf einer Genre-Fläche (z. B. gefüllter Chip, Badge) in `on-genre` (#0a0a0f dunkel, #ffffff hell). Farbe ist nie alleiniger Träger: das Genre steht zusätzlich als Text in Spalte, Tooltip und Detail. `tests/theme-contrast.test.js` prüft beides.

| Token | Dunkel | Hell | `on-genre` auf Fläche (dunkel / hell) | Streifen auf `surface-1` (dunkel / hell) |
| --- | --- | --- | --- | --- |
| `genre-news` | #4aa3ff | #1f6fd1 | 7.5 / 4.9 | 6.9 / 4.9 |
| `genre-sport` | #2ecc71 | #13803f | 9.4 / 5.0 | 8.7 / 5.0 |
| `genre-doku` | #e0a43a | #a36508 | 9.0 / 4.7 | 8.3 / 4.7 |
| `genre-kinder` | #ff7eb6 | #c2307a | 8.4 / 5.3 | 7.8 / 5.3 |
| `genre-serie` | #b388ff | #7547d6 | 7.4 / 5.8 | 6.9 / 5.8 |
| `genre-film` | #ff6b5b | #cc3a29 | 7.1 / 5.0 | 6.5 / 5.0 |
| `genre-show` | #f5d04c | #8a6d00 | 13.2 / 4.9 | 12.2 / 4.9 |
| `genre-musik` | #2dd4bf | #0e7f73 | 10.6 / 4.9 | 9.8 / 4.9 |
| `genre-sonstiges` | #8a8a9c | #666679 | 5.8 / 5.6 | 5.4 / 5.6 |

Die EPG-Flächen der Apple-Apps (surface #12121B, surface2 #191925, line .16) sind am Desktop abgebildet: `--epg-surface` = `surface-1`, `--epg-surface-2` = `surface-inset`, `--epg-line` = `border-strong`, `--epg-dim` = `text-secondary`, `--epg-accent-light` = `area-livetv`. Nur die Zustandsflächen des Rasters (`--epg-block`, `-hover`, `-now`, `--epg-dayhead`, `--epg-flag`, `--epg-chan-hover`, `--epg-poster-a/b`) bleiben eigene Werte im theme-literal-Block (Tonstufen, Kontrast gegen `text-primary` getestet).

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

- **Radien** (Ist am Desktop: 3, 4, 6, 8, 10, 12, 14, 16, 18, 24 px, 999 px und 50 %): `radius-xs` 6 · `radius-sm` 8 · `radius-md` 12 · `radius-lg` 16 · `radius-xl` 24 · `radius-full`. Entscheidung: Bereichskachel (Startkachel, `.dashboard-tile`) `xl` 24 (Ist sichtbar, passt zur iPad-Startkachel); übrige Kacheln und Icon-Platten `lg` 16; Navigationseintrag `md` 12; Badges `xs`; Navigationsleiste `full`; Bildkarten und Cover `md`; iPad-Startkacheln `xl` 24 (heute 28). Apple TV skaliert mit dem Schriftfaktor (Startkachel 32, Platte 24).
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

**Layout-Variablen (Desktop, `styles.css`):** `--overlay-top` (24 px, ≤700 px Breite 12 px) und `--overlay-bar-h` (68 px) beschreiben die schwebende Navigationsleiste; `--settings-top` = Oberkante + Höhe + `space-4` ist der Kopfabstand des Einstellungsbereichs. Die Einstellungen haben feste Höhe unterhalb davon: Seitenleiste und Inhalt scrollen jeweils selbst, die Seite nicht.

## Komponenten-Katalog

Jede Komponente gibt es einmal pro App und überall in derselben Form; neue Ansichten bauen nur aus diesen Teilen.

### Bereichskachel (Startseite)

- Illustration oben in Bereichsfarbe (`area-*`), Kachel `radius-xl`, Icon-Platte (`radius-lg`), Titel. Der Kachelgrund bleibt fest dunkel (theme-literal, Ist auf allen Plattformen).
- Entfällt: Untertitel „Bereich öffnen“. Die ganze Kachel ist der Klick.
- Icons: Startkacheln des Desktops nutzen Linien-Icons aus der Zuordnung (`tv-minimal`, `radio`, `mic`, `settings`); nur die Markenlogos der Dienste bleiben Bilder. Es gilt die Icon-Zuordnung unten.

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
- Umsetzung Desktop (Schritt 8a): Variable `--mini-c` auf `.radio-miniplayer` = `area-radio` (Radio), `area-podcast` (Podcast), `area-streaming` (Video, `data-mode`); sie färbt Verlauf und Oberkante, Play-Knopf (Schrift `surface-0` dunkel, `on-accent` hell), Regler, Kapitelzeile und Drop-Markierung der Playlist. Radien `radius-sm`/`radius-full`, Abstände `space-*`, Fokus nur über die globale Ring-Regel (`outline-offset` je Element). `--warn-soft` ist entfernt; `--amber-fill`/`--amber-ink` bleiben nur für den Leerzustands-Knopf in Radio. Ausnahmen: Größen der Logos, Knöpfe, Videofläche (42, 36, 160×90 px) und `min-height` sind Bauteilmaße, keine Token-Werte.
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
- Umsetzung Desktop (Schritt 8a): Bild `radius-md`, Titel `body` in `text-primary`, Meta `meta` in `text-secondary`, Badges und Pillen `meta` mit `radius-xs`, Fortschrittslinie 3 px (Mediathek `area-mediathek`, Podcast `area-podcast`), Rund-Knöpfe `radius-full`, Abstände `space-*`, Bildwechsel `motion-fast`. Cover 56 px (Liste), 44 px (Abos), 40 px (Einstellungen), 132 px (Folge) mit gleichem `radius-md`. Ausnahmen: Platzhalterverlauf der Mediathek-Karte (`hsl` je Titel-Farbton, dynamisch) und der Info-Knopf „i“ als Schriftzeichen (Georgia kursiv; Umstellung auf Icon braucht JS-Änderung, später).

### Icons

- **Einheitlich, nicht identisch:** iPad und Apple TV nutzen SF Symbols, der Desktop ein Linien-Set (Lucide) als SVG. Verbindlich ist die Zuordnung unten: Jeder Zweck hat genau ein Icon pro Plattform. Was Apple schon nutzt, gewinnt.
- Auf dem Desktop sind die Navigations-Icons schon SVG und die Startkacheln PNG. Zu ersetzen sind das Zeichen ⚙ sowie Zeichen-Icons: 📁, ↻, ⌃, `&times;`/✕, +, `●✕■` (EPG-Raster), ★☆, ☰ und ✓/✗/⚠ in Statusmeldungen.
- Desktop-Umsetzung (Schritt 2): Lucide 1.73.0 (ISC, Lizenz in `assets/lucide/LICENSE`), die benötigten SVGs liegen in `assets/lucide/`, `scripts/gen-icons.js` erzeugt daraus `icons.js` (Inline-SVG mit `currentColor`, Größe über CSS `.ic`, kein CDN). Neue Icons: SVG aus `lucide-static` nach `assets/lucide/` kopieren und das Skript ausführen. Alle Namen der Tabelle wurden gegen 1.73.0 geprüft und existieren. Icon-only-Buttons tragen `aria-label`.
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
| Bearbeiten | `pencil` | `pencil` |
| Alle / Liste (Podcast-Kachel) | `line.3.horizontal` | `menu` |
| Weiter / Hub-Pfeil | `chevron.right` | `chevron-right` |
| Aufnahme-Marker (Punkt) | `circle.fill` | `circle` |
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

### Dialog (Desktop, Schritt 8b)

- Panel: Fläche `surface-3` (Glas-Dialoge Verlauf, Aufnahmen, Kürzel: `surface-2` mit `backdrop-filter: blur`), Rand `border`, Radius `radius-xl`, Schatten `0 24px 80px` in `shadow` (50 %), Abdunkelung dahinter `scrim` bzw. `scrim-strong`. Die Mediathek-Dialoge nutzen dieselbe Fläche (`--md-dialog` = `surface-3`) und denselben Radius.
- Titel `section` (20, halbfett), Fließtext `body`, Meta `meta`; Innenabstand `space-5`, Abstand der Elemente `space-3`/`space-4`; Eingabefelder `radius-sm`.
- Schließen-Knopf oben rechts mit Icon `x`; Aktionen unten rechts, die Hauptaktion in `accent` mit `on-accent`, destruktive in `status-danger`.

### Verlauf-Zeile (Farbpunkt)

- Eine Zeile im Verlauf-Overlay (`surface-2`-Glas-Dialog): Farbpunkt, Titel (`body`, `text-primary`, eine Zeile mit Ellipsis), darunter Dienst und Zeitpunkt (`meta`, `text-muted`). Zeile `radius-sm`, Innenabstand `space-3`, Hover mit stärkerer Tönung.
- Farbpunkt: 10 px (Bauteilmaß), `radius-full`, Farbe = Markenfarbe des Dienstes (`services.json`, bewusst keine `area-*`, damit Dienste unterscheidbar bleiben). Ohne bekannten Dienst `accent`, Einträge des LiveTV-Bereichs (`__tv__`) `area-livetv`. Der Punkt ist nie alleiniger Träger: der Dienstname steht in der Metazeile.
- Leerzustand: „Noch nichts angesehen. Geöffnete Dienste erscheinen hier.“ in `text-muted`; „Löschen“ oben rechts in der Dialog-Kopfzeile (Schrift `--brand-red`, 15 % Tönung).

### Fehler- und Leerzustand

- Fehler: Icon `triangle-alert` (32 px) in `status-error`, Titel `section`, ein Satz Ursache bzw. Abhilfe in `text-secondary`, danach die Aktion („Jetzt aktualisieren“). Umgesetzt im EPG (`.epg-state`, `data-state="error"`); Fehlerbanner im Player: `player-err-bg`, `err-text`, `radius-sm`.
- Leer: Titel, ein Satz Einladung und wo möglich eine Aktion; ohne Icon, ohne Ausrufezeichen. Radio-Leerzustand: Knopf `--amber-fill` mit `--amber-ink` (Konstanten, gleich in Hell und Dunkel, Kontrast getestet) als Bereichsknopf Radio, `radius-md`, Innenabstand `space-3`/`space-5`.
- Leere Karten (`.dashboard-empty`): gestrichelter Rand `border`, `radius-lg`, Innenabstand `space-6`.

### Bauteilmaße (Ausnahmen von den Abstands-/Schrift-/Größen-Tokens)

Feste Maße, die an die Größe eines Bauteils gebunden sind, nicht an die Typo- oder Abstandsleiter. Sie bleiben bewusst stehen:

| Maß | Wo | Grund |
| --- | --- | --- |
| 48 px Schrift | Platzhalter-Buchstabe im Folgen-Cover (132 px) | wächst mit dem Cover, kein Textstil |
| 1 px / 2 px Abstand | vertikaler Innenabstand von Pillen und Badges, Zeilenabstand in Listen | Haarabstand, unterhalb `space-1` |
| 33 px Oberkante | FSK-Pille unter dem Sender-Pille (8 px + Pillenhöhe 17 px + 8 px) | hängt an der Pillenhöhe |
| 30 px Höhe | Auswahlfeld Wiedergabegeschwindigkeit im Mini-Player; Info-/Stern-/Entfernen-Knöpfe auf der Mediathek-Karte | kompakte Bedienelemente auf Bild bzw. in der Leiste |
| 26 px | Entfernen-Knopf in der Mini-Player-Playlist | kompakter Icon-Knopf in einer Zeile von 36 px |
| 64 × 36 px | Vorschaubild in der Mini-Player-Playlist | 16:9, wie die Karte |
| 34 / 46 / 56 px | Kopf-, Listen- und Blockhöhe im EPG | Rasterhöhen, vom Skript für die Positionierung genutzt |
| 36 px Einzug | Kopfzeile der EPG-Liste (Spalte der Markierung) | fluchtet mit der Zeilenspalte |

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

- Natives Tray-Menü (`lib/recorder/tray-menu-model.js:93,209,212`, Zeichen ⚠ ● ⏹): Native Menüs können keine SVG-Icons. Vorschlag: Zeichen entfernen oder `nativeImage`-Template-Icons; Entscheidung später.
- Lucide-Namen gegen die eingesetzte Version prüfen; Motive ohne klares Pendant: „Kein Sender / kein Signal“ (SF `antenna.radiowaves.left.and.right.slash`, `tv.slash`), Sprung zurück/vor (kollidiert motivisch mit `rotate-cw` für Neu laden).
- Erledigt (Schritt 2): Die Start-PNGs für LiveTV, Radio und Podcasts waren Emoji-artige Grafiken und sind durch `tv-minimal`, `radio`, `mic` ersetzt (`settings` für Einstellungen). Die Markenlogos (Netflix, ARD, Dienste) bleiben Bilder. `tv-icon.png`, `radio-icon.png`, `podcast-icon.png` werden nicht mehr genutzt.
- Schritt 2, bewusst nicht ersetzt: Schaltflächen-Zeichen ▲▼/↑↓ (Reihenfolge in Einstellungen) und ⠿ (Ziehgriff) – Zuordnung fehlt in der Tabelle (Vorschlag `chevron-up`/`chevron-down`, `grip-vertical`); Glyphen `+`/✓/✕ in der in YouTube-Seiten eingeschleusten Overlay-Schaltfläche (`lib/youtube-mini-page.js`, Fremdseite ohne Zugriff auf `icons.js`); `pip.html` (×, Funktion ruht); Tastenkappen `←` in `<kbd>`; vorhandene eigene Inline-SVGs (Update-Knopf, Werkzeugleisten, Download-Symbole) bis zu ihrer Zuordnung; „Sprung zurück/vor“ ohne eigenes Motiv.
- Hellwerte der `list-*`-Token (Plan A1).
- Schritt 1 (Desktop, Stand `design(1)`): Werte ohne Token, nach `:root` verschoben bzw. belassen, Zuordnung offen. Farben: Navigation `--nav-shadow`, `--nav-text`, `--nav-btn-bg`, `--nav-btn-fg` (Vorschlag: `text-secondary` bzw. `surface-2` ableiten); EPG-Palette `--epg-*` (Vorschlag: `surface-1`/`surface-2`/`border-strong`, Blockfarben neu), `--g-*` (= `genre-*`, Schritt 8); Mediathek `--md-btn-bg`, `--md-btn-ink`, `--md-bg`, `--md-dialog`, `--md-surface`, `--md-surface2`, `--md-line`, `--md-text`, `--md-dim`, `--md-amber`, `--md-amber-ink`, `--md-danger` (Vorschlag: `surface-0` bis `surface-3`, `text-primary`, `text-secondary`, `status-*`; Schritt 4); übrige Altnamen in `:root` (`--ink`, `--violet`, `--accent-glow`, `--glass*`, `--icon-plate`, `--scrim-strong`, `--amber-*`, `--green-*`, `--media-*`, `--video-*` usw.). Inline-Farben in JS: `radio-dashboard-view.js:90` (`--tile-color` #f59e0b, Vorschlag `area-radio`, Schritt 5), Dienst-Standardfarbe #6c5ce7 (`renderer.js`, = `accent`, Datenwert), `hsl(var(--h) …)`-Verläufe für Cover-Platzhalter (`styles.css:2310`, `:2737`; kein fester Wert). Weitere feste Farben in JS: `mediathek-home-view.js:302` (Rückfall #1ab8e0, Vorschlag `area-mediatheken`), `mediathek-format.js:7` (`SOURCE_COLORS` ard #3a8dde, zdf #f08a3c, arte #e8602c; Senderfarben als Datenwerte, Vorschlag belassen), `settings-tv-sources.js:7` (`DEFAULT_COLOR` #a78bfa) und `settings-tv-channels.js:522` (Rückfall #a78bfa; Vorschlag beide `area-livetv`). `--md-text` hat denselben Wert wie `text-primary` (`styles.css:3863`; kann Alias werden).
- Schritt 1: Radien ohne Stufe, unverändert belassen (sichtbar sonst anders): 10 px (25x), 4 px (12x), 14 px (7x; Navigationseintrag ist schon `radius-md`), 18 px (6x: Dialoge, Leerzustand, Hub-Karte), 2/3/5/9/11/20/22 px, 99 px (Vorschlag `radius-full`), Einzel-Ecken (`10px 0 0 10px` usw.). Vorschlag: 4/5 → `xs`, 9/10/11 → `sm` oder `md`, 14 → `md`, 18/20 → `lg`, 22 → `xl`. Außerdem: Die Kachel `.dashboard-tile` zeigt wegen der späteren Regel (`styles.css:3055`, Regel mit `min-height:220px`) 24 px, nicht 18. Entschieden: Bereichskachel `radius-xl` 24; die tote Basisregel (`styles.css:2889`) steht ebenfalls auf `radius-xl` (keine sichtbare Änderung).
- Schritt 5, offen: Mini-Player-Leiste (Radio-Fortschritt/Regler in `--warn-soft`/`--amber-*`, Plan Schritt 8); `--epg-accent-light` (= `--violet`) für Auswahl und „jetzt“ im EPG bleibt, Zuordnung zu `area-livetv` in Plan Schritt 8; die Quellenfarbe in den Einstellungen (Farbwähler je TV-Quelle) hat auf der Senderkachel keine Wirkung mehr, das Feld bleibt vorerst.
- Schritt 1: Tokens ohne Verwendung bis zu ihrem Schritt: `status-danger`, `space-*`, `motion-fast`, `motion-crossfade`.
- Apple-TV-Player-Seitenspalte (`Sources/StreamingHubTV/YouTube/TVPlayerInfoViews.swift`): Schrift 20 bis 34 pt auf die TV-Stufen (Faktor 1,5 bis 2) bringen, Eckradius `cornerRadius: 28` (Z. 38) auf `radius-xl` × TV-Faktor (Plan A3).

## Regeln für Claude Code

Der Abschnitt „Design“ steht in der `CLAUDE.md` jedes App-Repos; dort ist die gültige Fassung.
