# Streaming Hub — Etappe 3.0: Design-Entscheid (Fragebogen)

**Stand:** 04.10.2026 · **Status: VERBINDLICH — vom User entschieden (04.10.2026).** Gilt als Vorgabe für 3.3–3.6; Änderungen nur durch neue ausdrückliche Entscheidung des Users.
**Branch:** `feature/etappe-3-0-design` (nur `docs/`). QA: freigegeben (Commit `05e9c66`).
**Quellen:** `docs/aufnahme-etappe3-plan.md` (3.0, §6), `docs/epg-umgestaltung-konzept-v0.2.md` (EPG-E1–E7), `docs/aufnahme-konzept-v0.4.md` (AUF-E1–E7).

## 0. VERBINDLICHER ENTSCHEID (04.10.2026)

Der User hat **Variante B2 mit Filter-Vorschlag F3** gewählt; alle übrigen Fragen „wie empfohlen“. Mockup: `docs/mockups/etappe3/variant-b2.html` (Screens: `docs/mockups/etappe3/screens/b2-*.png`).

| Frage | Entscheid |
|---|---|
| M1 / P6 Variante | **B2 (Listen-zentriert, Raster als zweiter Modus) mit F3**: Kopfzeile Suche · Modus-Segment · „Jetzt“, darunter schlanke Schnellfilter-Leiste (Tages-Tabs, Genre-Chips, Sender ▾, „Mehr ▾“). A und C entfallen. |
| M2 / P7 Kanalansicht | **Modus im Overlay** (kein eigener Screen) |
| P19 Einstiegspunkte | Klick auf Sendernamen (Liste/Raster) + Panel-/Detail-Link „Alle Sendungen des Senders“. **Nicht** Dashboard, **nicht** Player-Chrome. |
| M3 Rasterdichte | wie geplant: Standard 5 px/min, Zoom 3/5/8 (Zoom-Control nur im Raster-Modus), Zeilenhöhe 64 px, Senderspalte 150 px |
| M4 Genre-Farben | Farbbalken links im Block/in der Zeile; Genre zusätzlich als Text im Tooltip und im Detail |
| M5 Marker | wie im Mockup: ● geplant (violett), pulsierend ● laufend (rot, `prefers-reduced-motion` beachten); „Aufnahme geplant ✓“ im Detail |
| M6 Detail | **Modal** im Vordergrund (Abdunkelung, Esc, Fokus-Falle, unter 900 px vollflächig); „Aufnehmen“ als primärer Button unter der Metazeile. Split-Variante entfällt. |
| M7 Jetzt & Gleich | wie im Mockup (Sender · läuft + Fortschritt · nächste · übernächste), Thumbnail klein; bei Auffälligkeit nur im Detail (EPG-E4) |
| M8 Suche | Trefferliste im Overlay (Titel · Sender · Wochentag Uhrzeit), Klick springt zum Termin und öffnet das Detail |
| P11 Beschreibung | Standard **aus**, Schalter „Beschreibung durchsuchen“ (unter „Mehr ▾“) |
| M9 Leer-/Fehlerzustände | wie im Mockup (leer, lädt, Fehler mit „Jetzt aktualisieren“, Quelle ohne EPG) |
| P14 Keine Favoriten | Hinweis + Button „Alle Sender zeigen“ |
| M10 Nachtsendungen | Badge „Nacht“ beim Vorabend (TV-Tag 05:00–05:00); im Detail Kalenderdatum + Uhrzeit |
| P10 Marker-Umfang | nur geplant + laufend |
| Abbrechen/Stoppen | Einheitlicher Toggle in Liste (Aktionsspalte), Raster, Detail, Kanalansicht: „● Aufnehmen“ ↔ „✕ Aufnahme abbrechen“ ↔ „■ Aufnahme stoppen“. Abbrechen (geplant) **mit Rückfrage**, Stoppen (laufend) **immer mit Rückfrage**. „Aufnehmen“ öffnet in der App den bestehenden Planungsdialog. |
| P8 / P9 (vorab) | 7 TV-Tage (05:00); Slots > 8 Tage: Hinweis „Planung nur bis 8 Tage im Voraus“, Button deaktiviert |

**Mockup-only (kommt NICHT ins Produkt):** Zustand-Leiste, „Fensterbreite simulieren“, „Mockup-Optionen“, Startansicht-Zeile, Einstiegs-Zeile, Statuszeile/Uhr, Datenlücken-Schalter. Bleibt im Produkt: eine Kopfzeile über der Tabelle plus die F3-Schnellfilter-Leiste (Kopfhöhe laut QA ≈ 107 px).

**Offene technische Prüfungen (nicht angenommen, noch nicht im Code gelesen):**
1. Gibt es im Main bereits IPC/Preload für **Abbrechen einer geplanten** und **Stoppen einer laufenden** Aufnahme (Muster `schedule:*`, Recorder)? Falls nein: Neue Kanäle nur hinter `requireMainRenderer`, mit Validierung und Preload-Whitelist. → Klärung zu Beginn von 3.3.
2. Rückfrage vor „Aufnehmen“ aus der Liste: das Mockup zeigt eine kompakte Rückfrage-Zeile; die App nutzt `openSchedulePlanningDialog`. Beides muss in 3.3 konsistent zur Zukunftsregel bleiben.
3. Tatsächliche Tabellenfläche nach Navbar/Overlay-Kopf (Fensterhöhe) erst in 3.3 messbar.

**Bekannte Mockup-Lücken (Pflicht in der Umsetzung):** Senderfilter wirkt im Mockup nur auf Liste/Suche, nicht auf Raster und Jetzt & Gleich; in der App soll die Senderauswahl überall wirken. „Alle Sender“/„Gruppe“ im Mockup nur als Toast.

## 0a. So schaust du dir die Mockups an

Öffne `docs/mockups/etappe3/index.html` (oder direkt `variant-a.html`, `variant-b.html`, `variant-c.html`) in einem normalen Browser. Kein Netz nötig.

- Oben jeder Seite: **Zustand**-Leiste. Jeder Schalter springt in einen Pflicht-Zustand (Panel mit/ohne Zusatzdaten, Hinweise, Kanalansicht, Suche, Cache leer/lädt/Fehler, Datenlücken …).
- **Fensterbreite simulieren 1280 / 880 px** (Ansicht unter 900 px).
- **Genre-Darstellung** (Balken links / Chip / nur Panel) und **Rasterdichte** (3/5/8 px/min, in A und B) sind umschaltbar → M3, M4.
- Simulierte Uhr: **Mo 05.10.2026, 20:32**. „Aufnehmen“ setzt im Mockup nur den Marker.
- Die Beispieldaten sind frei erfunden, **Datenlücken sind absichtlich eingebaut** (Poster nur ≈ 73 %, Credits ≈ 25 %, Episode ≈ 32 %, Genre nicht immer vorhanden).

## 1. Die drei Varianten im Überblick

| | A · Raster-zentriert | B · Listen-zentriert | C · Poster-zentriert |
|---|---|---|---|
| Leitbild | Programmzeitschrift | MediathekView | Apple TV / Infuse |
| Startansicht | Zeitraster mit Senderspalte und Zeitleiste | dichte Tabelle Zeit · Sender · Titel · Genre | Karussells je Sender mit Bildkarten |
| Raster | Hauptansicht | zweiter Modus | nicht vorhanden (Karussells ersetzen es) |
| Detail | Panel rechts, 380 px (unter 900 px Vollbreite) | Panel unten (≈ 46 % Höhe) | Vollflächen-Sheet mit großem Poster |
| Kanalansicht | Modus per Klick auf Sendername | Modus aus der Senderliste links | Kanalseite mit Kopfbereich und Tages-Tabs |
| Stärke | Überblick über Zeit und viele Sender, vertraut | schnell, viele Treffer, gute Suche/Filter | schön, zeigt Bilder, gut für wenige Sender |
| Schwäche | Bei schmalem Fenster nur „Jetzt & Gleich“ | wenig „Fernsehgefühl“, Raster nur Zweitmodus | kein Zeitüberblick; Bildlücken (≈ 27 % ohne Poster) fallen auf; Rasterdichte entfällt |

### Bilder (1280 px)

| Zustand | A | B | C |
|---|---|---|---|
| Startansicht / Raster | ![A Raster](mockups/etappe3/screens/a-grid.png) | ![B Raster](mockups/etappe3/screens/b-grid.png) | ![C Start](mockups/etappe3/screens/c-grid.png) |
| Panel mit Zusatzdaten (geplant ✓) | ![A Panel](mockups/etappe3/screens/a-panel-b.png) | ![B Panel](mockups/etappe3/screens/b-panel-b.png) | ![C Panel](mockups/etappe3/screens/c-panel-b.png) |
| Jetzt & Gleich | ![A JnG](mockups/etappe3/screens/a-jng.png) | ![B JnG](mockups/etappe3/screens/b-jng.png) | ![C JnG](mockups/etappe3/screens/c-jng.png) |
| Kanalansicht 7 TV-Tage | ![A Kanal](mockups/etappe3/screens/a-channel.png) | ![B Kanal](mockups/etappe3/screens/b-channel.png) | ![C Kanal](mockups/etappe3/screens/c-channel.png) |

(Weitere Zustände nur interaktiv in den HTML-Dateien: Suche, Filter, Cache-Zustände, Hinweise, Fenster < 900 px, Fokus.)

## 1a. Rückmeldung des Users und Variante B2 (04.10.2026)

Der User tendiert zu **B** und verlangt fünf Anpassungen. Umgesetzt als neues Mockup `docs/mockups/etappe3/variant-b2.html` (B bleibt zum Vergleich unverändert; QA freigegeben, Commit `fff7b8c`).

| # | Wunsch des Users | Umsetzung in B2 |
|---|---|---|
| 1 | Kopfteil/Filter zu unstrukturiert; Auswahlen ggf. direkt in die Übersicht; Vorschläge | **Drei umschaltbare Vorschläge** (Schalter `st-f1/2/3`): **F1** Spaltenfilter im Tabellenkopf (Sender ▾, Genre ▾, Tag ▾), Kopf nur Suche + Modus + „Jetzt“; **F2** ein „Filter (n)“-Button mit gruppiertem Popover; **F3** Schnellfilter-Leiste mit Tages-Tabs und Genre-Chips, Rest unter „Mehr ▾“. Aktive Filter als entfernbare Chips. Genre-Darstellung und Dichte sind kein App-UI mehr im Kopf (Dichte nur als Zoom im Raster). |
| 2 | Liste springt beim Öffnen auf den aktuellen Zeitslot | Liste scrollt auf „Jetzt 20:32“ (Trennlinie, ca. 40 % Höhe); Button „Jetzt“; Tageswechsel → 05:00 |
| 3 | Im Raster Senderliste ausblenden | Keine linke Senderliste mehr; Senderfilter als Dropdown, Kanalansicht per Klick auf Sendername |
| 4 | Detail mindestens 2/3 oder Modal | Standard **Modal** (abgedunkelt, Esc, Fokus-Falle); Alternative Split mit 68 % Höhe (Schalter `st-d-modal/split`); unter 900 px vollflächig |
| 5 | Aufnehmen und Abbrechen konsistent in der Liste | Ein Toggle überall (Liste als Aktionsspalte, Raster, Detail, Kanalansicht): „● Aufnehmen“ ↔ „✕ Aufnahme abbrechen“ ↔ „■ Aufnahme stoppen“, jeweils mit Rückfrage. Hinweis: In der echten App öffnet „Aufnehmen“ den bestehenden Planungsdialog (das Mockup zeigt ihn als Rückfrage-Zeile). |

| Zustand | B2 (1280 px) |
|---|---|
| Liste (springt auf Jetzt) | ![B2 Liste](mockups/etappe3/screens/b2-list.png) |
| Raster (ohne Senderliste) | ![B2 Raster](mockups/etappe3/screens/b2-grid.png) |
| Filter F1 Spaltenfilter | ![F1](mockups/etappe3/screens/b2-f1.png) |
| Filter F2 Ein Button | ![F2](mockups/etappe3/screens/b2-f2.png) |
| Filter F3 Schnellleiste | ![F3](mockups/etappe3/screens/b2-f3.png) |
| Detail als Modal | ![Modal](mockups/etappe3/screens/b2-d-modal.png) |
| Detail als Split (≥ 2/3) | ![Split](mockups/etappe3/screens/b2-d-split.png) |
| Detail Modal bei 880 px | ![Modal 880](mockups/etappe3/screens/b2-d-modal-880.png) |
| Rückfrage „Aufnahme planen“ | ![Planen](mockups/etappe3/screens/b2-c-plan.png) |
| Jetzt & Gleich | ![JnG](mockups/etappe3/screens/b2-jng.png) |
| Kanalansicht | ![Kanal](mockups/etappe3/screens/b2-channel.png) |

**Neue Entscheidungsfragen aus B2 (zusätzlich zu M1–M10):**
- **F-Wahl:** F1, F2 oder F3 (oder Mischung)? Empfehlung: F1, ggf. F3-Tages-Tabs ergänzen.
- **D-Wahl:** Detail als Modal oder Split? Empfehlung: Modal.
- **Stopp/Abbrechen-Rückfrage:** Beim Abbrechen immer Rückfrage (wie B2) oder direkt mit „Rückgängig“-Toast? Empfehlung: Rückfrage bei laufender Aufnahme (Stoppen), bei geplanter Aufnahme „Rückgängig“-Toast statt Rückfrage ist möglich.
- Offene technische Prüfung vor 3.3: Gibt es im Main für **Abbrechen einer geplanten Aufnahme** und **Stoppen einer laufenden Aufnahme** bereits IPC-Aufrufe (nach Planungsliste/Recorder)? Das ist **noch nicht im Code gelesen** und wird in 3.3 geprüft, nicht angenommen.

Antworten zu diesen Punkten: siehe §0

## 2. Schon festgelegt (nicht mehr zu entscheiden)

- **P8:** Kanalansicht = 7 TV-Tage (05:00–05:00); Nachtsendungen stehen beim Vorabend (im Mockup: Nachtsendung 01:00 unter „Heute 5.10.“).
- **P9:** Slots mehr als 8 Tage voraus: Hinweis „Planung nur bis 8 Tage im Voraus“, kein aktiver Aufnehmen-Button.
- Aus früheren Entscheidungen (nicht neu aufmachen): EPG-E1 TV-Tag 05:00, EPG-E2 Startansicht konfigurierbar (Automatisch ab 900 px Raster, darunter „Jetzt & Gleich“), EPG-E3 Favoriten als Standard, EPG-E4 Thumbnail in „Jetzt & Gleich“, nur ein Aufnahme-Button im Player, Start-Dialog mit genau drei Optionen, nur dunkles Theme.

## 3. Fragen

Pro Frage: Mockup-Stelle, Optionen, Empfehlung (nur Vorschlag) und Feld für deine Antwort.

### M1 (= P6) — Welche Variante gilt?
- **Wo ansehen:** alle drei Seiten, Schalter „Raster (Favoriten)“, „Jetzt & Gleich“, „Kanalansicht“.
- **Optionen:** A / B / C / Mix (z. B. A-Raster + B-Suchleiste; oder A breit und B-Liste/J&G schmal; oder A mit C-artiger Kanalseite).
- **Empfehlung:** A mit Suche/Filter-Leiste aus B. Grund: entspricht dem bisherigen Raster, löst die Mängel (Tagessprung, Marker, Fortschritt), und „Jetzt & Gleich“ deckt schmale Fenster ab. C ist für diesen Datenstand riskant (Poster nur ≈ 73 %).
- **Auswirkung:** bestimmt Aufbau von 3.3 (Raster/Panel), 3.5 (Navigation) und 3.6 (Anzeige).
- **Antwort:** siehe §0 (wie empfohlen)

### M2 (= P7) — Kanalansicht: Modus im Overlay oder eigener Screen?
- **Wo ansehen:** Schalter „Kanalansicht“ und „Kanal Tag > 8“.
- **Optionen:** (a) Modus im Overlay · (b) eigener Screen.
- **Empfehlung:** (a). Gleiche Datenquelle, gleiches Panel, ein Aufnehmen-Pfad, gleiche Marker; (b) kostet Routing und Doppelpflege (3.4 wird dann „L“).
- **Antwort:** siehe §0 (wie empfohlen)

### P19 — Einstiegspunkte der Kanalansicht (mehrere möglich)
- **Wo ansehen:** Zeile „Einstieg Kanalansicht“ (zwei Schalter) in jeder Variante.
- **Optionen:** Klick auf Sendername im Raster/Liste · Panel-Link „Alle Sendungen des Senders“ · Dashboard · Player-Chrome (nur, wenn der Player schlank bleibt).
- **Empfehlung:** die ersten beiden. Dashboard und Player nicht, um Navbar/Player schlank zu halten.
- **Antwort:** siehe §0 (wie empfohlen)

### M3 — Rasterdichte (Varianten A, B-Raster)
- **Wo ansehen:** A: „Raster (Favoriten)“, Schalter „Rasterdichte 3 / 5 / 8 px/min“.
- **Geplant:** Standard 5 px/min, Zoom 3/5/8, Zeilenhöhe 64 px, Senderspalte 150 px.
- **Optionen:** wie geplant · kompakter (Zeile ≈ 48, Senderspalte ≈ 130) · luftiger (Zeile ≈ 80, Standard 8 px/min).
- **Empfehlung:** wie geplant (in B-Raster ist die Zeilenhöhe ebenfalls 64, sonst werden Zeit und „noch N min“ unlesbar).
- **Antwort:** siehe §0 (wie empfohlen)

### M4 — Genre-Farben
- **Wo ansehen:** Schalter „Genre-Darstellung“ (Balken links / Chip im Block / nur Panel); Schalter „Filter Film (Raster)“.
- **Optionen:** (a) Farbbalken links im Block · (b) Chip im Block · (c) nur im Panel.
- **Empfehlung:** (a). Braucht keinen zusätzlichen Platz bei kurzen Blöcken; Genre steht zusätzlich als Text im Tooltip und im Panel (Farbe nie alleiniger Träger).
- **Antwort:** siehe §0 (wie empfohlen)

### M5 — Marker „geplant“ / „laufend“
- **Wo ansehen:** Raster/Liste: Legende „Marker: geplant · läuft (Aufnahme)“; Panel-Schalter „mit B-Daten (geplant)“ und „Aufnahme läuft“.
- **Fragen:** Form und Platz des Punktes (links vor dem Titel wie im Mockup, oder Ecke rechts oben?) · Farbe (geplant violett, laufend rot pulsierend) · Beschriftung im Panel „Aufnahme geplant ✓“ · pulsierend nur bei Bewegung erlaubt (reduzierte Bewegung wird respektiert).
- **Empfehlung:** wie im Mockup.
- **Antwort:** siehe §0 (wie empfohlen)

### M6 — Panel (Position und „Aufnehmen“)
- **Wo ansehen:** A (rechts 380 px), B (unten), C (Vollfläche-Sheet), alle Panel-Schalter; bei 880 px prüfen.
- **Optionen:** rechts 380 px · unten · Vollbild/Sheet. Position von „Aufnehmen“: oben unter dem Titel / unten im Panel fest / neben „Sender öffnen“.
- **Empfehlung:** rechts 380 px (unter 900 px Vollbreite), „Aufnehmen“ als primärer Button direkt unter der Metazeile.
- **Antwort:** siehe §0 (wie empfohlen)

### M7 — „Jetzt & Gleich“
- **Wo ansehen:** Schalter „Jetzt & Gleich“ und „Filter Sport (J&G)“.
- **Fragen:** Spalten (Sender | läuft + Fortschritt | nächste | übernächste, oder weniger bei schmalem Fenster) · Thumbnailgröße (klein links wie im Mockup, größer, oder nur im Panel) · Fortschrittsbalken ja/nein.
- **Empfehlung:** wie im Mockup, Thumbnail klein; bei Auffälligkeiten Thumbnails nur im Panel (EPG-E4).
- **Antwort:** siehe §0 (wie empfohlen)

### M8 (+ P11) — Suche
- **Wo ansehen:** Schalter „Suche: Treffer“, „Suche in Beschreibung“, „Suche: leer“.
- **Optionen:** Overlay-Trefferliste (Titel · Sender · Wochentag Uhrzeit, Klick springt) · Filter direkt im Raster.
- **P11:** Beschreibung standardmäßig mitdurchsuchen? an / aus (Schalter bleibt).
- **Empfehlung:** Overlay-Trefferliste; Beschreibung standardmäßig **aus**.
- **Antwort:** siehe §0 (wie empfohlen)

### M9 — Leer- und Fehlerzustände
- **Wo ansehen:** Zeile „Cache“ (leer, lädt, Fehler, Quelle ohne EPG, ok). Fehler: Button „Jetzt aktualisieren“ (im Mockup springt er kurz auf „lädt“).
- **Fragen:** Kopftexte und Aktion passend? Zusätzlich für „keine Favoriten“ (P14): Hinweis + Button „Alle Sender zeigen“ (im Mockup nicht dargestellt).
- **Empfehlung:** wie im Mockup, plus P14 „Hinweis + Button“.
- **Antwort:** siehe §0 (wie empfohlen)

### M10 — TV-Tag-Beschriftung für Nachtsendungen
- **Wo ansehen:** Schalter „Tage + Nachtsendung“ (A, B, C) und Panel der Nachtsendung. Im Mockup: Beschriftung „Nacht“ / „Nacht zu …“.
- **Optionen:** nur Uhrzeit (01:00) unter dem Vorabend · zusätzlich Badge „Nacht“ · Beschriftung „Fr 3.10. · Nacht“ · Kalenderdatum im Panel („Sa 4.10., 01:00“).
- **Empfehlung:** Badge „Nacht“ im Raster, im Panel Kalenderdatum + Uhrzeit (eindeutig; entspricht Dialog/Planungsliste).
- **Antwort:** siehe §0 (wie empfohlen)

### P10 — Marker-Umfang
- **Optionen:** nur geplant + laufend · zusätzlich „aufgenommen ✓“ · zusätzlich fehlgeschlagen/verpasst.
- **Empfehlung:** nur geplant + laufend (Rest steht im Verlauf der Planungsliste).
- **Antwort:** siehe §0 (wie empfohlen)

## 4. Auswirkungen (wird nach der Entscheidung ausgefüllt)

| Etappe | Hängt ab von | Folge |
|---|---|---|
| 3.3 Liste/Raster, Detail, Marker | M1, M3–M6, M10, P10 | Hauptansicht ist die **Liste** (springt auf „Jetzt“, TV-Tag 05:00, Aktionsspalte), Raster als zweiter Modus **ohne** Senderliste, Zoom nur im Raster; Detail als **Modal**; Marker ● / pulsierend ●; Genre-Balken; Toggle Aufnehmen/Abbrechen/Stoppen mit Rückfragen (Prüfung der Main-Aufrufe zuerst); „Nacht“-Badge; keine Split-/Panel-Rechts-Variante. Schnellfilter-Leiste (F3) ist Teil von 3.3 (Tages-Tabs, Sender ▾) bzw. 3.6 (Genre-Chips mit Daten). |
| 3.4 Kanalansicht | M1, M2, P19, M10 | Modus im Overlay; Einstieg über Sendername und Link im Detail (kein Dashboard/Player); 7 TV-Tage als Tages-Tabs, Jetzt/Nächste hervorgehoben, Toggle je Slot, > 8 Tage deaktiviert mit Hinweis; Umfang **M**. |
| 3.5 Navigation | M1, M7, M8, M9, P11, P14 | Modus-Segment Liste · Raster · Jetzt & Gleich; Suche als Trefferliste (Beschreibung aus, Schalter unter „Mehr ▾“); Senderauswahl (Favoriten/Alle/Gruppe) wirkt in **allen** Modi; Fallback „Alle Sender zeigen“; Zustände leer/lädt/Fehler/ohne EPG. |
| 3.6 Anzeige B | M4, M7, M6 | Genre-Balken und Genre-Chips in der F3-Leiste (Filter dämpft im Raster, filtert in Liste/J&G/Suche); Detail-Modal mit Poster, Meta, Besetzung, „Läuft auch“, neutral ohne Daten; kleine Thumbnails in J&G, lazy. |

## 5. Offene Datenlücken (für die Entscheidung relevant)

Poster nur ≈ 73 % der Sendungen, Besetzung ≈ 25 %, Episode ≈ 32 %, Kategorie ≈ 79 %. Jede Variante muss ohne diese Felder sauber aussehen („neutral, keine leeren Zeilen“). Das ist in den Mockups über „Datenlücken“ sichtbar gemacht.
