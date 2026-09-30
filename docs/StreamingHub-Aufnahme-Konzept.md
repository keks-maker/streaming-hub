# Streaming Hub — Aufnahme-Funktion für LiveTV (Konzept)

**Stand:** 30.09.2026 · **Status:** Entwurf v0.2 — wartet auf User-Freigabe
**Umfang:** Streaming-Hub Electron-App (Mac + Linux); tvOS/iPad ausdrücklich **nicht** ausgeschlossen — Zielbild ist dieselbe Funktionalität auf allen Plattformen der App, umgesetzt wo die Plattform es erlaubt (s. §1).
**Änderungen v0.1 → v0.2 (User-Feedback):** Plattform-Zielbild erweitert; Speicherort-Option NAS; ffmpeg als Install/Update-Pflicht; Auflösungs-Frage beantwortet; Remux-Fortschritt sichtbar; Kanalwechsel-Sichtbarkeit; Beenden-Meldung bei geplanten Aufnahmen; Dateigröße aus Bibliothek entfernt; Phase 2 konkretisiert (EPG-Wochenhorizont, kanalabhängiges EPG, parallele Aufnahmen).

---

## 1. Scope & Grenzen

- Aufnahme **nur für unverschlüsselte HLS/M3U-LiveTV-Quellen** (ARD, ZDF, M3U-Playlists).
- **Ausgeschlossen:** Widevine-DRM-Quellen (Mediatheken-VOD, Streaming-Dienste). DRM-Entschlüsselung ist technisch blockiert und rechtlich nicht vertretbar — der Record-Button erscheint dort gar nicht erst.
- **Plattform-Zielbild:** Alle Features sollen auf allen Plattformen verfügbar sein. Umsetzungsreihenfolge folgt der App-Realität: Mac + Linux zuerst (Electron-App, eine Codebasis), tvOS/iPad sobald Phase 1/2 hier stabil sind — dort gelten andere Mechaniken (AVPlayer/AVFoundation statt hls.js + ffmpeg). Aufnahme-UI und Datenmodell werden von Anfang an plattformneutral entworfen, damit der Port später kein Redesign braucht.
- Speicherort **wählbar in den Settings** (Default `~/Videos/Streaming Hub/`) — lokal **oder Netzwerkpfad** (NAS-Mount, s. §4).

## 2. Technische Architektur

### 2.1 Aufnahme-Engine: ffmpeg-Subprozess

Begründung gegen die Alternativen:
- *hls.js-Mitlesen (A)* scheitert an der Grundanforderung „Aufnahme läuft weiter bei Kanalwechsel" — Fragmente existieren nur, solange der Player offen ist.
- *Externer Record-Daemon (C)* ist ein späterer Ausblick (z. B. NAS), hier nur erwähnt.
- *ffmpeg-Subprozess (B):* stream-copy ohne Re-Encoding (CPU ≈ 0), unabhängig vom Player-Fenster, mehrere parallele Aufnahmen, robust gegen Stream-Unterbrechungen (Reconnect-Flag).

### 2.2 ffmpeg-Bündelung — Pflichtteil von Installation und Update

Die ffmpeg-Verfügbarkeit ist **kein optionaler Bonus, sondern Bestandteil der Lieferkette**:

- ffmpeg wird **mit der App gebündelt** (bevorzugt: electron-builder `extraResources` mit plattformspezifischen statischen Builds; Alternative: `ffmpeg-static` npm-Paket). Der genaue Weg wird im Phase-1-Spike mit dem bestehenden electron-builder/castlabs-Setup verifiziert (asar + asarUnpack sind bereits im Spiel).
- **Install:** `install.sh` (Linux) und die Mac-Build/Update-Artefakte müssen die Binary für die Zielplattform enthalten — kein „bitte ffmpeg via Homebrew/apt nachinstallieren".
- **Update:** Jedes Update-Artefakt bringt die (ggf. aktualisierte) Binary mit; der bestehende Update-Prozess verifiziert sie nach dem Update (vorhanden + ausführbar + Versionscheck).
- **Selbstheilung beim App-Start:** Prüfung „ffmpeg vorhanden und ausführbar?“ — bei Fehlschlag klare Fehlermeldung in der App (Aufnahme-Features sichtbar degradiert, mit Hinweis auf Neuinstallation), kein stilles Versagen.

**Spike-Ergebnis (30.09.2026, empirisch verifiziert — Karte „Phase 1a“):**

- **Gewählter Weg: eigener Loader (`lib/ffmpeg.js`) über die statischen Builds der ffmpeg-static-Releases** (Release `b6.1.1` = ffmpeg/ffprobe **7.0.2-static**, johnvansickle-Builds, GitHub-Release-Assets). Integrität über im Code festgepinnte SHA-256-Prüfsummen je Plattform (linux-x64, darwin-arm64, darwin-x64; GitHub-Release-Assets sind unveränderlich) — der Upstream veröffentlicht selbst keine Checksummen. Ablageort: `<App-Stamm>/bin/ffmpeg|ffprobe` (im Git-Clone also Update-sicher über install.sh/Updater).
- **`ffmpeg-static` als npm-Paket ist für unsere Lieferkette ungeeignet (Beweis):** Das Paket lädt die Binary in einem `install`-Postinstall-Script — install.sh **und** updater.js laufen beide mit `npm install --ignore-scripts`; im Spike empirisch bestätigt, dass Postinstalls dann nie laufen. Der eigene Loader umgeht das deterministisch (Download + Prüfsumme + `ffmpeg -version`-Smoke-Test + atomares Einspielen).
- **`extraResources`/electron-builder bleibt Nebenebenpfad:** Die etablierten Lieferwege sind (a) `install.sh` = Git-Clone + npm + Castlabs-Electron (Linux **und** macOS, das Mac-App-Bundle symlinked auf das Repo) und (b) der In-App-Updater = `git checkout <Tag>`. AppImages (electron-builder) entpacken nach `resources/app` — der relative Pfad `<App-Stamm>/bin/` funktioniert in allen drei Kontexten ohne Zusatzkonfiguration.
- **Implementiert (v0.5.7):** `lib/ffmpeg.js` (Loader: Health-Check, SHA-256, Download, Smoke-Test, Mindestversion ≥ 7.0.0) · `bin/ensure-ffmpeg.js` (CLI-Wrapper für install.sh/Updater) · `install.sh` ruft nach `build:all` den Ensure-Schritt mit sichtbarem Abbruch bei Fehlschlag · updater.js verifiziert nach jedem Update („Binary vorhanden + ausführbar + `-version` liefert Output“) und lädt fehlende Binaries nach — Fehlschlag bricht das Update sichtbar ab · main.js prüft beim App-Start und zeigt bei Defekt einen Fehlerdialog (Rest der App läuft weiter). Unit-Tests: `tests/ffmpeg.test.js` (node --test).
- **Mac-Verifikation ausstehend (Gerät offline):** Der Darwin-Download-Pfad ist Code-identisch und über die festgepinnten Checksummen abgesichert (`ffmpeg-darwin-arm64.gz`/`ffprobe-darwin-arm64.gz` existieren im Release, SHA-256 erfasst); der Abschluss-Beweis (Binary im laufenden Mac-App-Verbund, `-version` ok) wird beim nächsten Mac-Online-Fenster nachgezogen.

### 2.3 Aufnahmeformat: HLS-Zwischenform + MP4-Remux

- **Während der Aufnahme:** Fragmente (`*.ts`) + wachsende `index.m3u8`-Playlist im Zielordner (gleiches Muster wie unser Test-Harness in `harness/harness_server.py`).
  → Die laufende Aufnahme ist **sofort im Player abspielbar** (Watch-while-Recording), weil hls.js die VOD-Playlist laden kann.
- **Nach dem Stop:** `ffmpeg -i index.m3u8 -c copy -movflags +faststart <Name>.mp4` — Remux ohne Neukodierung, dauert Sekunden. Danach `.ts`-Fragmente + Zwischenplaylist löschen.
- Endform immer `.mp4` (H.264/AAC via stream copy, da die Quellen so liefern).

**Sichtbarkeit der Nachbearbeitung:** Der Remux ist **kein stiller Hintergrundjob**:
- Status an drei Orten: Aufnahmen-Bibliothek („Konvertiere… 43 % · noch ~20 s"), Tray-Menü, Player (falls offen).
- Umsetzung: ffmpeg `-progress`-Ausgabe (`out_time` vs. erwartete Gesamtdauer) → Prozent + Restdauer.
- Die `.mp4` erscheint in der Bibliothek erst nach abgeschlossenem Remux; bis dahin zeigt der Eintrag den Konvertier-Status.
- Robustheit: App-Absturz während des Remux → beim nächsten Start wird der Remux für vorhandene Zwischenstände automatisch nachgeholt (Metadaten-Status `remux-pending`).

### 2.4 Auflösung der Aufnahme

**Die Aufnahme nutzt die native Auflösung des Streams — keine Reduzierung.** Technisch: `-c copy` kopiert die Videospuren 1:1; die App verändert weder Auflösung noch Bitrate. Konkret:
- Liefert der Sender 1080p, wird in 1080p aufgenommen (die HLS-Quellen wählen ihre Variante adaptiv selbst).
- Die Aufnahmequalität ist exakt so gut wie der gerade laufende Stream.
- Eine bewusste **Reduzierung** (z. B. „720p-Sparmodus") wäre ein Re-Encoding (CPU-Last, Qualitätsverlust) — **nicht Teil dieses Konzepts**. Falls später gewünscht: explizite Settings-Option mit dokumentierten Nachteilen.

### 2.5 Wo lebt der Recorder?

Neues Modul `lib/recorder/` im Main-Prozess:
```
lib/recorder/
  RecorderService.js     # Orchestrator: aktive Aufnahmen, Limits, Scheduler-Anbindung
  RecordJob.js           # Ein Job = ffmpeg-Subprozess + Metadaten + State-Machine
  RecordingStore.js      # Persistenz (JSON, analog history.json)
  RemuxJob.js            # Nachbearbeitung: HLS→MP4 mit Fortschritt
  TrayController.js      # Tray-Icon, Menü, Status
```
IPC-Brücke zum Renderer: `recording:start`, `recording:stop`, `recording:list`, `recording:status` (Progress-Events für Remux + Laufzeit).

## 3. Feature-Design

### 3.1 Adhoc-Aufnahme (Phase 1)

- **Record-Button im Player-Chrome** (`tv.html:303–331`, neben dem Live-Button). Rote Optik.
- Klick 1 = Start (ab Live-Kante, „ab jetzt"), Klick 2 = Stopp.
- Alternativ im Bestätigungsdialog: „Bis zum Ende der Sendung" — nutzt EPG-Ende als Auto-Stopp, falls verfügbar.
- **Sichtbarkeit bei Kanalwechsel:** Der Aufnahme-Status ist Bestandteil des Player-Chrome und **blendet mit den Bedienelementen ein und aus** (gleiche Maus-/Tastenaktivitäts-Logik wie die restlichen Buttons) — **keine dauerhafte Einblendung** über dem Bild. Der Chrome zeigt dann: REC-Indikator + **was** aufgenommen wird („● REC 12:34 · Das Erste — Tagesschau"), auch wenn der Player bereits einen anderen Kanal zeigt.
- Der dauerhaft sichtbare Aufnahme-Hinweis liegt im **Tray** (§3.2) — das Video-Overlay bleibt sauber.
- **Kanalwechsel während Aufnahme:** Aufnahme läuft im Hintergrund weiter. Duplikat-Schutz: keine zweite Aufnahme desselben Kanals gleichzeitig.
- Record-Button auf einem Kanal mit laufender Aufnahme: zeigt Status; Klick öffnet Aufnahme-Details (Stoppen möglich).

### 3.2 Tray-Icon + Shutdown-/Beenden-Verhalten (Phase 1, zwingend)

- **Tray-Icon:** Violett mit Play-Dreieck (App-Brand, `assets/icon.svg`: #6c5ce7 → #a78bfa) im Leerlauf; **rot mit weißem REC-Punkt**, solange ≥ 1 Aufnahme läuft — auf einen Blick unterscheidbar.
- Tray-Menü: „● Aufnahme läuft · Das Erste — Tagesschau · 12:34 min" (je Aufnahme), Stopp-Action, „Aufnahmen-Ordner öffnen", App öffnen.
- **Fenster schließen ≠ App beenden**, solange Aufnahmen laufen → App geht in den Tray (Electron `window-all-closed`-Muster, Doku-verified).
- **Shutdown-Unterbrechung:**
  - **macOS:** `powerMonitor` feuert `shutdown` — App zeigt: „Es läuft eine Aufnahme — trotzdem herunterfahren?“ (electron-Doku: Event auf macOS/Windows vorhanden).
  - **Linux:** `powerMonitor` hat **kein** `shutdown`-Event (Doku-verified). **Spike-Befund (30.09.2026, empirisch — Karte „Phase 1a“, Protokoll unten):** `powerSaveBlocker('prevent-app-suspension')` legt unter Linux **keinen** logind-Inhibitor an und kann einen Shutdown **nicht** abfangen. **User-Beschluss 30.09: In-App-Warnung ohne OS-Block (Einfachheit vor Schutzumfang); DBus-Inhibitor bleibt dokumentierte Option für später.**
  - Grenze auf beiden OS: hartes `shutdown -h now` per Terminal ist nicht abfangbar — der Schutz gilt für den normalen grafischen Shutdown-Fluss.

  **Spike-Protokoll (Linux, Castlabs-Electron v42.0.0+wvcus, headless-Host mit Xvfb):**
  1. Elektron-Probe mit `powerSaveBlocker.start('prevent-app-suspension')` → API meldet `id=0, isStarted=true`.
  2. `systemd-inhibit --list` + `/run/systemd/inhibit/` währenddessen: **„No inhibitors.“** (0 Dateien) — logind sieht nichts.
  3. `dbus-monitor` während des Starts: Elektron ruft **keinen** `org.freedesktop.login1.Manager.Inhibit`-Call auf; es profragt nur `org.freedesktop.PowerManagement`, `org.gnome.SessionManager` und `org.freedesktop.portal.Desktop` per `NameHasOwner` (Verfügbarkeits-Probes).
  4. Gegenprobe aus einer GUI-(=active)Session: die logind-API selbst ist polkit-gated — `org.freedesktop.login1.inhibit-block-shutdown` erlaubt `allow_active`/`allow_inactive` = `yes`, `allow_any` = `no` (Policy `/usr/share/polkit-1/actions/org.freedesktop.login1.policy`). Ein gültiger Inhibit-Call aus einer App-Session ist also grundsätzlich möglich — nur tut Elektron ihn für `prevent-app-suspension` nicht.
  5. Qualifikation: getestet wurde headless (Xvfb, SSH-Session → `allow_inactive`-Pfad); der native Shutdown-Fluss (GUI-Logout-Dialog) wurde auf dem Testgerät nicht ausgeführt. Der Befund „kein Inhibitor auf logind-Ebene“ ist jedoch mechanismisch (dbus-monitor) und nicht an die Session-Art gebunden.

### 3.3 Aufnahmen-Bibliothek (Phase 1)

- Neuer Screen „Aufnahmen" im Haupt-UI (analog Mediathek/History-Struktur).
- Einträge: Kanal-Logo, EPG-Titel, Kanal, Datum/Uhrzeit, Dauer, Wiedergabe-Button, Löschen-Button. *(Dateigröße bewusst nicht angezeigt — User-Feedback; sie steht weiterhin in den Metadaten.)*
- Status-Spalte: „Konvertiere… 43 %" (Remux, s. §2.3), „Laufende Aufnahme" (live abspielbar), „Fertig", „Fehlgeschlagen".
- Wiedergabe über den bestehenden Player (lokale `.mp4` oder laufende HLS-Zwischenform).

### 3.4 Settings (Phase 1)

- **Speicherort:** Pfadauswahl; Default `~/Videos/Streaming Hub/`. **Netzwerkpfad erlaubt** (z. B. NAS-Mount) — App validiert beim Setzen: beschreibbar? Platz? (Warnhinweis bei Netzwerkpfad: „Aufnahmen brechen ab, wenn das NAS nicht erreichbar ist").
- ffmpeg-Statusanzeige (Version, ok/Fehler) — Support-Diagnose.
- Platz-Check vor Aufnahme-Start + laufende Größenanzeige (im Tray-Detail, nicht in der Bibliothek).

## 4. EPG-Planung (Phase 2 — NACH Test von Phase 1)

### 4.1 EPG-Erweiterung: Wochenhorizont

**Geprüft gegen die echte Quelle (30.09.2026):** Die aktive EPG-Quelle der App (`iptv-epg.org/files/epg-de.xml`) liefert aktuell **438 Kanäle mit 75.911 Programmplätzen über ~10,2 Tage**. → **Eine 7-Tage-Vorplanung ist mit der vorhandenen Quelle machbar**, ohne neuen Anbieter. Randbedingungen:
- Die XML ist ~50 MB pro Fetch → EPG-Refresh wird entkoppelt: eigener Refresh-Job im Main-Prozess (z. B. 2×/Tag), Cache bleibt aktuell — **auch im Tray-Betrieb** (Pflicht für Planung). Kompression (gzip) der Quelle prüfen (offener Punkt).
- Datenmodell: EPG-Cache muss slot-abrufbar werden („alle Einträge für Kanal X im Zeitraum") statt Nur-Jetzt-Ansicht.

### 4.2 Kanalabhängiges EPG-Programm

Erweiterung der EPG-Ansicht um eine **Kanal-Detailansicht**: Kanal wählen → vertikale Programmliste der nächsten 7 Tage (Jetzt/Als Nächstes hervorgehoben, je Slot ein Aufnehmen-Button). Die bestehende EPG-Grid-/Jetzt-Ansicht bleibt bestehen. **Design bewusst offen:** Vor der Umsetzung gibt es wie gehabt eine Design-Runde mit 2–3 Mockup-Varianten (Referenzen: Apple-TV-App, Infuse, MediathekView) — du wählst verbindlich.

### 4.3 Planungs-Workflow

- „Aufnehmen"-Aktion auf EPG-Slot → Dialog mit Vorbelegung (Titel, Sender, Start/Ende).
- **Puffer konfigurierbar in Settings:** Default-Vorschlag 2 min vorher / 5 min nachher, pro Aufnahme überschreibbar.
- **Schedule-Slip:** 10 min vor geplantem Start EPG erneut laden, geänderte Zeiten übernehmen.
- **Beenden-Dialog bei geplanten Aufnahmen:** Beim Schließen/Beenden der App mit anstehender Planung: „Es ist eine Aufnahme geplant: Das Erste — Tagesschau, heute 20:15. Streaming Hub muss dafür laufen. [Im Hintergrund behalten] [Trotzdem beenden]". Gilt für Fenster-X **und** App-Quit.
- Scheduler im Main-Prozess, überlebt Fenster-Schließen; geplante Aufnahmen im Tray-Menü sichtbar.
- **Wake:** Kein automatisches Aufwecken des Rechners (OS-Territorium, unzuverlässig). Verpasste geplante Aufnahmen (Standby) meldet die App beim nächsten Start.

### 4.4 Parallele Aufnahmen

**Wie viele gleichzeitig?** Technisch begrenzt durch Netzwerk + Platte, **nicht** durch CPU (stream-copy ≈ 1–3 % CPU pro Job):
- Eine HD-HLS-Aufnahme zieht ~2–5 Mbit/s; 3–4 parallele HD-Aufnahmen = ~10–20 Mbit/s — für LAN/WLAN und Platten-IO beider Testgeräte unkritisch.
- **Default-Limit 3 parallele Aufnahmen, konfigurierbar in Settings.** Bei Überschreitung: Warnung mit Auswahl („Trotzdem aufnehmen" / „Verwerfen") statt hartem Block — der User entscheidet, wir warnen.
- Konflikt-Anzeige bei überlappenden Aufnahmen im Planungs-UI bleibt bestehen.

## 5. Dateinamen & Metadaten

- Schema: `<Kanal>_<Sendungstitel>_<YYYY-MM-DD_HHMM>.mp4` (Kollisionen → Suffix `-2`, `-3`)
- Pro Aufnahme ein `<name>.recording.json`:
  ```json
  {
    "id": "rec_...",
    "channelId": "...", "channelName": "Das Erste",
    "epgTitle": "Tagesschau", "epgDescription": "...",
    "startedAt": "2026-09-30T20:15:00+02:00", "stoppedAt": "...",
    "durationSec": 900, "fileSizeBytes": 1234567,
    "sourceUrl": "https://...", "status": "recording|remux-pending|completed|failed|aborted"
  }
  ```

## 6. Plattform-Matrix (Phase 1)

| Aspekt | macOS | Linux |
|---|---|---|
| ffmpeg-Binary | **gebündelt via `lib/ffmpeg.js` (Spike-Ergebnis: statische Builds aus ffmpeg-static-Release b6.1.1, SHA-256-gepinnt, `<App-Stamm>/bin/`)** | **identisch (gleicher Loader)** |
| Record-Button, Bibliothek, HLS-Zwischenform, Remux-Progress | identisch | identisch |
| powerSaveBlocker | `prevent-app-suspension` | `prevent-app-suspension` (legt **keinen** logind-Inhibitor an — Spike 30.09.2026) |
| Shutdown-Warnung | `powerMonitor.shutdown` nativ | **User-Beschluss 30.09: In-App-Warnung ohne OS-Block** (DBus-Inhibitor dokumentierte Option für später) |
| Tray-Icon | MenuBar | AppIndicator (Electron automatisch) |
| Speicherort-Default | `~/Videos/Streaming Hub/` | `~/Videos/Streaming Hub/` |

**Testgeräte:** Mac = Mac Mini (192.168.4.128), Linux = Surface Pro (192.168.4.78) — beide via SSH erreichbar.

## 7. Phasenplan

### Phase 1 — Adhoc-Aufnahme (MVP)
1. **Spike:** ffmpeg-Bündelung in Install + Update-Artefakte (Mac + Linux) verifizieren; logind-Inhibitor-Verhalten auf Linux dokumentieren
2. Recorder-Engine (RecorderService/RecordJob, HLS-Zwischenform, Remux mit Fortschritt)
3. Record-Button im Chrome + Chrome-integrierte REC-Anzeige (blendet mit Controls)
4. Tray-Icon (Brand → REC-Rot) + Shutdown-/Beenden-Verhalten (macOS voll, Linux nach Spike-Befund)
5. Aufnahmen-Bibliothek (Status inkl. Remux-Progress, Wiedergabe)
6. Settings: Speicherort (lokal/NAS-Pfad) + ffmpeg-Status
7. **Dev → QA → User-Test auf Mac → Linux-Smoke → Phase 2**

### Phase 2 — EPG-Planung (Design-Runde vorab)
0. **Design-Runde:** Kanal-EPG-Ansicht als 2–3 Mockup-Varianten → User wählt verbindlich
1. EPG-Erweiterung: Wochen-Cache + Refresh-Job (auch im Tray-Betrieb), Kanal-Detailansicht
2. Planungs-UI (Dialog, Liste, Konflikte, Parallelitäts-Limit 3 / konfigurierbar)
3. Scheduler + Schedule-Slip + Puffer (Settings) + Beenden-Warnung bei geplanten Aufnahmen
4. Tray-Integration für geplante Aufnahmen
5. **Dev → QA → User-Test**

### Phase 3 — Ausblick (nicht Teil dieses Konzepts)
- tvOS/iPad-Pendant (AVPlayer-basiert, geteiltes Datenmodell)
- Record-Daemon auf NAS (Aufnahmen unabhängig vom PC)
- Timeshift-davor-mitretten (DVR-Fenster mitkopieren)
- Automatische Kapitelmarken aus EPG

## 8. QA-Strategie

- **Unit:** RecorderService State-Machine, Dateinamen-Kollision, Metadaten-Schema, Remux-Progress-Berechnung, Parallelitäts-Limit
- **Integration:** ffmpeg-Auflösung (Bündelung), HLS-Zwischenform wächst, MP4 nach Stop abspielbar, Remux-Fortschritts-Events, NAS-Pfad-Fail-Verhalten
- **E2E (Harness!):** lokaler HLS-Server (`harness/harness_server.py`, Port 3001) als stabiles Aufnahme-Ziel ohne echte CDN-Abhängigkeit
- **Manuelle Gerätetests:** Mac Mini + Surface Pro (Shutdown-Mitteilung, Tray-Verhalten, Kanalwechsel-mit-Aufnahme, Remux-Sichtbarkeit)
