# Mediathek (nativ) + Downloads — Konzept v0.1

Stand 20.10.2026 · **Entwurf, nicht umgesetzt, nicht committen** (Konzeptdatei bleibt lokal).
Quellen: `StreamingHub-tvOS` (Core: `MediathekService/Parser/ARTEParser/Model/PageModels/FavoritesService`, `UserMediathekService`; iPad-Views `iPadMediathek*`; Mockup `docs/mockups/ipad-mediathek`), Desktop (`lib/recorder/*`, `lib/ffmpeg.js`, `lib/podcast/*`, `settings-view.js`).

## 1. Ausgangslage

- **Apple:** Mediathek ist nativ. Eigene Parser für ARD-, ZDF- und arte-API, Hub mit Reihen, Serien-/Genre-Seite, Suche mit Paging, Detail-Sheet, „Meine Serien“, „Weiterschauen“, Geo-/FSK-Meldungen, „Verfügbar bis“, OV-/Audiodeskription-Zusammenführung. Eigene Mediatheken nur als Weblink (`UserMediathekService`).
- **Desktop:** „Mediatheken“ sind nur Webseiten-Kacheln (ARD/ZDF/… als eingebettete Seite) plus Mediathek-Suche aus dem EPG. Kein nativer Katalog, kein Parser.
- **Folge:** Downloads sind ohne nativen Katalog nicht sinnvoll machbar (Stream-URL, Serienstruktur, Tonspuren kommen aus denselben API-Antworten). Der Weg ist daher: **erst Mediathek-Port, dann Downloads obendrauf.**

## 2. Zielbild

Bereich **Mediatheken** wird wie auf iPad/tvOS aufgebaut, mit Download-Funktionen:

- Hub: Quellenleiste (ARD · ZDF · arte · Meine Serien · Weiterschauen · **Downloads**), Reihen, Genres.
- Serienseite: Kopf mit Abspielen / Merken / **Laden ▾** (Alle Folgen · Staffel · Auswahl · nur neue), Staffelauswahl, je Folge Download-Symbol mit Zustand.
- Detail-Sheet einer Folge: **Herunterladen** (öffnet Dialog „Download-Optionen“ mit Voreinstellungen aus den Einstellungen).
- Bereich **Downloads**: Warteschlange (Fortschritt, Tempo, Restzeit, Pause/Fortsetzen/Abbrechen/Wiederholen) und Bibliothek (fertige Dateien, Abspielen, im Finder zeigen, Löschen, „läuft ab am …“ der Quelle).
- Navbar-Indikator wie bei Aufnahmen (Punkt/Ring bei laufendem Download), Systembenachrichtigung bei Fertigstellung.
- Weblink-Mediatheken (eigene/ausgeblendete) bleiben als „Weitere Mediatheken“ erhalten.

## 3. Architektur (Desktop)

**Neu `lib/mediathek/` (Main-Prozess, kein Electron-Bezug, testbar):**
- `sources.js` (ARD/ZDF/arte: Endpunkte wie `MediathekService.swift`), `parser-ard|zdf|arte.js`, `model.js` (Entry, Section, Series, Genre, Staffeln), `favorites.js` (Meine Serien), `ipc.js` (Muster `lib/podcast/ipc.js`, nur hinter `requireMainRenderer`, Validierung, Preload-Whitelist).
- **Parität über Fixtures:** Die JSON-Fixtures aus `Tests/StreamingHubCoreTests/MediathekFixtures.swift` werden für die JS-Tests übernommen; gleiche Eingabe → gleiche Einträge. Datenformat von „Meine Serien“/Verlauf mit `cross-platform-sync` abgleichen (Skill nutzen).
- Stream-Auflösung wird erweitert: nicht nur „eine abspielbare URL“, sondern **`resolveForDownload(entry)` → { variants[], audioTracks[], subtitles[], restriction }** (Qualitätsstufen, Tonspuren, Untertitel, Geo/FSK, „verfügbar bis“). Die Apple-Parser liefern dies heute nicht (ARD nimmt nur `kind==main`, HLS vor MP4; Untertitel fehlen). Die Erweiterung gehört in die Parser beider Plattformen (iPad-Player-Menü profitiert).

**Neu `lib/download/` (analog `lib/recorder/`, Bausteine wiederverwenden):**
- `DownloadService` (Queue, max. parallel, Persistenz `downloads.json`, Wiederaufnahme nach Neustart) — Muster `RecorderService`/`RecordingStore`/`Scheduler`.
- `DownloadJob`: pro Folge. URL **frisch** auflösen (wie `stream-resolver.js`, URLs laufen ab), dann
  - **Progressives MP4** (ARD/ZDF bieten es): HTTP mit Range-Resume, beste Stufe ≤ Einstellung.
  - **HLS** (arte, Fallback): `ffmpeg -c copy` mit `-map` auf gewählte Video-/Audio-/Untertitelspuren, Fortschritt per `-progress` (Parser aus `RemuxJob.js`), Ausgabe in `.part`, am Ende atomar umbenennen + `ffprobe`-Prüfung (`probeMp4`/`decodeCheckMp4` vorhanden).
  - Kein Transcoding, keine DRM-Umgehung: verschlüsselte/DRM-Streams werden als „nicht ladbar“ gemeldet.
- Wiederverwendet: `paths.js` (`validateStorageRoot`, Platz-/Reserve-Prüfung, `recording-settings`-Clamp), `Notifier`, `QuitCoordinator`/`quit-guard` (Rückfrage beim Beenden mit laufenden Downloads), `lib/ffmpeg.js` (nativer arm64-ffmpeg).
- Renderer: `mediathek-*-model.js` / `*-view.js` im Stil der Podcast-/EPG-Module (Model rein testbar, View dünn).

## 4. Download-Verhalten

- **Einzelfolge:** Klick → Dialog (Qualität, Tonspuren, Untertitel; Vorbelegung aus Einstellungen, „Nicht mehr fragen“-Schalter für Ein-Klick-Download).
- **Serie / Staffel:** Auswahlliste mit Häkchen (alle vorgewählt, bereits geladene ausgegraut), Summe geschätzte Größe + freier Platz, ein Klick „n Folgen laden“. Reihenfolge: **zuerst, was bald abläuft**, dann chronologisch.
- **Duplikate:** Index `quelle:entryId` → „bereits geladen“; OV-/AD-Varianten gelten als dieselbe Folge (Tonspur-Wahl entscheidet).
- **Sperren:** Geoblock → Hinweis wie in der Mediathek (Region). FSK-Sperre → Job wird **bis zum Freigabefenster zurückgestellt** (z. B. „22–6 Uhr“, `fskWindow` aus dem Core) statt zu scheitern.
- **Fehler:** lesbare Meldungen ohne URLs/Tokens, „Wiederholen“; HLS-Abbruch startet die Folge neu (Segment-Resume = spätere Stufe).
- **Verfügbar bis:** Anzeige in Queue/Bibliothek; heruntergeladene Dateien bleiben, die Markierung „Quelle abgelaufen“ ist nur Info.
- **Dateiablage:** `<Speicherort>/Mediathek/<Quelle>/<Serie>/<Schema>`; Standard-Schema `S01E02 - Titel.mp4` (Fallback `Titel (Datum).mp4`), Zeichen/Länge bereinigt, Kollision → Zähler. Optional NFO + Cover für Jellyfin/Plex/Kodi.
- **Wiedergabe offline:** Bibliothek spielt im bestehenden Player, schreibt Fortschritt in dieselbe „Weiterschauen“-Liste.

## 5. Einstellungen (Mediatheken ▸ Unterseiten wie bei LiveTV)

| Seite | Inhalt |
|---|---|
| **Quellen** | ARD/ZDF/arte ein/aus, Weblink-Mediatheken verwalten (bestehend) |
| **Wiedergabe** | Bevorzugte Qualität, bevorzugte Sprache, Untertitel automatisch (aus / Deutsch / Originalsprache), Audiodeskription bevorzugen (gemeinsam mit Apple) |
| **Downloads ▸ Ablage** | Speicherort (Standard: Unterordner `Mediathek` des Aufnahme-Speicherorts, änderbar, NAS-Pfade erlaubt), Dateinamen-Schema, Ordner je Serie, NFO/Cover schreiben |
| **Downloads ▸ Qualität** | Max. Auflösung (Beste / 1080p / 720p / 540p / Sparsam), Container (MP4 empfohlen / MKV) |
| **Downloads ▸ Ton & Untertitel** | Tonspuren: nur bevorzugte / alle; Reihenfolge der Sprachen (Deutsch, Original, …); Audiodeskription: nie / zusätzlich / nur wenn keine normale Spur; Untertitel: keine / bevorzugte Sprache / alle, eingebettet oder als `.srt` daneben; Gebärdensprache nie |
| **Downloads ▸ Steuerung** | Parallele Downloads (1–5, Standard 2), Bandbreitenlimit, Reserve-Platz (wie Aufnahmen), Download nur zu bestimmten Zeiten, Benachrichtigung bei Fertigstellung, Aufräumen (Gesehene nach n Tagen löschen, aus) |
| **Downloads ▸ Hinweise** | Hinweistext zur privaten Nutzung (siehe Entscheidung 4), Schalter „Download-Funktion anzeigen“ |

Ton-/Untertitel-Regeln werden zentral in einem reinen Modul (`track-selection.js`) berechnet: Eingabe = verfügbare Spuren + Einstellungen, Ausgabe = `-map`-Liste. Dadurch gut testbar und im Dialog überschreibbar.

## 6. Etappen (je `dev` → `qa`, max. 3 Runden, Commit durch `dev`)

0. **Navigationsleiste** vom Apple-Stand übernehmen (eigene kleine Etappe, vorher; Vergleich Desktop ↔ `iPadNavigation.swift` / Bereichsfarben, gestapelte Einträge, Unterstrich).
1. **Spike (S):** reale Streams aller drei Quellen prüfen: Varianten, Audiogruppen, Untertitel-Formate (TTML/VTT), ffmpeg-Mapping, MP4-Download mit Resume. Skript unter `scripts/spike-mediathek/` (Muster `spike-radio`). Ergebnis klärt Container- und Untertitelfragen.
2. **Core-Port (L):** `lib/mediathek/*`, Fixture-Tests, IPC, ohne UI.
3. **Mediathek-UI (L):** Hub, Serie, Genre, Suche, Detail, Meine Serien, Weiterschauen, Player; nach Mockup (Desktop-Mockup aus `ipad-mediathek` ableiten → Freigabe durch User wie bei Etappe 3).
4. **Download-Engine + Einstellungen + Downloads-Bereich (L):** Einzelfolge, Queue, Persistenz, Benachrichtigung, Quit-Guard.
5. **Serien-/Staffel-Download (M):** Auswahlliste, Duplikat-Index, Ablauf-Priorisierung, FSK-Zurückstellung.
6. **Extras (M, optional):** „Neue Folgen automatisch laden“ je Serie (Scheduler-Muster), NFO/Cover, Segment-Resume für HLS, Aufräumen.

Release: nach Etappe 3 (Mediathek nativ) eigene Minor-Version, Downloads (4–5) die nächste; Push/Tag/Release nur nach Freigabe.

## 7. Risiken

- API-Änderungen der Sender (inoffizielle Endpunkte) → Fixture-Tests + Fehlerbild „Quelle hat sich geändert“.
- Rechtlich: Nutzungsbedingungen der Mediatheken sind auf Streaming ausgelegt; privater Download wird geduldet (MediathekView-Praxis), bleibt aber Nutzerverantwortung.
- Speicherbedarf (Serie ≈ 10–40 GB) → Platzprüfung vor Start und je Job, klare Summenanzeige.
- ARD liefert Tonspur-Varianten als getrennte Einträge (OV/AD), arte/ZDF teils als HLS-Gruppen: zwei Mechanismen in `track-selection.js`.
- Parallele Downloads + laufende Aufnahmen teilen Bandbreite/Platten → gemeinsame Platz-Reserve, Aufnahmen haben Vorrang.
