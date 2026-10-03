# Changelog

## 0.5.26 (2026-10-03) — macOS-Updater-Fix (default_app.asar ENOENT)

- Fix (Updater, macOS): In-App-Update scheiterte mit `ENOENT, not found in …/Contents/Resources/default_app.asar`. Root-Cause: Electrons asar-fs-Patch behandelt `Contents/Resources/default_app.asar` im Updater-Prozess als Archiv, sodass `copyBundleTree` beim Kopieren des Bundles warf — jedes Mac-Update scheiterte. Beleg: `~/Library/Logs/Streaming Hub/updater.log`; mit Castlabs-Electron reproduziert und behoben. `updater.js` setzt jetzt `process.noAsar = true` (vor allen fs-Zugriffen), `main.js` übergibt `ELECTRON_NO_ASAR=1` an beide `fork()`-Aufrufe. Regressionstest `tests/updater-asar.test.js`.

## 0.5.25 (2026-10-03) — Favoriten-Zapping für FullScreenPlayer (#2) · Qualitätsprüfung (Recorder, Updater, Eingabevalidierung) · E2E-Smoke-Test

- Fix #2: `getNextChannelId` in `packages/typed-core/src/tv.ts` zappt mit ArrowUp/ArrowDown ausschließlich über Favoriten in Sidebar-Reihenfolge. Nicht-Favoriten springen zum nächstgelegenen Favoriten in Pfeilrichtung; Wrap-around bleibt erhalten. Die On-Screen-Senderliste verwendet dieselbe Reihenfolge.
- Fix (Recorder): Retry-Budget und Backoff werden nach einem stabilen Lauf (≥ 30 s) zurückgesetzt — lange Aufnahmen mit vereinzelten Netz-Aussetzern enden nicht mehr als `failed` ohne Remux.
- Fix (Recorder): Reconnect-Attempts (≥ 2) seeken nicht mehr erneut um den DVR-Offset zurück (vermeidet duplizierte Stunden bzw. „could not seek“).
- Fix (Recorder): `failed`-Jobs räumen ihren afterRemux-Callback; `stop()` auf einem bereits beendeten Job lässt keinen Geister-Eintrag zurück.
- Fix (Updater): kein Updater-Prozess/Check/Apply auf Plattformen ohne Release-Pfad (Linux/Windows aus dem Quellcode); Apply-Timeout 15 min (über Download-Timeout), Updater wird bei Timeout beendet, Check-Listener-Leak behoben.
- Fix: Datei-basierte TV-Quellen funktionieren nach App-Neustart wieder; Teil-Updates von Datei-Quellen werden korrekt validiert; Datei-Quellen nur über Dateiauswahl.
- Fix (Sicherheit): XSS über Sendernamen in `tv.html`-Fehleranzeige; Logo-Attribut-Injektion in der Live-TV-Kachel; `recording:delete` löscht nur noch innerhalb der Bibliothek; EPG-Download auf 200 MB begrenzt.
- Tests: vier bisher nicht in `npm test` eingebundene Tests aufgenommen; neue Regressionstests.
- Neu: Playwright-E2E-Smoke-Test (`npm run test:e2e`, `e2e/playwright.config.js`, `e2e/smoke.spec.js`) — startet die echte Electron-App (Castlabs, `_electron.launch()`, kein Browser-Download) und prüft Hauptfenster/Kern-DOM, Konsolen-/Exception-Freiheit beim Start, Favoriten-UI und Aufnahmen-Einstieg. Optional gegen ein gepacktes Artefakt via `E2E_APP_PATH`. `npm test` bleibt unverändert (e2e läuft nicht darin).
- Neu: Test-Hook `STREAMING_HUB_USER_DATA` in `main.js` überschreibt das userData-Verzeichnis (auch den macOS-Default) — der E2E-Test läuft damit nie gegen echte Nutzerdaten. Ohne die Variable ändert sich nichts.

## 0.5.23 (2026-10-02) — Fix-Set 10: Live-Button-Icon entdoppelt (REC-Verwechslung) · DVR-Aufnahme am Sendungsanfang startet jetzt wirklich (Master→Variant-Planung)

- Fix (Befund A, User-Screenshot v0.5.22): In der Player-Leiste standen **zwei optisch identische Ring-mit-Punkt-Icons** zwischen Audio-Button und Vollbild-Pfeil. Identifikation: **Kreis 1 = `tvRecordBtn`** (Aufnahme — Ring mit Punkt, weiß → rot bei Aufnahme); **Kreis 2 = `tvLiveBtn`** („Zur Live-Kante“, DVR — erscheint, sobald der User von der Live-Kante wegnavigiert). Beide SVGs waren bis auf Radien-Detail identisch → Verwechslungsgefahr. Fix: Der Live-Button behält seine Funktion, bekommt aber ein **deutlich unterscheidbares Icon** (Pfeil → gefüllter Punkt = „Springe zum Live-Punkt“); der Aufnahme-Button bleibt das **einzige** Ring-mit-Punkt-Icon in der Leiste. Vorher/nachher-Screenshot beigelegt (Karte t_28a3bff2).
- Fix (Befund B, DVR „Anfang nicht erreichbar“ trotz Fix-Set 9): Root-Cause am echten ARD-Stream empirisch bewiesen — `sourceUrl` ist bei iptv-org-Kanälen die **MASTER-Playlist**, `computeDvrSeek` liefert dort `null` (nicht segmentgenau) → Legacy-`-ss 3600` → ffmpeg-HLS-Demuxer: „could not seek to position“ → seek-degraded-Meldung. Neu: `_resolveSeekPlan()` löst Master → erste Video-Variante (`firstVariantUrl`) auf und plant auf der Variant-Playlist (identisch zu ffmpegs eigener Variant-Auswahl). Zweite, im Labor entdeckte Falle: mit DVR-Rückstand blockiert der Untertitel-Stream (separate Playlist, läuft an der Live-Kante) die ffmpeg-Interleave-Queue — **0 Byte Output**; `-sn` bei Seek-Runs behebt das. E2E am echten Das-Erste-Live-Stream (2-h-DVR-Fenster): Plan `live_start_index -1800` (60-min-Rückstand), ffmpeg liest ab exakt 60-min-zurück-Position, **kein seek-degraded**, MP4 (h264+aac, 1920 s) ffprobe-verifiziert.
- Tests: `tests/recorder-dvr-variant.test.js` (neu, 6 Tests: Variant-Auflösung absolut/I-FRAME-Ignoranz/Malformed, Offline-End-to-End master→variant→Plan -1800, Legacy-Fallback unverändert); 143/144 grün in der Sandbox (recorder-tray pre-existing, braucht Electron-Modul).

## 0.5.22 (2026-10-02) — Fix-Set 9: Aufnahme-Dialog exakt nach User-Anweisung (kleiner Kreis entfernt · 3-Optionen-Dialog IMMER · Sendungsanfang im DVR-Fenster startbar)

- Fix (Befund A): Der kleine rote Blink-Kreis im REC-Chip ist **komplett entfernt** — der User las ihn als zweiten Aufnahme-Button. Es gibt **genau einen** Aufnahme-Button (`tvRecordBtn`, weiß/rot); der Chip zeigt den Zustand rein textlich („REC“ + Uhr + Kanal/Sendung).
- Fix (Befund B, KRITISCH — „Anfang nicht erreichbar“ bei 60-min-Rückstand): Root-Cause gefunden — ffmpeg `-ss <offset>` vor `-i` scheiterte an LIVE-Playlists, weil der HLS-Demuxer am Live-Edge startet (`live_start_index` -3) und von dort nicht zurückseeken kann, obwohl die Position nachweislich im DVR-Fenster liegt (User konnte sie in der Scrubbar anwählen!). Neu: `lib/recorder/dvr-seek.js` liest vor Attempt 1 die Quell-Playlist und übersetzt den DVR-Rückstand **segmentgenau** in `-live_start_index k-m` + Rest-`-ss` ≤ Segmentdauer — der Demuxer startet damit im History-Fenster und liest danach live weiter. Nicht auswertbare Playlist (Master-Playlist, Fetch-Fehler/Timeout 10 s) → Legacy-`-ss`-Pfad, Degrade-Detektor bleibt als Sicherheitsnetz; Attempts ≥ 2 (Reconnect-Naht) unverändert. Beweis auf ARD (2 h): 60-min-Rückstand → Start an der Sendungsanfangs-Position MUSS gelingen (Nachweis via E2E/QA am Mac).
- Fix (Befund C, BINDEND): Der Aufnahme-Start-Dialog hat **GENAU DREI Optionen** — „Ab Bildposition starten“, „Aktuell angezeigte Sendung aufnehmen“, „Bis zum Ende der Sendung“ — egal wie gescrollt ist, **niemals ein anderer Dialog/Toast als Return-Flow**. Die Option „Ab jetzt starten (am Live-Bild)“ ist gestrichen; Option 1 ist am Live-Bild ausgegraut (Tooltip „Bereits am Live-Bild“), Option 3 ohne EPG ausgegraut (Tooltip erklärt). Die Fallback-Modal-Dialoge („Sendung kann nicht erkannt werden …“ / „Zurückspulen nicht möglich …“) sind entfernt — ihre wortgleichen Texte erscheinen als Hinweiszeile im Drei-Optionen-Dialog selbst; der Out-of-Window-Gate für Option 2 greift NUR, wenn der EPG-Sendungsanfang wirklich außerhalb des DVR-Fensters liegt.
- Tests: `tests/recorder-dvr-seek.test.js` (neu, 8 Tests: Segment-Plan 60-min/ARD-2-h-Szenario, Off-Grid-Residual, Out-of-Window, Master-Playlist, ffmpeg-Argument-Order `-live_start_index`/`-ss` vor `-i`, Legacy-Fallback bei Fetch-Fehler, Offset 0 ohne Fetch); Bestandstests auf offline-deterministische Injection umgestellt. 142/143 grün (recorder-tray braucht das Electron-Modul, pre-existing in der Sandbox).

# Changelog

## 0.5.21 (2026-10-02) — DRM/L1-Fix: dev-Klon-Binary wird ab Install EVS-signiert (S-Klasse)

- Fix (S-Klasse, User-Befund 02.10. „in der .20 ist das Streaming geschützter Inhalte kaputt“): Die Developer-Klon-Binary `node_modules/electron/dist/Electron.app` war **nicht** EVS/VMP-signiert (codesign: adhoc/linker-signed, TeamIdentifier not set) — castlabs' Widevine-CDM verweigert L1-Provisioning auf unsignierten Bundles (Netflix E100, Prime 403, CDM init fail). Ursache: `afterPack` (scripts/evs-afterPack.js) signiert nur die Release-Area-Kopie (`release/mac-arm64/…`), während `postinstall` die castlabs-Zip-Dist unangetastet beließ — Release-Builds waren grün (verify-pkg „streaming“ ✓), der User-Test im dev-Klon lief auf invalidem Basis-Binary.
- Fix: `scripts/evs-dev-sign.js` (neu) als postinstall-Schritt nach dem electron-Download: stagt `Electron.app` als `Streaming Hub.app` (castlabs signiert gegen das im Signier-Profil registrierte Bundle „Streaming Hub“), führt `castlabs_evs.vmp sign-pkg` aus, kopiert nur `Electron Framework.sig` zurück (die Signatur bindet an die Framework-Binary, nicht an den Bundle-Ordnernamen) und verifiziert via verify-pkg (Symlink-Staging) — Ergebnis „streaming, NNN days left“. Ausgabe-Präfix `[EVS-dev]` konsistent mit install.sh. Review-Härtungen (R1): Idempotenz-Skip läuft über dasselbe Symlink-Staging (verify am rohen Electron.app-Pfad wäre toter Code — skip-pkg matcht das Bundle am Finder-Namen); die dist-.sig wird VOR dem Austausch gesichert und bei Verify-Fail wirklich zurückgerollt (bzw. neu erzeugtes .sig entfernt); alle Exits laufen nach dem Staging-`finally` (kein ~250-MB-Tempdir-Leak bei Fehlschlägen); sign-pkg/verify-Fail beendet den Hook mit Exit-Code 1 (npm-Fail sichtbar) ohne je eine fehlgeschlagene Signatur zu hinterlassen.
- Regel: Gerät gilt als DRM-kaputt, wenn entweder Release-verify-pkg ODER dev-Klon-Binary-verify-pkg fehlschlägt — der Orchestrator prüft beide bei jedem Release (systemweite Regel).
- Fail-closed im dev-Hook bei Signier-/Verify-Fehlern (Exit 1, dist im Ausgangszustand); mit Warnung (Exit 0) nur, wenn castlabs_evs generell nicht installierbar ist — release/install.sh bleibt fail-closed unverändert; npm-Layout-Kontrakt (Bundle-Name Electron.app in path.txt + electron/index.js) bleibt unangetastet.


## 0.5.18 (2026-10-02) — macOS-Release-Bundle und Installer-Root-Cause-Fixes

- Fix: Der macOS-Wrapper verlinkt `Resources/app` im Release-Modus auf das finale `INSTALL_DIR` statt auf das nach der Installation gelöschte Release-Staging-Verzeichnis.
- Fix: `@streaming-hub/typed-core` ist als Workspace-Abhängigkeit in den Root-Dependencies registriert und wird dadurch in Release-ZIPs unter `app/node_modules` mit ausgeliefert.
- Tests: Vollständige Updater-/Release-/typed-core-Suite, `build:all`, EVS-Signaturprüfung und macOS-Sandbox-/Require-Verifikation.

## 0.5.17 (2026-10-02) — Release-basierter macOS-Updater und Installer

- Updater und Installer beziehen macOS-Releases und Assets direkt von GitHub statt aus dem Repository-Arbeitsbaum.
- Signaturprüfung ist fail-closed; der macOS-App-Build verwendet `asar: false`, damit Layout und Signaturprüfung mit der EVS/castlabs-Pipeline übereinstimmen.
- Rollback-, Bundle- und Release-Asset-Verträge sind erweitert und testverifiziert.


## 0.5.16 (2026-10-01) — Fix-Set 5: Record-Button channelId-Verlust nach tv.html-Reload repariert

- Fix (kritisch, QA A-Fail R2-FB-01, Re-Test-2): Nach einem tv.html-Reload (Dashboard → zurück zum selben Kanal über Kachel/Navbar/Back) blieb der Record-Button WEISS mit „Aufnahme starten (R)"-Tooltip, obwohl die Aufnahme auf dem aktiven Kanal lief — Klick öffnete den Start-Dialog (Zweit-Aufnahme möglich) statt den Stop-Flow. Root-Cause: der loadURL-Pfad in selectTvChannel (Cold-Load nach switchWebview(false) → about:blank) baute die tv.html-URL ohne channelId-Param; die tv.html-Init-Route `setupChannel(..., params.get('channelId') || '')` setzte recChannelCtx.channelId = '' → activeRecordingForCurrentChannel fand nichts (der REC-Chip/Verwalten-Pfad ist zustandsunabhängig und funktionierte korrekt weiter).
- Fix-Teil 1 (URL-Param): selectTvChannel loadURL-Pfad hängt `&channelId=` (encodeURIComponent(ch.id)) an die playerUrl — tv.html liest den Param bereits (Setup-Route), Initial-Load ist damit kanalgebunden korrekt. Alle Eintrittswege (Tile, Navbar, Back-Restore) laufen durch denselben selectTvChannel-Load-Path.
- Fix-Teil 2 (Fallback, Defense-in-Depth): tv.html schickt direkt nach dem Initial-setupChannel eine kontextlose `channel-context`-Anfrage an den Renderer (preload-Whitelist erweitert); der Renderer antwortet via `pushChannelContextToTvView()` mit einem `switch-channel{contextOnly:true}`-Frame — tv.html wendet daraus NUR recChannelCtx + DVR-Modus + EPG-Balken an (applyRecordingState inklusive) und kehrt VOR setupChannel zurück → kein HLS-Replay, kein doppelter Stream-Build. Beide Fixes schließen dieselbe Lücke unabhängig voneinander (URL-Param deckt den Normalfall, contextOnly deckt die Lücke zwischen DOM-ready und dem ersten live-Pfad-Update nach Reload/Restore-Race).
- Tests: 126/127 grün (+8 neue Fix-Set-5-Regressionstests in tests/recorder-fixset5-reload-recchannel.test.js: URL-Param-Invariante in loadURL, tv.html-Init-Lese-Route, channel-context-Whitelist/Handler/Kontext-Antwort, contextOnly-Zweig ohne setupChannel-Replay, Normal- und live-Pfad unverändert). Syntax-Checks 0 errors (ESLint im Scratch-Workspace nicht installierbar, node_modules ist gitignored — lint-frei laut Quelltext-Muster der bisherigen Fix-Sets). Suite-Fail tests/recorder-tray.test.js ist pre-existing in der Sandbox (electron-Modul im scratch node_modules nicht installiert, schlägt auch am unveränderten 8f04142 fehl — keine Regression durch dieses Fix-Set).

## 0.5.15 (2026-10-01) — Fix-Set 4b: Navbar schlank + „Aufnahmen" als reguläres Dashboard

- Fix (UX, User-Befund 01.10. auf v0.5.13): Fix-Set 3 hatte 3 neue Buttons (Aufnahmen/Settings/PiP) in die Navigationsleiste gebracht — die Navbar wurde bewusst schlank gehalten und bleibt es. Entfernt: #recordingsBtn (Aufnahmen kommt stattdessen als Dashboard-Kachel/Navbar-Eintrag), #settingsBtn (doppelt — Einstellungen gibt es als große Dashboard-Kachel), #pipBtn (PiP wird aktuell nicht unterstützt; die togglePip-Verkabelung schläft im Hintergrund, der Strg+P-Shortcut läuft main-seitig weiter). Behalten: Verlauf (#historyBtn).
- Neu (UX, User-Ergänzung 01.10.: KEIN Overlay): „Aufnahmen" ist ein regulärer Dashboard-Bereich (eigene View-Route `recording` im showDashboard/renderDashboard-Satz, gleiche Navigations-Logik wie Mediatheken). Das bisherige recordings-overlay-Markup ist entfernt; die Bibliothek rendert als Panel in dashboardGrid (Header + Liste mit Kanal-Logo, Titel, Kanal/Datum/Dauer, Status, Wiedergabe/Stoppen/Löschen — bisheriger Funktionsumfang unverändert), Esc-Handler/Strg+R/Tray öffnen die View.
- Einstieg (User-Vorgabe 3a/3b): Startdashboard-Kachel „Aufnahmen" zwischen Mediatheken und Einstellungen — Art = generiertes Kachel-Bild (assets/icons/recordings-tile.png + @2x, amber-Familien-Stil: Kartenspiel + REC-Dot + Timeline, bottom-dim für Textlesbarkeit) mit REC-Dot-Badge. Navbar-Eintrag „Aufnahmen" als nav-section-item im Mediatheken-Stil (Icon recordings-nav@2x.png + Label, zwischen Mediatheken und Einstellungen).
- Platz-Prüfung (Messwerte, App-CDP-DOM 1280-Viewport): Navbar unverändert 920px (`min(920px, calc(100vw - 48px))`) — LiveTV x=256/w=132, Streaming x=394/w=132, Mediatheken x=532/w=144, Aufnahmen x=682/w=137, Einstellungen x=832/w=150 (Ende x=982); Overlay-actions (Verlauf) right=1085 → 67px Luft, kein Overlap/Overflow, Back-Button x=195–243 mit 13px Abstand. Startpage-Grid auf repeat(5, minmax(200px, 262px)) erweitert (vorher repeat(4, 220/280): 5. Kachel brach um; jetzt 5 Kacheln à 208px in einer Zeile bis grid-right=1203 < 1280, overflow=false).
- Fix (Engine-Parität, Nebenfund): tests/ffmpeg.test.js „pin-identischer Bestand" scheiterte auf darwin deterministisch — ensureBinary-Schnellpfad erwartete dort ausschließlich die evermeet-Bundle-Pin-SHA und ignorierte die lokal persistierte Installations-Referenz (writeSha256Reference, wird nach jeder verifizierten Installation geschrieben). Darwin-Zweig akzeptiert jetzt die persistierte Referenz zusätzlich zur Pin-SHA; der F-FB-03-Schutz (abweichende Binary → erneuern) bleibt testverifiziert intakt.
- Tests: 166/166 grün (42 updater/typed-core + 124 recorder/core; +7 neue Fix-Set-4b-Tests: PiP-/Settings-Markup entfernt, Kachel-Reihenfolge Mediatheken→Aufnahmen→Einstellungen, generierte Kachel-Art, Navbar-Eintrag im nav-section-item-Stil, showDashboard-Route recording ohne Overlay, Strg+R-Ziel, Overlay-Markup entfernt). ESLint 0 errors; npm run build:all ok.

## 0.5.14 (2026-10-01)
- Diagnose (S-Klasse, User-Punkt 4 abgeschlossen): Die 12-min-Aufnahme (ARD-Mittagsmagazin, sha256 967e84d4…) ist die Ursache — Container vollständig ok (moov vor mdat, faststart korrekt, ffprobe sauber), aber der h264-Elementarstrom ist ab pts≈0,06 corrupted („Invalid NAL unit size"/„missing picture" über weite Teile; nur der erste Keyframe dekodiert). Exakt das User-Symptom: Wiedergabe zeigt ~1 s und stockt, Seek bleibt auf demselben Frame. Nicht die Ursachen aus der Karten-Vermutung: (a) faststart OK, (b) rec://-Range irrelevant — fertige MP4s laden über file:// (recording:get-file), Chromium bedient Ranges nativ, (c) hls.js läuft nie auf MP4. Kontrollprobe: drei andere Aufnahmen desselben Remux-Pfads dekodieren vollständig clean → kein systemischer Remux-Bug; Einstufung: Quell-/DVR-seitige Störung im ARD-Stream, endgültige Klassifizierung via QA-Neuaufnahme (Re-Test-Karte Sz.1).
- Fix (Player, User-Sichtbarkeit): Dekode-/Media-Fehler der Aufnahme-Wiedergabe waren unsichtbar (stummer Freeze ohne Meldung). Neu: Fehlerbanner + TV-Toast bei `error`-Events des Aufnahmen-Players (MediaError-Codes 1–4 mit verständlichen Texten, code=4 = „Die Aufnahme ist nicht lesbar …") und `decoding-error`-Events (Dekode-Fehler mitten im laufenden Stream feuern KEIN MediaError). Banner-Reset beim Öffnen/Schließen; alles im bestehenden Overlay, minimal-invasiv.
- Diagnostik (Remux): Nach jedem Remux läuft eine Decode-Verifikation (`ffmpeg -v error -i MP4 -f null -`) — die Anzahl der stderr-Fehlerzeilen landet als `decodeErrors`/`decodeErrorSample` in den Aufnahme-Metadaten + Log-Warnung. Der Container-Probe (ffprobe duration/size/codecs) sieht korrupte Elementarströme nicht; dieser Blindspot ist damit geschlossen. Datei bleibt `completed` (kein Status-Fallback ohne Beweis), aber eine korrupte Aufnahme ist sofort aus den Metadaten diagnostizierbar statt allein am 1-s-Freeze. RecordJob `_stderrTail` bleibt bewusst unangetastet (Naht-Diagnostik ist QA-Neuaufnahme-Vorbehalt).
- Tests: 117/117 grün (+7 neue Fix-Set-4-Tests: Markup/CSS-Invarianten des Fehlerbanners inkl. z-index/hidden-Vertrag, MediaError-Code-Tabelle 1–4, error/decoding-error-Monitor, Banner-Reset, decodeCheckMp4-Gegenprobe mit echtem ffmpeg an sauberer MP4, normalizeMeta-Schema, RecorderService-Integration ohne Status-Fallback). ESLint 0 errors; npm run build:all ok.

## 0.5.13 (2026-10-01)
- Fix (UX, User-Punkt 1): Aufnahmen-Bibliothek hatte sichtbar KEINEN Einstieg — Root-Cause: der Navbar-Rework v0.5.4 setzte `.overlay-actions { display:none !important; }` global; der Bibliotheks-Button (index.html #recordingsBtn, neben Verlauf/PiP) existierte nur unsichtbar, Zugriff nur via Strg+R/Tray. Neu: `.overlay-bar.always-visible .overlay-actions` explizit sichtbar (absolute rechts in der Top-Bar, inkl. add/pip-Buttons opacity:1); collapsed (Dienst/TV-Player) und Vollbild bleiben unverändert versteckt (Immersions-Prinzip). Die Overlays/Shortcuts an sich waren schon vollständig gebaut.
- Fix (UX, User-Punkt 2): Die „kleiner Kreis"-/„größerer Kreis"-Buttons im Player-Chrome waren EIN Record-Button (Idle-Doppelkreis = Start-Dialog, Aktiv-Stoppquadrat) — ohne Mothover-Tooltips nicht unterscheidbar und laut Repro „ohne Funktion" (Idle-Klick öffnet den Dialog, nicht direkt sichtbar). Neu: Tooltips auf beiden Zuständen („Aufnahme starten (R)"/„Aufnahme stoppen (R) — läuft seit hh:mm:ss") + REC-Chip („Laufende Aufnahme: Klicken zum Verwalten/Beenden").
- Fix (Engine, User-Punkt 3): REC-Zeit-Chip zählte in 5-s-Schritten — Root-Cause: der Chip nahm `recordingSec` aus dem Engine-Snapshot, der per SIZE_TICK_MS=5000 nur alle 5 s kam. Neu: tv.html tickt mit 1-s-Intervall gegen einen Anchor (letzter Engine-Wert + verstrichene Lokalzeit) — 1-s-Auflösung ohne zusätzliche Engine-Last. Format auf hh:mm:ss umgestellt (00:05:23), auch unter 1 h (User-Vorgabe).
- Fix (UX, User-Punkt 4): Klick auf den REC-Chip öffnete den Start-Dialog des aktiven Kanals statt der Verwaltung der laufenden Aufnahme. Neu: Zwei getrennte Wege — Record-Button: weiß=Start-Dialog (ab jetzt/bis Sendungsende), ROT (blinkend, aktive Aufnahme auf DENSEM Kanal)=Klick stoppt sie DIREKT ohne Dialog; REC-Chip: Klick öffnet die Verwaltungsliste (alle laufenden Aufnahmen, jede mit eigenem Stop-Eintrag + Laufzeit, inkl. Aufnahmen auf anderen Kanälen). Im Start-Mode zeigt das Menü bei laufender Aufnahme auf dem aktiven Kanal den Stop-Eintrag statt Start-Optionen.
- Fix (UX, User-Punkt 5): Stopp aus dem Dialog blieb Sekunden stumm (ffmpeg-SIGINT-Grace + Remux-Anlauf), der Chip fror stehend ein. Neu: Die Engine-Phase „stopping" wird als `recording-phase`-Event an tv.html weitergereicht — der Chip geht sofort in den Beenden-Zustand („Aufnahme wird beendet…", Dot friert, Uhr pausiert), das Menü zeigt die beendende Aufnahme als „Wird beendet…"-Eintrag; die MP4-Fertig-Meldung (completed) kommt als TV-Toast „Aufnahme beendet — MP4 bereit: …".
- Tests: 110/110 grün im Recorder-Kern (+11 neue Fix-Set-3-Tests: formatRecTime hh:mm:ss inkl. User-Beispiel 00:05:23, 1s-Anchor-Mechanik, Bibliothekseinstieg-CSS-Invarianten, Tooltips, manage-/start-Modus, Klick-auf-rot=Stop, dynamische Verwaltungsliste, Phase-Bridge, Fertig-Meldung).

## 0.5.12 (2026-10-01)
- Fix (kritisch, S-Klasse, User-Repro 01.10.): In-App-Update brach bei GUI-Start (Finder/Launchpad) ab — „Command failed: npm --version — /bin/sh: npm: command not found". Root-Cause: updater.js startete mit dem System-Mini-PATH (/usr/bin:/bin:/usr/sbin:/sbin); npm lag außerhalb (~/Developer/tools/node/bin). Neu: lib/node-path.js löst npm/node startkontext-unabhängig — Kandidatenverzeichnisse (macOS: ~/Developer/tools/node/bin, Homebrew, volta/asdf/nvm; Linux: /usr/local, /snap, npm-global; Windows: AppData-npm, Program-Files-nodejs), Login-Shell-PATH-Auflösung (zsh -lc/bash -lc) und Env-Override STREAMING_HUB_NODE_DIR. ensureBuildTools() läuft vor allen npm-Aufrufen und setzt den konkreten Pfad in die PATH-Option jedes runSync (npm --version, npm install, npm run build:all). Verifiziert: Headless-Smoke + Mac-Mini-E2E mit exakt GUI-PATH /usr/bin:/bin:/usr/sbin:/sbin — kompletter Apply (Checkout, npm install, build:all, ffmpeg-Ensure) läuft durch; Negativprobe mit gleichem PATH reproduziert den Originalfehler.
- Fix (Fehlerfall): npm nicht auffindbar → Update bricht sauber ab mit verständlicher Meldung im Fehlerdialog (Node.js installieren / install.sh / STREAMING_HUB_NODE_DIR setzen) statt rohem npm-stderr-Toast; der Toast im Renderer zeigt nur die erste Fehlerzeile, den vollständigen Hinweis der Main-Dialog.
- Fix (S-Klasse, zweiter User-Befund 01.10.): Versionsanzeige blieb auf „v0.5.10" obwohl v0.5.11-Code lief — Root-Cause: get-app-version nutzte `git describe --tags --abbrev=0` im Install-Checkout; ohne lokale Tags beschreibt describe den neuen Commit mit dem nächsten erreichbaren ALTEN Tag (v0.5.10-1-g8da8a34). Neu: lib/app-version.js — HEAD-Tag exakt (git tag --points-at) → package.json (wird im Release-Workflow mitgebump't) → Electron app.getVersion(); zeigt nie eine ältere Version. Zusätzlich: check-for-update vergleicht gegen die LAUFENDE App-Version statt dem Checkout-Stand (Update wird nach externem Install-Update weiterhin angeboten); updater-Apply zieht Tags mit zweitem gezieltem fetch nach, falls der Ziel-Tag nach dem ersten Fetch fehlt; install.sh holt Tags explizit nach (+refs/tags/*) und klont mit --no-single-branch.
- Tests: 202/202 grün (updater 37 + typed-core 59 + recorder/core 99 + 10 neue PATH-Tests + 5 neue Versions-Tests) — GUI-PATH-Simulation im node:test (minimales env), Login-Shell-Auflösung, Override-Priorität, Dedup, execSync-Ende-zu-Ende mit Fake- und echtem npm, describe-Reproduktionsfall (Commits nach Tag ohne lokale Tags), Fallback-Kette, Sandbox-Smoke scripts/smoke-updater-gui-path.js ( kompletter Apply-Pfad als fork mit IPC, wie main.js).
- Technical: updater.js — der frühe darwin-only PATH-Ausgleich entfällt zugunsten der kontextunabhängigen Auflösung (systemunabhängig getestet); main.js get-app-version über lib/app-version.js.

## 0.5.11 (2026-10-01)
- Fix (kritisch, F-FB-04-Rest): rec://-Wiedergabe in der echten App weiterhin tot trotz korrektem Handler — Root-Cause bewiesen (QA-Isolationskette): `corsEnabled: true` fehlte in `protocol.registerSchemesAsPrivileged`; Chromium schneidet Fetches von file://-Pages (Origin „null") an nicht-CORS-fähige Schemes ab, bevor der Handler läuft („Failed to fetch"). Privilegien-Set erweitert; Jail (Zeichen-Whitelist + Pfad-Kontainment, 18/18-Traversal-Smoke) unverändert. Headless-Electron-42-Matrix gegen echte Aufnahme-Produkte grün: fetch aus file://-Page 200, hls.js MANIFEST_PARSED + Fragmente + readyState=4, MP4 readyState=4, Traversal geblockt.
- Fix (F-FB-04-Ladepfad): fertige MP4 werden für `<video>` zusätzlich als file://-URL aus dem Bibliotheks-Root geliefert (recording:get-file) — der Media-Element-Ladepfad ist von der Fetch-Privilegien-Matrix unabhängig; Pfad bleibt an Aufnahmen-Root + .mp4 gebunden. hls.js-Pfad (laufende Aufnahme) läuft über rec://.
- Fix (F-FB-07): UI-Record-Start-Bridge tot — Root-Cause: tvView-Guest ist file:// (Origin „null"); `window.postMessage(msg, window.location.origin)` wirft dort „Invalid target origin 'null'", die Nachricht verließ tv.html nie (auch EPG-Poll/Status-Request betroffen; der Host-seitige Empfangs-Gate `e.origin === window.location.origin` matchte nie). tv.html sendet jetzt über sendToHostOrSelf (targetOrigin '*' + Fallback), Gates in preload-content.js und tv.html auf „gleiches Fenster + action-Whitelist" umgestellt (Host validiert recording-Requests weiterhin). E2E-Empirie: Kette Guest→preload(Iso-Welt)→Host-Renderer für recording-status/recording-start/channel-next grün.
- Fix (F-FB-06): setRecordingStorageRoot persistierte nie — `writeJson('recordingSettings', …)` warf „Unbekannter Storage-Typ"; `recordingSettings → recording-settings.json` in STORAGE_FILES (lib/user-storage.js) registriert. Speicherort-Wechsel überlebt jetzt den App-Neustart (Unit-Test).
- Fix (F-FB-08): Remux-Nachholung nach App-Absturz implementiert (Konzept §2.5/§3.3) — Recovery erkennt aborted-Aufnahmen mit erhaltener HLS-Zwischenform (findResumable + hasIntermediateForm) und remuxt nach (Status-Maschine: aborted → completed; remuxInterrupted-Flag als Diagnostik, nach abgeschlossenem Remux zurückgesetzt). aborted ohne Zwischenform bleibt aborted. Unit-Tests für beide Fälle.
- Fix (F-FB-09): Dauer-Anomalie nach Retry-Loop (QA: 66460s MP4 bei ~282s Wandzeit) — Root-Cause: mit append_list nummerierte jeder Reconnect-Spawn die Segment-Dateinamen wieder bei seg_00000.ts und überschrieb frühere Runden, während die Playlist ihre alten #EXTINF-Zeilen behielt. RecordJob schreibt Retry-Attempts jetzt mit attempt-eigenem Segment-Präfix (seg_a2_…), playlistDurationSec dedupliziert Segment-Dateinamen (Schutz für Bestands-Playlists im Recovery-Pfad). Unit-Tests (Dedup-Mathe + attempt-eigene Muster im Retry-Loop).
- Tests: 185/185 grün (updater 27 + typed-core 59 + recorder/core 99) — 8 neue (recordingSettings-Persistenz, Recovery-Remux nach Hard-Kill ×2, Status-Maschine aborted→completed + neue Verbote ×4, Playlist-Dedup ×2, Retry-Segment-Präfix); recorder-service-Fake-ffmpeg schreibt attempt-eigene Segmente.

## 0.5.10 (2026-10-01)
- Fix (kritisch, F-FB-04/05): Wiedergabe von Aufnahmen tot — das rec://-Protokoll lieferte keine Daten („TypeError: callback is not a function“ bei jedem Wiedergabe-Klick). Der Handler nutzte die alte registerFileProtocol-callback-Form; jetzt Electron-42-protocol.handle-Konvention (async handler → Response mit Node-ReadStream), Content-Type je Endung (.m3u8 → application/vnd.apple.mpegurl, .ts → video/mp2t, .mp4 → video/mp4), Content-Length nur für fertige MP4s. CSP (tv.html + index.html) um rec: in media-src/connect-src erweitert.
- Fix (F-FB-05-Verifikation im Headless-Smoke): Dateinamen-Whitelist des rec://-Handlers ([\w.-]+) hat jede reale MP4 mit 404 bedient — Aufnahme-Dateinamen werden aus Kanal-/Titelnamen abgeleitet (safeNamePart) und enthalten Leerzeichen/'@'. Whitelist verbietet jetzt genau das safeNamePart-Inventar (Pfad-Trenner, Windows-Reservierte, Steuerzeichen); Traversal bleibt an Zeichenklasse + Pfad-Kontainment gebunden.
- Fix (F-FB-02): Record-Start im UI blockiert für reale Kanäle („Ungültige Kanal-ID“ für alle IDs mit Leerzeichen/'@', z. B. „DasErste.de@HD“) — Zeicheninventar-Check entfernt, Ablehnung nur noch bei Steuerzeichen. Kanal-ID fließt weiterhin nie in Pfade (rec_*-Job-Dirs mit Whitelist), Duplikat-Schutz pro Kanal unverändert.
- Fix (F-FB-03): ffmpeg-Ensure-Schnellpfad akzeptierte Binary + passenden Marker-Tag ohne Versions-/SHA-Prüfung — auf dem Test-Mac blieb ffmpeg 6.0 dauerhaft stehen. Schnellpfad prüft jetzt Version (≥ 7.0.0) UND SHA-256 gegen die gepinnten Werte; bei Abweichung Download/Ersetzen wie bei frischer Installation. darwin-Pins auf evermeet.cx 7.0.2 umgestellt (die ffmpeg-static-darwin-Assets des Tags b6.1.1 melden 6.0 — der Tag-Name pinnt die macOS-Version nicht), linux bleibt ffmpeg-static b6.1.1. Ensure-Ergebnis und recording:ffmpeg-status melden Version+SHA-256.
- Technical: eslint.config.js — Node-Globals Response (Main-Prozess) und CustomEvent (preload-content) ergänzt.
- Tests: 120/120 grün — 3 neue (ensureBinary ersetzt abweichende Binary trotz passendem Marker-Tag; pin-identischer Bestand läuft ohne Download; reale Kanal-IDs mit @/Leerzeichen erlaubt), recorder-service-Test auf Steuerzeichen-Inventar umgestellt. Headless-Electron-42-Smoke gegen echte ffmpeg-Produkte (MP4/HLS/404/405) grün.

## 0.5.9 (2026-09-30)
- New: Record-Button im TV-Player-Chrome (tv.html) neben dem Live-Button, rote Optik — Start-Dialog mit „Ab jetzt“ und optional „Bis zum Ende der Sendung“ (EPG-Ende als Auto-Stopp im Renderer); auf dem Kanal einer aktiven Aufnahme zeigt der Button Status, Klick → Details/Stoppen; Tastenkürzel R.
- New: REC-Chip als Teil des Chrome („● REC 12:34 · <Kanal> — <Sendung>“) — blendet mit den Bedienelementen ein/aus, zeigt die laufende Aufnahme unabhängig vom gerade gesehenen Kanal (Kanalwechsel-Szenario abgedeckt).
- New: Aufnahmen-Bibliothek (Toolbar-Button / Strg+R, Muster History-Overlay) — Kanal-Logo, Titel, Kanal, Datum/Uhrzeit, Dauer, Status, Wiedergabe, Löschen; bewusst keine Dateigröße. Status-Spalte: „Konvertiere… N % · noch ~Xs“ (Remux-Progress-Events), „Laufende Aufnahme“ (live abspielbar über die HLS-Zwischenform), „Fertig“, „Fehlgeschlagen“, „Abgebrochen“.
- New: Wiedergabe über rec://-Protokoll (privileged scheme, jailt auf <Speicherort>/Aufnahmen/<recId>/, erlaubt nur .m3u8/.ts/.mp4) — fertige MP4 direkt im bestehenden Player-Overlay, laufende Aufnahme via hls.js; CSP media-src/connect-src um rec: erweitert.
- New: Settings „Aufnahmen“ — Speicherort-Pfadauswahl (Ordnerdialog + Freitext, Default ~/Videos/Streaming Hub), Validierung beim Setzen (beschreibbar? Platz?) VOR dem Wechsel, Warnhinweis bei Netzwerkpfad-Heuristik (UNC, smb/nfs/afp/cifs, /mnt|/media|/Volumes), ffmpeg-Diagnose (Version/ok/Fehler); Speicherort wird persistiert (recordingSettings) und beim App-Start geladen — ungültige Pfade fallen auf den Default zurück.
- New: TrayController (lib/recorder/) — Tray-Icon im Brand (violett) im Leerlauf, ROT mit REC-Punkt solange ≥ 1 Aufnahme läuft; Menü je Aufnahme „● <Kanal> — <Titel> · MM:SS“ + Stopp-Action, „Aufnahmen-Ordner öffnen“, „App öffnen“, „Aufnahmen-Bibliothek“, Beenden mit Bestätigung bei laufender Aufnahme.
- New: Fenster schließen ≠ App beenden bei laufender Aufnahme (window-all-closed → Tray); Shutdown-Unterbrechung: macOS powerMonitor 'shutdown' → Dialog „Es läuft eine Aufnahme — trotzdem herunterfahren?“; Linux gem. User-Beschluss 30.09 In-App-Warnung ohne OS-Block (Tray-Notification + Hinweis im App-Fenster), Konzept §3.2 entsprechend finalisiert.
- Technical: Tray-Icons werden zur Build-Zeit aus dem Brand erzeugt (scripts/generate-tray-icons.js, reines Node+zlib, Teil von build:renderer); RecorderService.setStorageRoot (nur ohne laufende Aufnahmen, Validierung vor Wechsel); neue IPC recording:get-file/delete/pick-folder/get|set-storage-root/ffmpeg-status/get-default-root.
- Tests: 117/117 grün — 46 neue (ui-model: formatDuration/currentEpgStopMs/isProbablyNetworkPath, TrayController-Logik mit Electron-Mock inkl. Menü-Format „● Das Erste — Tagesschau · 12:34“, setStorageRoot-Validierung/Wechsel).

## 0.5.8 (2026-09-30)
- New: Aufnahme-Engine im Main-Prozess (lib/recorder/, Konzept §2.3/§2.5) — RecordJob (ffmpeg-Subprozess, HLS-Zwischenform mit wachsender index.m3u8, Reconnect-Robustheit mit Backoff), RemuxJob (HLS→MP4 stream-copy mit `-progress`-Fortschritt in Prozent + Restdauer), RecorderService (Start/Stop, Duplikat-Schutz pro Kanal, Parallelitäts-Limit 3, Start-Checks ffmpeg/Speicherort/Platz), RecordingStore (Metadaten-Schema Konzept §5, atomare Writes, Recovery).
- New: IPC-Brücke recording:start/stop/list/status + Progress-Events (recording:progress, recording:status, recording:reconnecting, recording:changed); preload.exposes electronAPI.startRecording/stopRecording/listRecordings/getRecordingStatus + onRecording* — Renderer-Karte (Record-Button, Bibliothek) konsumiert nur.
- New: Recovery beim App-Start — Remux-Abbrüche (remux-pending) werden nachgeholt, Zombie-Aufnahmen (recording ohne Job) werden zu aborted; Remux-Fehler bleiben remux-pending und werden beim nächsten Start erneut versucht.
- Technical: Empirisch verifizierte HLS-Zwischenform (Probe 2026-09-30): temp_file+omit_endlist+append_list nummeriert Segmente über Reconnects fortlaufend; ohne #EXT-X-ENDLIST hängt der Remux (HLS-Demuxer wartet auf Live-Daten) — Stop sichert ENDLIST defensiv selbst; out_time_ms von ffmpeg ist Mikrosekunden (Namensfalle im Progress-Parsing).
- Technical: Aufnahmen liegen unter <Speicherort>/Aufnahmen/<recId>/ (Default ~/Videos/Streaming Hub); fertige MP4 nach Konzept §5 benannt (<Kanal>_<Titel>_<YYYY-MM-DD_HHMM>.mp4, Kollisions-Suffix -2/-3); Meta-Datei <recId>.recording.json überlebt das Aufräumen der Zwischenform.
- Tests: 71/71 grün — 38 neue Unit-Tests (State-Machine RecordJob mit Fake-ffmpeg, Dateinamen-Kollision, Metadaten-Schema, Remux-Progress-Berechnung inkl. out_time-µs-Falle, Duplikat-Schutz, Parallelitäts-Limit, Recovery/Zombies) + Integrationstest gegen lokalen HLS-Stream (echtes ffmpeg: Aufnahme wächst → Stop → Remux → ffprobe-Verifikation Dauer/Streams, Zwischendateien weg).

## 0.5.7 (2026-09-30)
- Fix: macOS-App-Bundle wird wieder mit castlabs EVS/VMP signiert (Kind "streaming") — die Widevine-CDM registriert sich nur in EVS-signierten Bundles. Ohne Signatur schlugen seit der 0.5.0-Umstellung auf das native Bundle alle DRM-Dienste fehl (Netflix E100, Disney+, Prime).
- Change: install.sh signiert das Wrapper-Bundle nach der Assembly und verifiziert die Signatur (sign-pkg + verify-pkg als Install-Gate); fehlendes castlabs-evs erzeugt eine deutliche Warnung statt eines stillen DRM-Ausfalls.
- Technical: electron-builder afterPack-Hook (scripts/evs-afterPack.js) für Bundle-Builds portiert; sign-pkg läuft über ein Staging-Verzeichnis, da das Tool die App per {dir}/*.app-Glob sucht.
- New: ffmpeg/ffprobe werden mit der App ausgeliefert (Aufnahme-Vorbereitung, Konzept §2.2) — statische Builds aus dem ffmpeg-static-Release b6.1.1 (ffmpeg 7.0.2), SHA-256-gepinnt, Ablage im App-Stamm unter `bin/`.
- New: `install.sh` stellt ffmpeg/ffprobe nach dem Build bereit (Sichtbar-Fehler bei Fehlschlag statt stiller Installation).
- New: Updater verifiziert nach jedem Update Binaries + `ffmpeg -version` und lädt fehlende Binaries nach (Selbstheilung); Fehlschlag bricht das Update sichtbar ab.
- New: App-Start-Check mit Fehlerdialog bei defekten/fehlenden Binaries; Aufnahme-Features degradieren erkennbar, Rest der App läuft weiter.
- Spike: logind-Inhibit-Befund für Linux-Shutdown-Verhalten dokumentiert (docs/StreamingHub-Aufnahme-Konzept.md §2.2/§3.2/§6) — Electron legt unter Linux keinen logind-Inhibitor an; shutdown-Blockierung ist ohne eigenes DBus-Inhibit nicht möglich.

## 0.5.6 (2026-09-30)
- Fix: macOS-Updater startet den Fork mit ELECTRON_RUN_AS_NODE und protokolliert Spawn-, stdout- und stderr-Fehler.
- Fix: Dirty-Trees werden mit checkout --force deterministisch aktualisiert; Apply-Fehler erscheinen sichtbar im UI.
- Fix: Updater-Phasen werden in app.getPath('logs')/updater.log geschrieben.

## 0.5.5 (2026-09-30)
- Change: Minimierte Navbar auf 12px halbiert, damit darüberliegende Web-Inhalte wie das YouTube-Suchfeld frei bleiben.
- Change: Padding der minimierten Navbar auf 0 gesetzt — gerenderte Höhe exakt 12px statt 17px.

## 0.5.4 (2026-09-30)
- Change: Minimierte Navbar nutzt die eingeblendete Navbar-Breite und einen transparenteren Frosted-Glass-Look.

## 0.5.3 (2026-09-27)
- Fix: macOS-App-Launcher schreibt PATH nicht mehr in die Info.plist; Laufzeit-PATH bleibt in App und Updater gesetzt

## 0.5.2 (2026-09-27)
- Fix: macOS-App und Updater erhalten den Node/npm-PATH; der Updater prüft Build-Werkzeuge und Runtime-Artefakte vor Abschluss

## 0.5.1 (2026-09-27)
- Fix: Zurück-Navigation führt wieder auf das neue Startdashboard statt zur alten Welcome-Seite

## 0.5.0 (2026-09-27)
- Update-Button in das neue Dashboard integriert; Update-Status per Hover und Installationsbestätigung bei verfügbarem Update
- Senderbearbeitung neu strukturiert und Stream-URL-Overrides pro Sender ergänzt
- HTTP-Streams für LiveTV-Player und Dashboard-Mini-Player freigegeben
- macOS-Installation auf natives Electron-App-Bundle mit Streaming-Hub-Identität umgestellt
- Laufzeitdateien werden bei Installation und Updates vor dem Start gebaut

## 0.4.84 (2026-09-10)
- W2/W3 (PR #34) + U1–U3 (PR #35) gemeinsam ausgerollet — Details siehe Einträge der Feature-Branches unten (in dieser Version enthalten).
- Fix (U1): DVR-Modus zeigt genau EINEN Fortschrittsbalken — die DVR-Scrub-Bar (Marker, LIVE-Button, ±10s) ist die einzige Bar; der Legacy-Player-Progress-Balken wird im DVR-Modus ausgeblendet (html.tv-dvr-mode → .tv-progress display:none). Nicht-DVR-Sender behalten exakt das alte Verhalten; Host kann pro Sender via `dvr: 'on'|'off'` im switch-channel/epg-update-Signal erzwingen.
- Fix (U2): EPG-Sendungs-Marker erscheinen sofort nach dem Kanalwechsel statt nach Minuten — Host pusht Roh-EPG aktiv bei Kanalwechsel und beim ersten TV-Seiten-Load (pushEpgToTvView) statt nur auf den 30s-Poll zu warten; EPG-Fenster-Selection in typed-core `selectEpgWindowEntries` ausgelagert (unit-getestet). Gemessen (E2E, Electron/CDP): Marker ~0,5 s nach Ladebeginn (Anforderung ≤ 10 s).
- Fix (U3): Tooltip-Flicker behoben — der 250ms-Fenster-Ticker baute die Marker-Elemente periodisch per innerHTML neu (gehovertes DOM wurde zerstört → mouseenter/leave im Millisekundentakt). Marker-DOM wird jetzt in-place synchronisiert (style.left/Tooltip-Text), Rebuilds nur bei geänderter Marker-Menge und nie unter aktivem Hover (pointerover/-out-Guard + Drag-Schutz); Marker-Layer hat pointer-events:none, Marker reaktivieren sie.
- Test: 4 neue Unit-Tests (selectEpgWindowEntries) → 58/58 grün; neuer CDP-E2E scripts/test-u-scrubbar.cjs (ffmpeg-HLS-Fixtures mit PROGRAM-DATE-TIME + CORS-Fileserver + Electron unter Xvfb): DVR-Kanal → genau 1 sichtbare Bar, Marker ≤ 10 s, Tooltip-DOM-Identität über 2 s Hover stabil, Nicht-DVR-Kanal unverändert.

## 0.4.83 (2026-09-10)
- Feature: TV-Player DVR-Timeshift – Rückspulen im DVR-Fenster des Live-Streams (Scrub-Bar, ±10s-Skip, Taste L = Live-Kante), wirksam für alle Sender mit DVR-Fenster (Das Erste, ARD/MDR/NDR/WDR/SWR/hr/rbb, One, tagesschau24, phoenix u. a.)
- Feature: EPG-Sendungs-Marker in der Scrub-Bar – Klick springt an den Sendungsbeginn, Tooltip mit Titel + Startzeit
- Fix: 21 kaputte/dead ARD-Familien-Stream-URLs via channelOverrides ersetzt (u. a. MDR Thüringen), alle DVR-Fenster live verifiziert
- Fix: Updater – tvsources.json wird beim Update jetzt per 3-way-Merge zusammengeführt (User-Favoriten/Sortierungen/eigene Overrides bleiben, Release-URL-Fixes kommen durch; vorher wurden Release-Fixes stillschweigend zurückgerollt)
- Fix: Tippfehler im Timeshift-Label (· TIMESHIFT) und Audio-Button-Label ohne Sprach-Klammer
- Technical: typed-core epgWindow.ts (DVR-Fenster↔EPG-Mapping) + Unit-Tests; Updater-Merge-Logik mit 26 Unit-Tests (npm run test:updater); Nach-Update-Reconciliation beim App-Start (holt den tvsources-Merge nach, wenn ein älterer Updater beim vorherigen Update noch blind überschrieben hat)
## Unreleased (feature/tv-error-zapping, in 0.4.84 enthalten)
- Fix (W2): Fehlerdialog bei nie startendem Stream – Load-Watchdog bewaffnet sich sofort beim Kanalstart (vorher erst nach `playing`), fatale hls.js-NETWORK_ERRORS werden nicht mehr endlos per `startLoad()` retryt (max. 4 Strikes, Reset nur bei echtem Lebenszeichen); nach 25s bzw. bei Strikes erscheint das persistente Fehler-Overlay mit Sendername + „Pfeiltasten ↑/↓ oder Senderliste (T) zum Wechseln" statt endlosem Ladezustand
- Fix (W3): Zapping (Pfeiltasten ↑/↓) bricht nicht mehr still ab, wenn der aktive Sender kein Favorit ist – kanonische Zapping-Reihenfolge via typed-core `buildZapOrder`/`getNextChannelId`: alle Sender des aktiven Quellservices, Favoriten zuerst (Sidebar-Reihenfolge); On-Screen-Senderliste (`buildChannelList`) folgt derselben Reihenfolge
- Test: 5 neue/angepasste Unit-Tests in typed-core (buildZapOrder, getNextChannelId-W3, buildChannelList-W3), 54/54 grün; Bundle-Smoke-Tests (renderer lädt, Key-Pipeline), W3-Vollverdrahtungstest (Zap-Sequenz ab Nicht-Favorit per Sidebar-Click + Keydown) und W2-CDP-QA (Szenarien toter Host / conn-refused / echter Stream via Fixture-HLS-Server) unter scripts/

## 0.4.82 (2026-06-10)
- Chore: Test-Release – Original-Restart aus v0.4.81 aktiv

## 0.4.81 (2026-06-10)
- Revert: Update-Restart auf Original zurückgesetzt (app.relaunch + app.quit)
- Entfernt: Alle execSync/gtk-launch/kill-9 Experimente

## 0.4.80 (2026-06-10)
- Chore: Test-Release – kill -9 aus v0.4.79 aktiv

## 0.4.79 (2026-06-10)
- Chore: Test-Release – kill -9 aus v0.4.78 aktiv

## 0.4.78 (2026-06-10)
- Fix: Restart – kill -9 $PID statt process.exit (Electron blockierte alle exit-Varianten)
- Change: gtk-launch → 1s sleep → SIGKILL auf eigenen Prozess

## 0.4.77 (2026-06-10)
- Chore: Test-Release – process.exit aus v0.4.76 aktiv

## 0.4.76 (2026-06-10)
- Fix: Restart – process.exit statt app.exit (app.exit beendete alte Instanz nicht zuverlässig)

## 0.4.75 (2026-06-10)
- Change: parseM3U in main.js durch typed-core parseM3UFull ersetzt (55→14 Zeilen)
- Fix: ID-Erzeugung + Name-Cleaning bleiben kompatibel (nichts bricht)
- Chore: typed-core Build aktualisiert

## 0.4.74 (2026-06-10)
- Chore: Test-Release – Restart mit gtk-launch v0.4.73 aktiv

## 0.4.73 (2026-06-10)
- Fix: Restart via gtk-launch (Desktop-Environment startet App – kein Prozessgruppen-Konflikt)
- Change: Alle execSync/setsid/nohup-Experimente raus – gtk-launch ist zuverlässig

## 0.4.72 (2026-06-10)
- Chore: Test-Release – identischer Restart-Code wie v0.4.71 (setsid + sleep)

## 0.4.71 (2026-06-10)
- Fix: Restart – 1s sleep nach setsid vor app.exit (Session braucht Zeit zum Initialisieren)

## 0.4.70 (2026-06-10)
- Fix: Restart – setsid vor nohup (komplette Trennung aus Prozessgruppe)
- Lokal getestet: setsid + execSync = Kind überlebt Parent-Exit garantiert ✅

## 0.4.69 (2026-06-09)
- Fix: Restart – execSync + nohup statt exec (exec war asynchron, app.exit kam zu früh)
- Lokal getestet: Parent stirbt, Kind (electron) lebt weiter ✅

## 0.4.68 (2026-06-09)
- Fix: Restart crashte – GPU-Konflikt durch parallele Instanzen (app.exit statt app.quit)
- Fix: DISPLAY env explizit übergeben
- New: EPG für alle Sender in Channel-Liste (v.0.4.67)

## 0.4.67 (2026-06-09)
- New: EPG-Informationen für ALLE Sender in der Channel-Liste (nicht nur aktiver)
- Change: Item-Höhe auf 62px angepasst (Platz für EPG-Zeile)
- Fix: Kein Overlap – items wachsen natürlich, EPG 16px, margin 2px

## 0.4.66 (2026-06-09)
- Change: backdrop-filter:blur(12px) auf allen Overlays (jetzt sicher – Bug in renderer.js gefixt)
- Change: Floating-Card-Stil für tv-top + tv-controls wiederhergestellt (einheitlich)
- Fix: renderer.js switchWebview – tvView.style.pointerEvents = 'auto' statt ''
- Beibehaltung: video mousemove fallback, channel-list z-index 15

## 0.4.65 (2026-06-09)
- Fix: TV-Webview blockierte Maus-Events – pointer-events:auto statt '' (CSS .tv-view hat none)
- Das war die Ursache: Keine Mausbewegung/Buttons seit v0.4.54

## 0.4.64 (2026-06-09)
- Fix: .tv-controls EXAKT wie Original (kein pointer-events nirgendwo)
- Fix: video.addEventListener('mousemove', showOverlay) als Fallback
- Change: Channel-List z-index 25→15 (kein Overlap mit controls)

## 0.4.63 (2026-06-09)
- Fix: .tv-top + .tv-controls auf Original-Positionierung zurückgesetzt (full-width, gradient)
- Fix: .tv-epg-bar wieder mit eigenem background (wie vor v0.4.58)
- Change: pointer-events:none wenn unsichtbar, auto wenn sichtbar (für controls)
- Behält: Channel-List Sidebar, EPG im Overlay, dynamische Höhe

## 0.4.62 (2026-06-09)
- Fix: backdrop-filter aus allen Overlays entfernt (blockierte Maus-Events in Electron)
- Fix: Restart mit Shell-exec + & statt spawn (garantierte Detach)
- Change: Hintergrund rgba(0,0,0,0.7) statt 0.6 – Tiefe ohne backdrop-filter

## 0.4.61 (2026-06-09)
- Fix: Restart nutzt process.execPath direkt statt npm start (unabhängig von PATH)
- Change: Kein shell:true mehr – electron binary direkt gespawnt

## 0.4.60 (2026-06-09)
- Fix: TV-Overlays (top/controls) nicht bedienbar – pointer-events:none wenn unsichtbar, auto wenn visible
- Fix: backdrop-filter + opacity Compositing-Layer blockierte Maus-Events

## 0.4.59 (2026-06-09)
- Fix: Channel-List füllt jetzt dynamisch 2/3 Viewport-Höhe (vorher 4 Items hardcodiert)
- Fix: Restart nach Update mit detached:true – wird nicht mehr vom Parent abgewürgt

## 0.4.58 (2026-06-09)
- Change: Alle TV-Overlays auf einheitlichen Stil umgestellt (rgba 0.6, blur 12px, radius 12px)
- Change: TV-Kanal-Overlay Höhe auf 2/3 Viewport vergrößert
- Change: .tv-top (Kanalname) jetzt als Floating-Card oben links
- Change: .tv-controls (Player-Steuerung) als Floating-Card unten mit Abstand zum Rand
- Change: EPG-Bar ohne eigenen Hintergrund (liegt auf Controls auf)

## 0.4.57 (2026-06-09)
- Fix: App-Neustart nach Update funktioniert jetzt (app.relaunch → spawn npm start)
- Change: Neustart nutzt start.sh-Pfad (ELECTRON_DISABLE_SANDBOX, prestart build)

## 0.4.56 (2026-06-09)
- Change: TV-Kanal-Overlay auf Sidebar-Format umgestellt (schmaler, rechter Rand 4px)
- Change: Transparenz an EPG-Bar angeglichen (rgba 0.6, backdrop-filter 12px)
- Change: Slide-In von weiter rechts (translateX 120px)
- Change: Items kompakter (28px/18px Schrift, 40px Logos)
- Fix: TypeScript moduleResolution node→node16 (Build-Kompatibilität)

## 0.4.55 (2026-06-09)
- Change: TV-Kanal-Overlay vom Bildschirmzentrum an den rechten Rand verschoben
- Change: Slide-In-Animation von rechts (translateX + Fade)
- New: EPG-Informationen im aktiven Kanal des Overlays (Sendungstitel unter Sendernamen)
- Change: Schriftgrößen für TV-Lesbarkeit optimiert (32px Sender, 20px EPG)
- Fix: Lange Sendernamen (z.B. MDR Thüringen) werden nicht mehr abgeschnitten (max-width: 520px)

## 0.4.54 (2026-06-09)
- Change: MagentaTV nutzt Safari-User-Agent (umgeht HDCP-Warnung)

## 0.4.53 (2026-06-09)
- New: TV-Modus-Umschalter in Einstellungen (FreeTV / MagentaTV)
- New: MagentaTV-Modus – TV-Button öffnet web.magentatv.de im Webview
- Change: MagentaTV als Service registriert (unter Streaming)
- Change: Sidebar + Pfeiltasten deaktiviert im MagentaTV-Modus

## 0.4.52 (2026-06-09)
- Revert: Zurück-Button komplett entfernt (v0.4.48–51) – als Gitea Issue #12 dokumentiert

## 0.4.47 (2026-06-09)

## 0.4.47 (2026-06-09)
- Fix: Zurück-Button z-index 51 (über Sidebar), Polling alle 2s statt Event-basiert

## 0.4.46 (2026-06-09)
- Fix: Zurück-Button – canGoBack() synchron, did-navigate-in-page (YouTube SPA), dezenter Glow

## 0.4.44 (2026-06-09)
- New: Zurück-Button als Hover-Fläche links oben (←-Pfeil, nur sichtbar bei canGoBack)

## 0.4.43 (2026-06-09)
- Fix: TV-Sidebar schließt zuverlässig per mouseenter/mouseleave (wie TopBar)
- Change: Polling + IPC-Forward entfernt – einfaches relatedTarget-Pattern

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
