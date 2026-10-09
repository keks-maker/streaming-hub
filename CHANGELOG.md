# Changelog

## Unveröffentlicht

- Neu: Geplante Aufnahmen können den Mac aus dem Ruhezustand wecken (nur macOS, optional). Settings → LiveTV: Aufnahmen: „Aufwecken erlauben“ startet nach Admin-Passwort-Abfrage (`osascript … with administrator privileges`) einen Root-Helfer (`lib/recorder/wake-helper.sh`, `/bin/sh`, inline per `sh -c` übergeben, nie aus einer Datei), der nur solange die App läuft existiert und per FIFO (root-eigenes Verzeichnis `/var/run/streaminghub-wake-<uid>-<token>`, FIFO nur für die UID) ausschließlich `wake`/`cancel <MM/dd/yy HH:mm:ss>` und `quit` annimmt (strikte Musterprüfung, Owner-Tag `StreamingHub`, kein Shell-Interpolieren). Keine dauerhafte Systemänderung.
- Neu: `lib/recorder/WakeScheduler.js` (Wecktermin = effektiver Start − 5 min; Abgleich bei `schedule:changed`, Helfer-Start; Persistenz `wake-schedule.json`; ohne Helfer No-op), `WakeHelperClient.js` (Start, Senden mit `O_NONBLOCK`, Orphan-Sweep beim App-Start), `ipc-wake.js` (`wake:get-status|enable|disable`, `wake:changed`, `requireMainRenderer`, `validateNoPayload`).
- Neu: Hinweis in „Geplant“ („Wecken aktiv“ bzw. „Ruhezustand: …“ mit Link in die Settings).
- Docs: Aufnahme-Konzept §4.3 („Wake“) angepasst. Tests: `tests/wake-scheduler.test.js`, `tests/wake-helper.test.js` (Helfer-Skript mit Mock-pmset).

## 0.9.8 (2026-10-08) — Änderungen im Update-Dialog

- Neu: Update-Dialog mit Änderungen. Klick aufs Update-Icon öffnet statt `confirm()` einen Dialog (`#updateNotesOverlay`, Klassen `modal`/`update-notes-*`) mit den Release-Texten (GitHub-Release-`body`) aller Versionen seit der installierten, neueste zuerst; erst "Installieren" startet `apply-update`, "Abbrechen"/Esc/Klick daneben schließt.
- Check-Ergebnis um `notes: [{ version, name, body }]` erweitert (`updater.js` über `selectReleaseNotes`, AppImage-Pfad in `main.js` über `releaseNotesFromReleases` mit paginierter Releases-Liste, IPC `check-for-update`). Draft/Prerelease/fremde Tags wie bisher ausgeschlossen; leerer/fehlender `body` ergibt "Keine Details". `parseReleaseCandidate` liefert zusätzlich `name` und `body`.
- Neu: `update-notes-model.js` — Minimal-Markdown (Überschriften #–###, Listen, **fett**, `code`, Absätze, Links als Text), Rendering nur per `createElement`/`textContent` (kein `innerHTML`).
- Neu: Test-Hook `STREAMING_HUB_UPDATE_URL` (Basis-URL der Release-API, Default `https://api.github.com`) gilt jetzt einheitlich für Check, Notes und Updater-Prozess (`lib/update-base.js`); wirksam nur bei ungepackter App oder lokalem http (localhost/127.0.0.1), sonst ignoriert. E2E `e2e/update-dialog.spec.js` (Mock-Server) prüft den Update-Dialog.
- Tests: `tests/update-base.test.js` (neu), `tests/update-notes-model.test.js` (neu), Ergänzungen in `tests/github-releases.test.js`.

## 0.9.7 (2026-10-08) — Neues App-Icon

- Neu: Neues App-Icon (Glas/3D) — `assets/icon.svg`, `icon.png`, `icon.icns`.
- Neu: Neue Menüzeilen-Icons (Aufnahme mit rotem Punkt) — `scripts/generate-tray-icons.js` rendert `tray-idle.png`/`tray-rec.png` im A3-Stil (32px, transparent).

## 0.9.6 (2026-10-08) — Favoriten quellenübergreifend sortierbar

- Behoben: Bei mehreren TV-Quellen wich die Favoriten-Reihenfolge im Dashboard von der in den Einstellungen ab. Ursache: Dashboard (`renderer.js`) und Einstellungen (`settings-tv-channels.js`) leiteten die Reihenfolge je Quelle getrennt aus `favorites` ab und fügten die Quellen unterschiedlich zusammen.
- Neu: Globale, quellenübergreifende Favoriten-Reihenfolge. Pro Quelle trägt `favoriteRank` die Position in der globalen Liste; `globalFavoriteList` (`lib/settings-channel-logic.js`) bildet daraus die eine Reihenfolge, die Dashboard und Einstellungen gemeinsam nutzen. Neue IPC `set-favorite-order` (Preload, `main.js`) nimmt eine Liste `{ sourceId, id }` entgegen und schreibt `favoriteRank`/`favorites` je Quelle; Validierung über `favoriteOrder` in `lib/input-validation.js` (max. 20000 Einträge, Längengrenzen).
- Altpfad: `setSourceFavorites` hält `favoriteRank` bei Umsortierung über `update-tv-source` konsistent.
- Behoben (`lib/tvsources-merge.js`, `mergeSource`): `favoriteRank` wird zusammen mit `favorites` aus der Nutzerkopie übernommen, sobald eines von beiden verändert wurde; `channelOverrides` der Nutzerkopie werden bei fehlendem Wert als leeres Objekt gemergt statt `null`.
- Tests: `tests/favorites-global-order.test.js` (neu), Ergänzungen in `tests/settings-channel-logic.test.js`.

## 0.9.5 (2026-10-06) — Eigenes GitHub-Release je Plattform/Architektur (Intel-Mac)

- Neu: Release-Kategorien in `lib/github-releases.js` (`RELEASE_TARGETS`, Schlüssel `plattform-arch`): `darwin-arm64` unverändert (Tag `vX.Y.Z`, Asset `Streaming.Hub-X.Y.Z-mac.zip`), `darwin-x64` mit eigenem Tag `vX.Y.Z-x64` und Asset `Streaming.Hub-X.Y.Z-mac-x64.zip`. Linux ist später nur ein weiterer Tabelleneintrag. Ein Client berücksichtigt nur Releases seiner Kategorie; Versionsvergleich nur innerhalb der Kategorie. Der alte Parser (`^vX.Y.Z$`, 0.9.x) sieht x64-Tags nie als Kandidat (Test mit eingefrorener Kopie `tests/fixtures/github-releases-0.9.4.js`).
- In-App-Updater: Kategorie aus `process.platform`/`process.arch` des laufenden Builds (eine unter Rosetta laufende x64-App aktualisiert sich mit dem x64-Release); Env-Override `STREAMING_HUB_RELEASE_TARGET` für Tests.
- `install.sh`: Arch-Erkennung per `uname -m`, in Rosetta-Shells (x86_64 auf Apple Silicon) korrigiert über `sysctl -n hw.optional.arm64`; Override `STREAMING_HUB_ARCH=arm64|x64`. Release-Auswahl nach Kategorie; gibt es keins, klare Meldung (Intel: "Für Intel-Macs (x64) gibt es noch kein Release") statt Fallback auf das falsche Asset. Vor dem Staging prüft `file`, dass das Hauptprogramm (Mach-O) zur Rechner-Architektur passt; sonst Abbruch ohne Installation. Asset-Name stammt aus dem Release.
- Build: `npm run build:mac:x64` (`scripts/build-mac-x64.js`): castlabs-Electron-x64 laden/cachen (`~/.cache/streaming-hub/electron`), `electron-builder --mac --x64` nach `release-x64/`, EVS `verify-pkg`, `codesign --verify`, Mach-O-Prüfung, Asset nach `release/upload/` mit Schema-Namen (`--dir` für Smoke-Test ohne ZIP). `package.json`: `release/` und `release-x64/` sind von den App-Dateien ausgeschlossen (sonst landet das arm64-Artefakt samt Symlinks im x64-Paket: `ensureSymlink`-Fehler bei abweichendem Output-Ordner). arm64-Build unverändert.
- Tests: `tests/github-releases.test.js` (Kategorien, Linux-Platzhalter, alter Parser), `tests/install-arch.test.js` (Arch-Helfer in bash, gefälschte Releases-API gegen `install.sh`). `scripts/vm-install-test.sh`: Szenario `archcheck` (x64-Override ohne x64-Release) und `install.sh` läuft dort mit der lib des Repo-Stands.
- Hinweis: 0.9.x-Installationen bleiben auf arm64-Releases (alter Parser); die x64-Releases beeinflussen sie nicht.

## 0.9.4 (2026-10-06) — install.sh: Release-Installation ohne EVS

- Behoben: `install.sh` brach im Release-Modus ohne `castlabs_evs` mit "invalid Info.plist (plist or signature have been modified)" ab. Ursache: Das signierte Release-Bundle wird nach dem Kopieren verändert (Info.plist-Werte, `Resources/app`-Symlink, Icon); das Siegel war ungültig und wurde ohne EVS nur geprüft, nie neu erzeugt. Jetzt wird das Bundle ad-hoc neu signiert (`codesign --force --deep --sign -`, wie `scripts/evs-afterPack.js`) und danach verifiziert (ohne `--strict`, da `Resources/app` bewusst auf das Installationsverzeichnis außerhalb des Bundles zeigt).
- Release-Modus: Info.plist-Werte und Icon werden nicht mehr angefasst, wenn das Build-Bundle sie bereits korrekt trägt (`plutil -replace` und `stage-mac-icon` nur bei Abweichung). Die VMP/EVS-Signatur bleibt dabei gültig (`verify-pkg` geprüft, auch nach der ad-hoc Neusignierung).
- Neu: Ohne EVS warnt `install.sh`, dass DRM-Dienste (Netflix, Disney+, Prime Video) eingeschränkt sein können. Der EVS-Pfad bleibt unverändert.
- Test: `tests/install-codesign.test.js`.
- Behoben (In-App-Updater): Auf Macs ohne Xcode Command Line Tools scheiterte das Update in `verifyBundleIntegrity` an `otool -L` (nur xcode-select-Shim, "No developer tools"). Fehlt otool (erkannt per `xcode-select -p` bzw. Shim-Meldung), prüft der Updater stattdessen den Mach-O-Header des Haupt-Binaries; die Abhängigkeiten sichern Framework-/Symlink-Prüfung und das vorgeschaltete Signatur-Gate (EVS verify-pkg / codesign). Meldet ein vorhandenes otool einen Fehler, bleibt es beim Abbruch.
- Behoben (In-App-Updater): Ohne EVS war das Bundle nach `installMacBundle` für `codesign --verify --deep` ungültig (Symlink `Resources/app` bricht das Siegel). Der Updater signiert das Staging-Bundle nach dem Setzen des Symlinks ad-hoc neu und verifiziert es (ohne `--strict`); scheitert das, bleibt der alte Stand (Abbruch vor dem Swap). Mit EVS wird nicht neu signiert, die VMP-Signatur bleibt gültig. Zusätzlich räumt der Updater das Wrapper-Staging-Verzeichnis bei Abbruch vollständig.
- Test: `tests/updater-otool-resign.test.js`.

## 0.9.3 (2026-10-06) — EPG-Datenweg im Main (Etappe 3.7)

Renderer-Datenweg des EPG abgelöst (AUF-E6 / EPG-E5): Der Renderer lädt und parst keine EPG-Datei mehr; alle Verbraucher lesen den Main-Cache über IPC.

- Neue IPC (Paket A): `epg:now-next` (`getEpgNowNext(keys[])` -> `[{channelKey, current, next}]`, 1–600 Schlüssel) und `epg:channels` (`getEpgChannels()` -> `[{normId, channelId, sampleTitle}]`).
- Renderer: Jetzt/Nächste liegen in einem Cache (`epgNowNextCache`, je Kanal `{current, next}` in ms), der aus `epg:now-next` gefüllt wird (Start, `epg:changed`, minütlich, beim Zappen frisch für den gewählten Sender); abgelaufene Sendungen werden zeitlich fortgeschrieben (`resolveNowNext`). `loadEpgData` und `collectEpgUrls` sind durch `syncEpgFromMain` ersetzt (Status über `epg:status`/`epg:refresh`, Kanalliste über `epg:channels`, läuft nie parallel, `epg:changed` frischt Dashboard und Senderverwaltung auf). Ohne EPG-URL: Status `unavailable`; ohne Daten/Netz bleiben Anzeigen leer (kein Fehlerzustand im Player).
- Umgestellt: Dashboard-Kacheln (`getCurrentEpg`), Auto-Stopp „bis Sendungsende“ und Aufnahme-Titel (`epgListForChannel`), Zapping/Senderkontext (`buildEpgContextForChannel`, `selectTvChannel`), rechte Senderliste im Player (`channelList[].epg`), `epg-update` an `tv.html` (`buildEpgUpdateMessage`, ersetzt die zwei Duplikatblöcke in `sendEpgUpdate`/`pushEpgToTvView`; DVR-Fenster über `epg:range-many`, 3 h zurück/2 h voraus), Settings-Kanalzuordnung (`getEpgIndex` liefert jetzt ein Set der normalisierten IDs, `getEpgChannelList` die Liste aus `epg:channels`).
- Adapter `lib/epg/renderer-adapter.js` (rein, Unit-Tests `tests/epg-renderer-adapter.test.js`): ms -> XMLTV-Zeitstring (`YYYYMMDDHHMMSS +0000`) für `tv.html` und `currentEpgStopMs`, `nowNextToMap`, `resolveNowNext`, `channelEpgKey`, `chunk`. EPG-Titel sind im Main bereits entity-dekodiert; der Renderer dekodiert nicht mehr nach und rendert Fremdtexte nur als Text.
- Entfernt: `loadEpgData`, `tvEpgIndex`, `tvEpgData`, `tvEpgUrls`, IPC `fetch-epg` samt Preload `fetchEPG` und Main-Imports (`fetchEpgResponse`, `parseXMLTV`, `MAX_EPG_BYTES`), ESLint-Global `tvEpgIndex`. typed-core-Exporte (`parseXMLTV`, `buildEpgIndex`, `getEpgChannelList`, `epgWindow`) bleiben. Der E2E-Hook `STREAMING_HUB_EPG_FIXTURE` speist nur noch den Main-`EpgService`.
- Verhaltensänderung: EPG-URLs aus dem M3U-Header (`url-tvg`) lädt der Renderer nicht mehr; stattdessen übernimmt der Main beim Laden einer Quelle ohne `epgUrl` die erste gültige http(s)-URL des Headers einmalig als `epgUrl` (persistiert, `lib/tvsources-header-epg.js`) und stößt den EPG-Sync an. Eine vorhandene `epgUrl` wird nie überschrieben; der `EpgService` nutzt ausschließlich die `epgUrl` der Quellen.
- Tests angepasst: `tests/dashboard-hub.test.js`, `tests/epg-ipc.test.js`, `e2e/smoke.spec.js`, `e2e/schedule.spec.js`, `scripts/test-u-scrubbar.cjs`.

## 0.9.2 (2026-10-06) — Fix Release-Paket

- Behoben: 0.9.1 schloss `scripts/` komplett aus dem Paket aus; `install.sh` braucht im Release-Staging aber `scripts/stage-mac-icon.js` (MODULE_NOT_FOUND, Installation brach mit „App-Icon konnte nicht konsistent ins Bundle gestagt werden“ ab). `build.files` schließt jetzt nur noch die übrigen Skripte aus und behält `scripts/stage-mac-icon.js`. `docs/` und `tests/` bleiben ausgeschlossen; weitere Laufzeitabhängigkeiten auf ausgeschlossene Dateien gibt es nicht.
- `install.sh` prüft das Skript vor dem Aufruf und bricht mit klarer Meldung ab, statt mit einem Node-Stacktrace.
- Neu `tests/package-files.test.js`: jede in `install.sh`/`updater.js`/`main.js` referenzierte `scripts/*.js` darf durch `build.files` nicht ausgeschlossen sein (eigener Matcher für die Glob-Reihenfolge von electron-builder).

## 0.9.1 (2026-10-05) — LiveTV-Hub

LiveTV-Hub (Variante A, `docs/mockups/etappe3/hub-a.html`): Programmübersicht und Aufnahmen werden zwei gleich große Einstiegskarten im LiveTV-Dashboard; die Dashboard-Vorschau „Jetzt im TV“ und die linke TV-Sidebar (Altlast vor der UI-Umstellung, seit der Umstellung nur noch per `hidden` ausgeblendet) entfallen; der NavBar-Eintrag „Aufnahmen“ wird durch einen Indikator-Punkt am LiveTV-Eintrag ersetzt (P21–P24, Ä9). Keine neue IPC, keine neue Abhängigkeit. Die rechte Senderliste im Player (`tv.html`) und der Zapping-Weg sind unverändert.

- Karten: Neu `dashboard-hub-model.js` (rein: `countRecordings`, `recordingsCardModel`, `epgCardModel`) und `dashboard-hub-view.js` (Factory `createDashboardHub(root, { api, getEpgInput, onOpenEpg, onOpenRecordings, logger })`; nur `textContent`, `innerHTML` nur für die festen Icons). Karte links „Programmübersicht“ (ID `dashboardEpgOpen`, P22; öffnet `openEpgView`): nur Statuszeile „EPG aktuell · N Favoriten“ (nach `tvEpgStatus`; bei `error`/`unavailable` nur „N Favoriten“, weil der Programmführer den Main-Cache liest), ohne Favoriten der Hinweis „Favorisiere Sender, um die Programmübersicht zu sehen“ (Karte bleibt klickbar, im Programmführer gilt P14). Karte rechts „Aufnahmen“ (ID `dashboardRecordingsOpen`; öffnet `showDashboard('recording')`): „N läuft · M geplant · K fertig“ (läuft = roter pulsierender Punkt, geplant = roter statischer Punkt, Ä4), „Noch keine Aufnahmen“, bei fehlendem ffmpeg „ffmpeg fehlt · Aufnehmen nicht möglich“ (Warnton, Karte bleibt klickbar, bestehende Aufnahmen bleiben erreichbar). Daten über `schedule:list` (state `scheduled`), `recording:list` (`recording`/`completed`) und `recording:ffmpeg-status` aus der vorhandenen Preload-API; Aktualisierung beim Öffnen des Dashboards und gebündelt (250 ms) bei `onScheduleChanged`, `onRecordingChanged` und Aufnahme-Snapshots, nur bei sichtbarem LiveTV-Dashboard; veraltete Antworten werden per Zähler verworfen. Der ffmpeg-Status (führt im Main synchron `ffmpeg -version` und eine SHA-256 aus) wird nur abgefragt, bis er „ok“ ist.
- Werkzeugleiste: drei Werkzeuge `dashboardTvSettings`, `dashboardTvStatusBtn`, `dashboardTvRefresh` samt `dashboardTvStatus`/`dashboardCount` (IDs unverändert) stehen jetzt in einer ruhigen Leiste unter den Karten (Icon + `.dashboard-hub-tool-label`; der Refresh-Text läuft über das Label). Breiten: ab 900 px nebeneinander mit Beschreibungszeile, unter 900 px kompakt (Beschreibung und Pfeil entfallen), unter 640 px gestapelt und die Werkzeuge nur als Icons (`title` bleibt). Tokens `--rec` (#ff5d5d = `--epg-rec`), `--warn` (#fbbf24 wie die Favoriten-/Hinweisfarbe) und `--border-strong` jetzt in `:root` von `styles.css` (Mockup-Werte auf vorhandene Literale abgebildet); `prefers-reduced-motion` schaltet Karten-Transitions und Pulse ab.
- NavBar (P21): Eintrag `recording` aus `renderNav` entfernt. Am LiveTV-Eintrag sitzt ein Punkt `.nav-live-dot` (ohne Zahl) mit Screenreader-Text „Aufnahme läuft“ (`.sr-only`), sichtbar solange `recordingState.active` nicht leer ist (`updateNavRecordingIndicator`, aufgerufen aus `applyRecordingState` und nach jedem `renderNav`); pulsierend, bei `prefers-reduced-motion` statisch. Der Aufnahmen-Bereich bleibt erreichbar über die Karte, `Strg+R` und das Tray-Menü (`recordings:open`).
- Entfernt: Abschnitt `#dashboardEpg` (`index.html`), `renderDashboardEpg` samt Handlern `dashboardEpgRefresh` (EPG-Aktualisieren bleibt über `dashboardTvRefresh` und im Programmführer), CSS `.dashboard-epg*`, `.dashboard-section-heading/-title/-actions`. Linke TV-Sidebar: Markup `#tvSidebar`/`#tvSidebarTrigger`, CSS `.tv-sidebar*`/`.tv-search-input`, `openTvSidebar`/`closeTvSidebar`/`toggleTvSidebar` (ohne Aufrufer; der Zweig `tvMode === 'magenta'` darin war damit schon unerreichbar), Hover-/Außenklick-/Esc-Logik, Sidebar-Button-Handler, `tvSidebar*`-Variablen, `tvBtn` und der Kanal `sidebar-close` (`preload-content.js`, `renderer.js`). Behalten wurde nur `renderTvChannels` (als dünner Auffrischer der Senderverwaltung in den Einstellungen); die zunächst behaltenen Hilfsfunktionen und Zustände des „Alle Sender“-Overlays (`renderSourcePills`/`renderTvManagerSources`, `tvCollapsedGroups`, `tvSearchFilter`, `.tv-channel-empty`) sind mit dem Overlay entfernt, siehe den folgenden Punkt.
- „Alle Sender“-Overlay entfernt (Zusatz, User-Entscheid): Der Button `#dashboardTvManage` war der einzige Einstieg in das alte Overlay `#tvChannelManagerOverlay` (`openTvChannelManager`; ein Tastenkürzel, Settings-Link oder der Programmführer öffneten es nicht, nur `selectTvChannel` und die Esc-Kette schlossen es). Damit entfallen Markup, CSS (`.tv-channel-manager*`, `.tv-source-pill*`, `.tv-channel-item/-group/-fav/-drag/-empty …`), `openTvChannelManager`/`closeTvChannelManager`, `renderTvChannelItem`, `renderTvManagerSources`/`renderSourcePills`/`toggleSource`, `toggleFavorite`, `reorderChannel` sowie die Zustände `tvChannelView`, `tvFavoriteSortMode`, `tvSelectedSourceIds`, `tvSearchFilter`, `tvCollapsedGroups` (samt `localStorage`-Schlüssel `tv-collapsed-groups`, der ungenutzt liegen bleibt). `renderTvChannels` bleibt als dünner Auffrischer der Senderverwaltung in den Einstellungen (Seite `livetv-channels`, Button `#dashboardTvSettings`, unverändert); "Alle Sender zeigen" im Programmführer (P14) ist ein eigener Weg und unberührt.
- Startdashboard (Zusatz, User-Entscheid): Die Section-Kachel „Aufnahmen“ ist entfernt (wie der NavBar-Eintrag, P21); das Startdashboard hat vier Kacheln (LiveTV, Streaming, Mediatheken, Einstellungen), das Grid `.dashboard-view.start-page .dashboard-grid` ist von fünf auf vier Spalten umgestellt (sonst stünde die Reihe außermittig). Entfernt: Eintrag `recording` in `sections` samt `rec-dot`-Sonderfall, CSS `.dashboard-section-recording*`, Assets `assets/icons/recordings-tile.png`, `recordings-tile@2x.png` und `recordings-nav@2x.png` (letzteres war seit dem Entfernen des NavBar-Eintrags ungenutzt). Der Aufnahmen-Bereich (`showDashboard('recording')`, Tabs) bleibt über die Karte, `Strg+R` und das Tray-Menü erreichbar; die Tastaturkürzel-Hilfe nennt jetzt `Strg+R` und „Live-TV öffnen“ (statt des veralteten „TV Sidebar umschalten“ für `Strg+T`).
- Aufrufer: Verlaufsklick auf „TV“ öffnet das LiveTV-Dashboard (`showDashboard('livetv')`); `openChannel` des Programmführers („Sender öffnen“) wählt nur den Sender (`selectTvChannel`).
- Ladeweg (Vorab-Klärung b): `openTvSidebar` rief `loadTvChannels()` und, wenn `tvEpgIndex` fehlte oder `tvEpgStatus` `unavailable` war, `loadEpgData(...)`. Index und Senderliste laden weiter beim Start (`getTvSources`), bei Quellenänderung (`refreshTvSourcesAndEpg`) und manuellem Refresh; das Nachladen liegt jetzt in `ensureTvDataLoaded()` (aufgerufen beim Öffnen des LiveTV-Dashboards, nie parallel zu einem laufenden Ladevorgang).
- Doku: Die README-Screenshots `startseite.png`, `navbar.png`, `livetv-dashboard.png`, `aufnahmen-dashboard.png`, `tv-senderverwaltung.png`, `settings.png`, `einstellungen-aufnahmen.png` und `verlauf.png` zeigen die neue Oberfläche (Beispieldaten); sie entstehen mit dem neuen Skript `scripts/readme-screenshots.js` (isoliertes Profil, 1280×800 bei Skalierung 2). `epg-*.png` und `aufnahme-dialog.png` zeigen keine NavBar-Einträge und bleiben unverändert; die Alt-Texte der Screenshots sind angepasst.
- Paketinhalt bereinigt: `build.files` schließt zusätzlich `docs/`, `tests/`, `scripts/`, `assets/screenshots/`, `.eslintrc.json`, `.prettierrc`, `eslint.config.js`, `.gitignore`, `CHANGELOG.md` und `README.md` aus (zur Laufzeit liest die App nichts davon; `afterPack` und `build-renderer` liest electron-builder aus dem Projekt). ZIP 189 200 914 → 176 897 216 Byte (−12,3 MB); `bin/` (ffmpeg, ffprobe), `assets/icons|tray|icon.*`, `lib/`, `dist/`, `node_modules/` und `packages/` bleiben.
- Tests: Neu `tests/dashboard-hub.test.js` (Zählung, Zustände keine Aufnahmen/ffmpeg fehlt/keine Favoriten/Fehler, Karten-Ansicht über Fake-DOM, Ladeweg, NavBar-Indikator, Reste-Scan Sidebar/Vorschau) und `e2e/livetv-hub.spec.js` (Karten, Klickziele, Planung live, laufende Aufnahme per lokalem HLS-Live-Stream mit Indikator inkl. reduzierter Bewegung, drei Breiten, Verlaufsklick, „Sender öffnen“, Zustand ohne Favoriten). Angepasst: `tests/epg-view-wiring.test.js`, `tests/recorder-fixset4b-dashboard.test.js` (FIX 3b), `e2e/epg-navigation.spec.js`, `e2e/epg-anzeige-b.spec.js`, `e2e/epg-overlay.spec.js`, `e2e/schedule.spec.js`, `e2e/smoke.spec.js`, `e2e/epg-helpers.js` (Maus nach dem Öffnen aus der Navbar-Zone). `eslint.config.js` führt die zwei neuen Module in der Renderer-Gruppe.

## 0.9.0 (2026-10-05) — Suche, Filter und Detailansicht

Der Programmführer bekommt seine Kopfzeile nach B2/F3 und zeigt die Daten aus 0.8.0: Suche, Senderauswahl, „Mehr ▾“, dritter Modus „Jetzt & Gleich“ und konfigurierbare Startansicht (Etappe 3.5), dazu Genre-Chips als Filter, ein erweitertes Detail-Modal mit Poster, Metazeile, Besetzung und „Läuft auch“ sowie Vorschaubilder in „Jetzt & Gleich“ (Etappe 3.6; Entscheid `docs/aufnahme-etappe3-design-entscheid.md` §0). Insgesamt eine neue IPC (Startansicht, Etappe 3.5) hinter `requireMainRenderer`, kein weiterer Settings-Schalter (P12), `lib/epg/*` und `lib/recorder/*` bleiben unverändert, die CSP bleibt unverändert (`img-src 'self' data: https:`). Sidebar, Dashboard-EPG, DVR-Marker, Zapping und die Kanalzuordnung in den Einstellungen bleiben am Renderer-Weg (bis 3.7). Die Einträge sind nach Etappen gegliedert.

### Etappe 3.5: Kopfzeile, Suche und Startansicht

- Kopfzeile (B2/F3): oben Suche · Modus-Segment „Liste | Raster | Jetzt & Gleich“ · „Jetzt“ · Stand · Aktualisieren; darunter die Schnellfilter-Leiste mit den Tages-Tabs, „Sender ▾“ und „Mehr ▾“ (neue Module `epg-menu-view.js` für die Aufklapp-Menüs, Klick außerhalb und Esc schließen). In „Jetzt & Gleich“ entfallen die Tages-Tabs (die Ansicht zeigt „jetzt“); die Kanalansicht (3.4) ist weiter ein Modus ohne eigenen Segment-Knopf.
- Suche (M8/P11): Neu `epg-search-model.js` (rein: Eingabe 2–80 Zeichen — Steuerzeichen entfernt, auf 80 gekürzt —, Abfrageplan, Zusammenführen, Treffer → Zeilen, Anzeigezustand, Anfragenzähler) und `epg-search-view.js` (Trefferliste über dem Inhalt: Titel · Sender · Wochentag Uhrzeit, mit Datum bei Terminen mehr als 6 Tage entfernt). Die Suche nutzt das vorhandene `epg:search` (3.1; gefaltet, Umlaute/ß/Groß-Kleinschreibung) über die gewählte Senderauswahl vom ersten Tag der Tagesleiste bis zum Cache-Ende (höchstens 14 Tage), höchstens 100 Treffer (Hinweis bei mehr), mehr als 600 Sender in Blöcken. Entprellt (250 ms); jede Anfrage trägt eine Nummer, Antworten veralteter Anfragen und nach dem Schließen werden verworfen. Beschreibung nur mit dem Schalter „Beschreibung durchsuchen“ unter „Mehr ▾“ (Standard aus, Sitzungszustand). Zustände: zu kurz, lädt, Fehler, keine Treffer (mit Hinweis auf den Schalter), keine Sender in der Auswahl. Klick auf einen Treffer: Suche schließt (Feld wird geleert), Sprung im aktuellen Modus (Liste: Tag und Zeile, aktiver Tab folgt; Raster: Zeitanker und Sender; Jetzt & Gleich: Tag und Zeitanker werden für den Wechsel gemerkt), danach öffnet das Detail-Modal. Esc-Kette jetzt: Rückfrage → Detail-Modal → geöffnetes Menü → Suche (leert und verlässt sie) → Kanalansicht → Overlay; Esc in Eingabefeldern (Suche, Optionen) wird im Overlay selbst in die Kette geleitet, weil der globale Handler Eingabefelder überspringt.
- Senderauswahl (EPG-E3, P14): Neu `epg-selection-model.js` (rein: Favoriten (Standard) · Alle Sender · Quelle · Gruppe aus `tvChannels`, Prädikat, Gruppen-/Quellenliste mit Zählern, Beschriftung). Ein Filter für alle Modi: `epg-view.js` bildet daraus einmal die Senderliste, die Liste, das Raster, „Jetzt & Gleich“ und die Suche lesen (die Mockup-Lücke „Filter nur auf Liste/Suche“ ist nicht übernommen). Reiner Sitzungszustand, kein Setting; ein Moduswechsel behält Auswahl, Tag und Zeitanker, ein Wechsel der Auswahl lädt die Daten neu und behält Modus, Tag und Position. Der Button „Alle Sender zeigen“ (P14, ohne Favoriten) setzt dieselbe Auswahl. `selectChannels` (`epg-view-model.js`) nimmt dafür ein optionales Prädikat `include`; der Ansichtszustand führt `selection` und `hideNoEpg` (`showAll` bleibt als abgeleitete Kurzform).
- „Mehr ▾“: „Sender ohne EPG ausblenden“ (Standard an; Raster und „Jetzt & Gleich“, ohne Neuladen; aus: Raster zeigt leere Zeilen, „Jetzt & Gleich“ „Kein EPG im Cache“) und „Beschreibung durchsuchen“. `gridRowsFor(entries, null)` zeigt alle gewählten Sender.
- „Jetzt & Gleich“ (M7, dritter Modus): Neu `epg-jng-model.js` (rein: Abruffenster jetzt … +12 h, laufende/nächste/übernächste Sendung je Sender, Randfälle keine laufende Sendung/Lücken/überlappende Daten/kein EPG, Signatur der Zuordnung, Zeilenhöhen, schmales Layout) und `epg-jng-view.js` (virtualisierte Zeilen fester Höhe, Logo wie im Raster mit `safeResourceUrl` und Kürzel-Fallback, ein Klick-Handler für alle Zellen). Zellen sind die neue Variante `'jng'` von `epg-row-dom.js` und nutzen dieselbe `updateRowNode`-Logik (Marker rot, geplant statisch/laufend pulsierend, Fortschritt, Toggle-Beschriftung) wie Liste und Kanalansicht; der Toggle läuft über dieselbe `runToggle`-Funktion (P9 unverändert) — keine zweite Aufnehmen-Logik. Klick auf eine Sendung öffnet das Detail-Modal, Klick auf den Sendernamen die Kanalansicht (Zurück mit Esc, Fokus auf den Sendernamen). Daten über `epg:range-many` (schlank) in Blöcken zu 100 Kanälen; der 30-s-Takt schreibt die Zuordnung fort (Fortschritt, Marker, Wechsel der laufenden Sendung) und baut nur Zeilen neu auf, deren Zuordnung sich geändert hat; nach 60 min Neuabruf, Neuladen bei `epg:changed`. Unter 900 px Fensterbreite stehen die drei Zellen eines Senders untereinander (feste Zeilenhöhe 250 px statt 84 px), ohne horizontales Scrollen.
- Startansicht (P20): Neue Einstellung „Startansicht des Programmführers“ unter Einstellungen → LiveTV → EPG: Automatisch (Standard) · Liste · Raster · Jetzt & Gleich. Automatisch: Fensterbreite ≥ 900 px → Liste, 899 px und darunter → Jetzt & Gleich (`resolveStartMode`). Neu `lib/epg-view-settings.js` (Werte, Normalisierung — Altdaten ohne das Feld und manipulierte Werte laden mit „auto“ —, Auto-Schwelle) und `lib/epg-view-settings-ipc.js` (`epg-view:get-settings`/`epg-view:set-settings`, Muster wie `recording:get-settings`; beide hinter `requireMainRenderer`; `validateEpgViewSettingsPatch` in `lib/ipc-validation.js` lässt nur ein Objekt mit genau `startView` aus der festen Menge zu, nur der normalisierte Wert wird gespeichert; Registrierung in `main.js` außerhalb des EPG-Dienst-Blocks). Persistenz in `epg-view-settings.json` (neuer Eintrag `epgViewSettings` in `lib/user-storage.js`), Preload-Whitelist `getEpgViewSettings`/`setEpgViewSettings`. Das Overlay setzt den Startmodus bei jedem Öffnen; der Segment-Umschalter wirkt nur bis zum Schließen und wird nie gespeichert; eine geänderte Einstellung gilt ab dem nächsten Öffnen.
- Verhalten sonst unverändert: Marker (P10), P9-Hinweis, Navbar im Programmführer, ein Aufnahme-Button im Player, Start-Dialog mit drei Optionen. Neue Dateien werden über `renderer.js` ins esbuild-Bundle aufgenommen (kein weiterer Eintrag in `package.json`/`electron-builder` nötig, `files` enthält `**/*`); `eslint.config.js` führt sie in der Renderer-Gruppe.
- Tests: Neu `tests/epg-view-settings.test.js` (Werte, Migration, manipulierte Werte, Auto-Schwelle 899/900, IPC mit `requireMainRenderer`, Persistenz, Verdrahtung), `tests/epg-selection-model.test.js`, `tests/epg-search-ui.test.js` (inkl. Faltung/Umlaute über `EpgStore.search` und `validateEpgSearch`), `tests/epg-jng-model.test.js`; angepasst `tests/epg-view-wiring.test.js` (drei Segment-Knöpfe, erweiterte Esc-Kette, `applyInert`). E2E: Neu `e2e/epg-navigation.spec.js` (Startansicht, Einstellung, schmales Fenster, Jetzt & Gleich inkl. 30-s-Takt mit gesteuerter Uhr, Senderauswahl in allen Modi, „Mehr ▾“, Suche mit Sprung in Liste/Raster/Jetzt & Gleich, Esc-Kette, Öffnen/Schließen ohne Reste, Großfixture 438 Kanäle „Alle Sender“); gemeinsame Helfer jetzt in `e2e/epg-helpers.js` (`epg-overlay.spec.js` nutzt sie).

### Etappe 3.6: Genre-Filter und Detailansicht

Anzeige B (B2/F3): Die Daten aus 3.2 werden sichtbar — Genre-Chips als Filter in der Schnellfilter-Leiste, Poster/Metazeile/Besetzung/„Läuft auch“ im Detail-Modal, kleine Vorschaubilder in „Jetzt & Gleich“. Etappe 3.6 braucht keine neue IPC.

- Genre-Chips (F3, M4): Neu `epg-genre-filter-model.js` (rein: Gruppen film, serie, news, sport, doku, kinder, show, musik, sonstiges aus `epg-genres.js`, an/aus, Filterregeln, Sitzungszustand) und `epg-genre-chips-view.js` (Chips „Alle“ + neun Gruppen mit Namen als Text und Farbpunkt, per Tastatur bedienbar, `aria-pressed`, aktive Chips tragen ein ✕ zum Entfernen). Raster: nicht passende Blöcke werden gedämpft (Struktur bleibt, Klick öffnet weiter das Detail). Liste und „Jetzt & Gleich“ filtern wirklich (Liste: nur passende Zeilen, die Tageskopfzeilen bleiben, Hinweis „Keine passenden Sendungen“ mit „Genre-Filter aufheben“; „Jetzt & Gleich“: Positionen laufend/danach/danach bleiben, nicht passende Zellen entfallen, Sender ohne passende Zelle verschwinden). Suche: Treffer werden nach Genre gefiltert — `epg:search` liefert kein Genre, es kommt aus den geladenen Zeilen, Treffer außerhalb davon werden per `epg:range-many` je Sender nachgeschlagen; mit Filter werden bis zu 200 Treffer geholt und auf 100 gekürzt. Sendungen ohne Kategorie passen zu keiner aktiven Gruppe. Der Filter ist Sitzungszustand wie die Senderauswahl (kein Setting): er bleibt beim Moduswechsel und beim Schließen/Öffnen des Overlays. In der Kanalansicht sind die Chips ausgeblendet. Genre-Tabelle (P13) unverändert.
- Detail-Modal (M6, EPG-E4/E7): Neu `epg-detail-model.js` (rein: Bild-URL-Prüfung `safeIconUrl` — nur http/https mit Host, ohne Zugangsdaten, ≤ 512 Zeichen —, Metazeile, Besetzung, „Läuft auch“-Auswahl) und `epg-detail-view.js`. Die Zeit-/Senderzeile (`#epgDetailMeta`) und die neue Metazeile „Genre · Jahr · Dauer · S2 E3“ (`#epgDetailInfo`) sind getrennt; Besetzung „Regie: … · Mit: …“ (bis 4 Namen alle, darüber drei und „… + N weitere“), Untertitel und Altersfreigabe nur wenn vorhanden (E7), Poster rechts (`loading="lazy"`, fester Rahmen, Fehler → nur das Bild entfällt, kein Layoutsprung). Fehlen Felder, entfallen die Zeilen — das Modal bleibt neutral. „Aufnehmen“ bleibt der primäre Button unter der Metazeile. „Läuft auch“: `epg:search` mit dem exakten Titel über alle Sender mit EPG ab jetzt, nur Termine im Cache, der geöffnete Termin ausgeschlossen, höchstens 5 (Rest als „+ N weitere Termine“); Klick springt zum Termin und öffnet dessen Detail. Daten über `epg:find` (volle Projektion).
- Vorschaubilder in „Jetzt & Gleich“ (EPG-E4): kleines Bild links in jeder Zelle, fester Platzhalter (Anfangsbuchstabe auf Farbfläche, die Zelle springt nicht). Die schlanken Daten tragen kein Bild; für die sichtbaren Zeilen (nur Viewport, entprellt 120 ms) holt die Ansicht die Bild-URLs mit `epg:range` je Sender und setzt sie lazy ohne Referrer. Keine Vorab-Downloads, kein eigener Bildcache; fällt der Bilddienst aus, bleibt der Platzhalter, alles andere unberührt. Messung (Playwright, 6 Läufe, Bilder auf 400 ms gedrosselt): Zeit bis zur Anzeige der Liste „Jetzt & Gleich“ Median 11 ms bei 120 Sendern, 14 ms bei 438 Sendern (Kriterium < 300 ms) — die Thumbnails bleiben in „Jetzt & Gleich“.
- Sicherheit: Fremdtexte (Titel, Untertitel, Besetzung, Altersfreigabe) nur per `textContent`; `javascript:`/`data:`/`file:`/`blob:`-Bild-URLs werden nie geladen (der Parser verwirft sie schon, `safeIconUrl` prüft zusätzlich). http-Bild-URLs aus eigenen EPG-Quellen werden von der bestehenden CSP geblockt — es entfällt nur das Bild.
- Tests: Neu `tests/epg-genre-filter-model.test.js`, `tests/epg-detail-model.test.js` (Bild-URL-Prüfung, Metazeile, Besetzungskürzung, „Läuft auch“, Verdrahtung/CSP), `tests/epg-b-display-fixture.test.js`, Testhelfer `tests/helpers/epg-b-display-fixture.js` (alle B-Felder, Lücken, bösartige Werte, Bildfehler, viele Sender für die Messung); angepasst `tests/epg-search-ui.test.js`. E2E: Neu `e2e/epg-anzeige-b.spec.js` (Chips in Liste/Raster/Jetzt & Gleich/Suche, Überleben beim Moduswechsel, Modal mit und ohne B-Felder, „Läuft auch“, bösartige Werte nur als Text, Bildfehler und http-Icon, Bild-Requests mitgezählt: keine ohne Nutzeraktion, nur sichtbare Zeilen, Messung); `e2e/epg-overlay.spec.js`/`e2e/epg-navigation.spec.js` an die getrennte Metazeile und die Chips angepasst.

## 0.8.0 (2026-10-05) — Programmführer neu

Neuer EPG-Programmführer nach Design B2 (Listen-zentriert; Entscheid `docs/aufnahme-etappe3-design-entscheid.md` §0) mit Liste, Raster, Kanalansicht und einheitlichem Aufnehmen/Abbrechen/Stoppen. Grundlage sind neue Main-API und ein erweitertes EPG-Datenmodell im Main-Cache. Der Programmführer liest ausschließlich den Main-Cache (`epg:range-many`, `epg:find`, `epg:status`); Sidebar, Dashboard-EPG, DVR-Marker, Zapping und die Kanalzuordnung in den Einstellungen bleiben am Renderer-Weg (`tvEpgIndex`, bis Etappe 3.7). Die Einträge sind nach Etappen gegliedert.

### Etappe 3.1: Main-API und reine Logik

Main-API und reine Logik für den Programmführer (EPG-Konzept A-1/A-2). Keine sichtbare Änderung an der Oberfläche in dieser Etappe; die Schnittstellen werden von der UI aus 3.3 genutzt.

- EPG-Raster-API (A-1): Neue IPC `epg:range-many(channelKeys, fromMs, toMs)` liefert für bis zu 100 Kanäle in einem Aufruf schlanke Slots `{ start, stop, title }` (ohne Beschreibung; Details weiter über `epg:find`/`epg:range`; mit 3.2 zusätzlich `genre`). Zeitraum höchstens 14 Tage, höchstens 25 000 Slots je Aufruf — darüber gibt es einen klaren Fehler statt stillem Abschneiden. Antwort: `[{ channelKey, slots }]` in Eingabereihenfolge, `channelKey` ist der übergebene Schlüssel.
- EPG-Suche (A-1): Neue IPC `epg:search(channelKeys, query, fromMs, toMs, limit, options)` durchsucht bis zu 600 Kanäle (Suchbegriff 2–80 Zeichen, Limit Standard 50, hart 200, Zeitraum höchstens 14 Tage; `options.includeDesc` durchsucht zusätzlich die Beschreibung, Standard aus). Treffer `{ channelKey, start, stop, title }` nach Startzeit sortiert, Antwort `{ results, truncated }`. Faltungsregel (`lib/epg-text.js`, gleiche Funktion im Main und im Renderer-Modul): Kleinschreibung, NFD ohne Akzente (ä→a, é→e), ß→ss, Digraphen ae/oe/ue→a/o/u, Whitespace zusammengezogen — „Käse“, „kase“ und „Kaese“ finden sich gegenseitig. Die Suche läuft in Scheiben (`setImmediate`) und blockiert den Main-Event-Loop nicht; gefaltete Titel werden je Slot zwischengespeichert.
- Alle neuen Kanäle nur hinter `requireMainRenderer`, mit Validierung in `lib/ipc-validation.js` (`validateEpgRangeMany`, `validateEpgSearch`) und fester Preload-Whitelist (`getEpgRangeMany`, `searchEpg`). `epg:range` und `epg:find` bleiben unverändert (außer den neuen Feldern aus 3.2).
- Ereignis `epg:changed` (L-1): `EpgService.onChanged(cb)` meldet jeden erfolgreichen Refresh (Takt, Start, manuell und der gezielte Slip-Refresh `refreshForSource`), nie einen Fehlschlag; `main.js` leitet es nur an das Hauptfenster weiter (`{ at, urls }`), `preload.js` bietet `onEpgChanged(cb)` mit Abmelde-Funktion wie `onScheduleChanged`.
- Reine Raster-Logik (A-2): Neu `lib/epg-grid.js` (ohne Electron/DOM/Uhr, „jetzt“ immer als Parameter): Zeit↔px, sichtbarer Bereich und Virtualisierungsfenster (±1 Viewport), Fortschritt/„noch N min“, TV-Tag 05:00–05:00 lokal (über lokale Datumskomponenten, korrekt an Sommerzeitumstellungen mit 23/25 Stunden), Tagesleisten-Chips und Marker-Zuordnung `matchMarkers` (Sendungsinhalt `[epgStart, epgStop]` ohne Puffer, nur `scheduled`/`recording`, zusammengelegte Einträge, laufende manuelle Aufnahmen aus `recording:list`, Kanalvergleich über normalisierte `tvgId`/`channelId`).
- Tests: `test:suite` nutzt jetzt den Glob `tests/*.test.js` (neue Testdateien werden automatisch erfasst; `tests/helpers/*` laufen nicht als Tests; `test:updater` bleibt als eigenes Skript bestehen). Neu `epg-grid`, `epg-range-many`, `epg-search`; erweitert `epg-ipc`, `epg-service` (Event), `ipc-validation`. Testhelfer `tests/helpers/epg-large-fixture.js` erzeugt deterministische EPG-Daten (XMLTV oder Slots) mit z. B. 438 Kanälen × 10 Tage.

### Etappe 3.2: Datenmodell im Main-Cache

Datenmodell B im Main-Cache (EPG-Konzept B-1/B-2/B-3, EPG-E7). Keine sichtbare Änderung an der Oberfläche; von den neuen Feldern zeigt der Programmführer ab 3.3 nur das Genre, die übrigen Felder folgen mit 3.6. Messwerte: `docs/aufnahme-etappe3-2-messreport.md`.

- Parser (B-1): `lib/epg/xmltv-stream-parser.js` liefert zusätzlich `categories` (max. 3, je ≤ 40 Zeichen), `icon` (erstes `<icon src>`, nur `http:`/`https:`, ≤ 512 Zeichen, sonst leer), `year` (`<date>`, erste vier Ziffern, 1900–2100, sonst 0), `episode` („S2 E3“ unverändert; `xmltv_ns` „1.2.“ → „S2 E3“; ≤ 20 Zeichen), `credits` (Regie ≤ 2, Darsteller ≤ 8, Moderation ≤ 2, je ≤ 80 Zeichen), `subtitle` und `rating`. Überlänge wird gekürzt, nie abgelehnt; Entities (auch numerische) werden einmal dekodiert (kein Doppel-Decode). Die Grenzen sind benannte Konstanten (`LIMITS`); je Sendung werden höchstens 2 000 Elemente betrachtet (Schutz vor riesigen Credits-Listen und unabgeschlossenen Tags). Zeitfensterfilter und Streaming unverändert; gespeicherte Strings werden vom Lese-Chunk gelöst, der Speicherbedarf wächst nicht mit der Dateigröße.
- Cache v2 (B-2): `CACHE_VERSION` 2, Zeile `[start, stop, title, desc, cats, iconIdx, year, episode, credits, subtitle, rating]`, Bild-URLs über eine Stringtabelle je Quelle (Index statt URL; leere Felder am Zeilenende entfallen). Der Cache wird stückweise geschrieben (atomar per tmp + rename). Gemessen am echten Quellfile: 16,6 MB → 22,9 MB (+6,6 MB), Refresh 427 → 676 ms, Peak-RSS 316 → 247 MB.
- Migration (T3/P18): Ein v1-Cache wird weiter gelesen (neue Felder leer, Daten bleiben nutzbar) und beim Start sofort neu geladen — auch wenn er jünger als das Mindestalter für Start-Refreshs (30 min) ist; nur dieser Upgrade-Refresh umgeht die Regel (`EpgStore.isLegacy`, `EpgService._isDue`). Schlägt er fehl, bleibt der v1-Cache unverändert nutzbar; Wiederholung nach 30 min. Ohne `autoRefresh` (isolierte Testläufe) bleibt der Cache unberührt. Schedule-Plausibilisierung und Slip arbeiten mit v1- und v2-Cache unverändert.
- Abfragen: `epg:range` und `epg:find` liefern die volle Projektion mit den neuen Feldern (`subtitle`, `categories`, `icon`, `year`, `episode`, `credits`, `rating`). `epg:search` bleibt schlank, liefert mit `options.full: true` die volle Projektion (Validierung in `lib/ipc-validation.js`; der Preload reicht die Optionen unverändert durch). `epg:range-many` bleibt schlank und liefert seit 3.3 zusätzlich `genre`.
- Genre (B-3): Neu `lib/epg/genre.js` mit `normalizeGenre(categories[])` → `film | serie | news | sport | doku | kinder | show | musik | sonstiges | ''` und die Tabelle als Daten in `lib/epg/genre-table.json` (Priorität news, sport, kinder, doku, serie, film, show, musik, sonstiges; exakte Namen und eindeutige Teilstrings, gefaltet über `lib/epg-text.js`; ohne Codeänderung erweiterbar). Gemessen an der echten Quelle: 9,2 % der Sendungen mit Kategorie landen in „sonstiges“ (Ziel ≤ 10 %). Feinjustierung der Tabelle (P13) ist im Messreport als Vorschlag beschrieben.
- Messung: Neu `scripts/measure-epg.js` (lokale XMLTV-Datei, echte Module; Cachegröße, Refresh-Zeit, Peak-RSS, Feldabdeckung, Genre-Verteilung, Icon-Hosts), Messreport `docs/aufnahme-etappe3-2-messreport.md`. Icon-Hosts der Quelle: 100 % `iptv-epg.org` über https (Befund für P12).
- Tests: Neu `epg-store-v2`, `epg-genre`, `schedule-epg-cache-versions` (Plausibilisierung/Slip gegen v1- und v2-Cache); erweitert `epg-parser` (alle Felder, fehlende Felder, Überlängen, `javascript:`-Icon, numerische Entities, `xmltv_ns`, bösartige Eingaben, Chunk-Grenzen, Puffergröße), `epg-service` (Upgrade-Refresh), `epg-ipc`, `epg-range-many`, `ipc-validation`. Neue Fixtures `tests/fixtures/epg-b-fields.xml` und `tests/fixtures/epg-category-values.json` (distinkte Kategorie-Werte der Quelle mit Häufigkeit).

### Etappe 3.3: Programmführer (Liste, Raster, Detail)

Teil 1 (T-A): Kopfzeile, Tages-Tabs, LISTE, Detail-MODAL, Aufnehmen/Abbrechen/Stoppen-Toggle, Marker, Zustände. Teil 2 (T-B): RASTER als zweiter Modus mit Modus-Segment „Liste | Raster“.

- Neu `epg-view.js` (Factory-Muster wie `settings-view.js`, per esbuild ins Renderer-Bundle) und `epg-view-model.js` (reines, DOM-freies Zustandsmodell: Tage, Zeilen, Layout/Virtualisierung, Scroll-Ziele, Toggle, Zustände, Ansichtszustand mit `mode: 'list'|'grid'` — Tag, Scroll-Anker als Zeitpunkt und Auswahl bleiben bei einem Moduswechsel erhalten). Alle Fremdtexte (Titel, Sender, Beschreibung) nur per `textContent`/`createElement`.
- Kopfzeile ≈ 106 px (ohne Titel, wie im Mockup): Modus-Segment „Liste | Raster“ (Standard Liste; der Modus gilt für die Sitzung), „Jetzt“, „Aktualisieren“ (ruft den Main-Cache `refreshEpgCache`, zeigt „Stand HH:MM“), Schließen; darunter die Tages-Tabs (Gestern nur mit Daten davor · Heute · Morgen · Wochentage, 7 TV-Tage ab heutigem TV-Tag, TV-Tag 05:00–05:00 lokal; der aktive Tab folgt der Scrollposition). Suche, Genre-Chips, Sender-Dropdown, „Mehr“ und Startansicht folgen in 3.5/3.6.
- Design nach Mockup B2 (`docs/mockups/etappe3/variant-b2.html`): abgerundeter Container-Rahmen, Pill-Tabs, Segment-Stil, Outline-Pill-Buttons (Aufnehmen rot, Abbrechen violett, Stoppen rot gefüllt), Marker-Punkt links in der Zeile, Zeile der laufenden Sendung getönt (46 px mit Zeit, „noch N min“ und Fortschrittsbalken unter der Zeit, übrige Zeilen kompakt 32 px), Trennlinie „Jetzt HH:MM · Vergangenes liegt darüber“, Spalten Zeit · Sender · Titel · Genre · Dauer · Aufnahme, vergangene Sendungen gedämpft mit „vorbei“ statt Button (die Zukunftsregel-Meldung bleibt im Detail). Raster: Sender-Kürzel-Badge, Zeitleiste mit „jetzt HH:MM“-Label an der durchgehenden roten Linie, Block-Stil (laufende Blöcke hervorgehoben mit Fortschritt, Marker vor dem Titel, kleiner Toggle rechts im Block nur bei geplanter (✕ abbrechen) oder laufender (■ stoppen) Aufnahme und ab 90 px Breite — Blöcke ohne Aufnahme bleiben ruhig, Aufnehmen läuft über Klick auf den Block → Modal; die Liste behält „● Aufnehmen“ je Zeile), Zoom als Segment „3 px/min | 5 px/min | 8 px/min".
- Senderlogos im Raster: Die Senderspalte zeigt das echte Logo aus der Playlist (`tvg-logo` am Kanalobjekt, Prüfung über `safeResourceUrl` wie in der Sidebar, `img` nur über die Property `src`, `loading="lazy"`, `object-fit: contain`); fehlt es oder scheitert das Laden, bleibt das Kürzel-Badge. Keine neuen Kanäle oder Abhängigkeiten; das Logo kommt vom Renderer-Kanalobjekt, nicht aus dem EPG. Mit 3.4 ist die Senderspalte ein Button (Einstieg in die Kanalansicht).
- Genre (aus 3.6 vorgezogen, M4): `epg:range-many` liefert schlank zusätzlich `genre` (normalizeGenre der Kategorien aus `lib/epg/genre.js`, je Slot zwischengespeichert; `''` ohne Kategorie; einzige Änderung an `lib/epg/EpgStore.js`). Die Liste zeigt Genre als Spalte und Farbbalken links in der Zeile, das Raster einen 4-px-Balken links im Block und das Genre als Text im Tooltip, das Detail nennt es in der Metazeile. Ohne Kategorie bleibt alles neutral („–“, kein Balken); „Sonstiges“ (Kategorie ohne Zuordnung) hat einen neutralgrauen Balken. Farben als Tokens `--g-*` (Kontrast ≥ 3:1 auf den dunklen Flächen, per Test geprüft). Weitere Zusatzfelder (Bild, Credits, Jahr, Episode, Rating) bleiben bis 3.6 unsichtbar.
- LISTE (Standard): Zeit · Sender · Titel · Aktion, nach Startzeit sortiert, Trennlinie „Jetzt HH:MM“ (beim Öffnen und bei „Jetzt“ bei ca. 40 % der Höhe), Tageswechsel springt auf 05:00. Virtualisiert (feste Zeilenhöhe 44 px, Offset-Tabelle mit Binärsuche, nur sichtbare Zeilen plus Puffer im DOM, Schlüssel-Wiederverwendung ohne Fokusverlust). Daten je TV-Tag in Blöcken zu 100 Kanälen; heute zuerst, dann morgen, gestern und die übrigen Tage im Hintergrund (Scrollposition bleibt beim Nachladen erhalten). Laufende Sendung mit Fortschrittsbalken und „noch N min“ (30-s-Tick ohne Neuaufbau), Vergangenes gedämpft, Badge „Nacht“ bei Sendungen vor 05:00 (stehen beim Vorabend-TV-Tag). Senderauswahl: Favoriten (EPG-E3), nur Sender mit EPG; ohne Favoriten Hinweis mit Button „Alle Sender zeigen“ (P14, Sitzungsvariable ohne Auswahl-UI).
- Detail als MODAL (M6): Abdunkelung, Esc und Backdrop-Klick schließen, Fokus-Falle und Fokus-Rückgabe an die Zeile, unter 900 px vollflächig; Titel, Zeit · Dauer · Sender (bei Nachtsendungen mit Kalenderdatum), Aufnehmen-Toggle unter der Metazeile, Beschreibung (per `epg:find`), „Sender öffnen“, „Mediathek“, Hinweiszeile, „Aufnahme geplant ✓“ mit Sprung zur Geplant-Liste. Das Genre steht als Text in der Metazeile; die übrigen Zusatzfelder aus 3.2 werden noch nicht angezeigt.
- Einheitlicher Toggle in Liste, Raster, Modal und (3.4) Kanalansicht: „● Aufnehmen“ (bestehender Weg `handleEpgRecordClick` → `scheduleUi.classifyProgramme` → `openSchedulePlanningDialog`, Zukunftsregel und Meldungen unverändert) ↔ „✕ Aufnahme abbrechen“ (geplant, mit Rückfrage; `schedule:remove`) ↔ „■ Aufnahme stoppen“ (laufend, immer mit Rückfrage; `recording:stop`, Ziel aus der Aufnahme-ID bzw. `recId` des Planungseintrags). Ein Weg, kein Duplikat: dieselbe Funktion `runToggle` in `epg-view.js` bedient alle vier Ansichten; Zeilenaufbau und -darstellung (Marker, Beschriftung, Fortschritt) kommen aus dem gemeinsamen `epg-row-dom.js`. Die Rückfrage hat Fokus-Falle, Standardfokus auf der sicheren Antwort und gehört zur Esc-Kette. Es gibt keine neuen IPC-Kanäle: `removeSchedule` und `stopRecording` waren vorhanden.
- P9: Planung weiter als 8 Tage voraus: Hinweis „Planung nur bis 8 Tage im Voraus“, Button deaktiviert (im Modal, auch vom Raster aus, und in der Kanalansicht; Grenze im Main unverändert, Gleichheit mit `Scheduler.MAX_AHEAD_MS` ist getestet).
- Marker (P10, nur geplant und laufend): ● rot und statisch (geplant) bzw. rot und pulsierend (laufend; der Unterschied ist das Pulsieren — User-Entscheid, ersetzt „geplant violett“ aus M5) (`prefers-reduced-motion` schaltet die Animation ab), Zuordnung über `matchMarkers` aus `lib/epg-grid.js` (Sendungsinhalt ohne Puffer); live über `schedule:changed`/`recording:changed`, Daten neu bei `epg:changed` (Scroll- und Tageszustand bleiben).
- Zustände (M9): lädt, leer, Fehler mit „Jetzt aktualisieren“, Quelle ohne EPG, keine Favoriten, kein Programm.
- RASTER (T-B, zweiter Modus): durchgehende Zeitachse vom Vortag (soweit Daten) bis `coverageToMs` aus `epg:status`, Standard 5 px/min, Zoom 3/5/8 (Zoom-Control und Schnellsprünge 20:15/22:00 nur im Raster; der Zoom hält die Zeit am linken Rand), Zeilenhöhe 64 px, Senderspalte 150 px und Zeitleiste sticky, Gitterlinien alle 30 min, Tagesgrenzen 05:00 beschriftet. Nur Sender mit EPG, Favoriten bzw. „Alle Sender“ wie in der Liste. Blöcke: Titel fett (max. 2 Zeilen) + Zeit, ab 28 px Breite mit Text, darunter nur Farbfläche; Tooltip mit vollem Titel, Fortschrittsbalken bei laufenden Sendungen, Vergangenes gedämpft, Marker ● bzw. pulsierend (live), 30-s-Tick ohne Neuaufbau. Beim Öffnen im Raster steht „jetzt“ ein Viertel der Zeitflächenbreite vom linken Rand. Ein Klick auf einen Block öffnet dasselbe Modal (mit Toggle und P9: Sendungen mehr als 8 Tage voraus zeigen „Planung nur bis 8 Tage im Voraus“, Button deaktiviert). Der Sendername ist mit 3.4 klickbar (`onChannelClick`, Einstieg in die Kanalansicht).
- Virtualisierung im Raster: Zeilen und x-Bereich ±1 Viewport (`virtualWindow`), Daten über `epg:range-many` (schlank) in 6-Stunden-Buckets für die sichtbaren Sender, Nachladen beim Scrollen debounced (120 ms), Sendungen über Bucket-Grenzen werden dedupliziert. Auf der Großfixture (438 Kanäle × 10 Tage) stehen nie mehr als ca. 60 Senderzeilen und 1 500 Blöcke im DOM.
- Moduswechsel Liste ↔ Raster behält Tag, Zeitanker (Zeitpunkt statt Pixel; die Liste setzt die oberste Zeile, das Raster den linken Rand), Auswahl, Zoom und Modal; neue Module `epg-grid-model.js` (rein), `epg-grid-view.js` (DOM) und `epg-dom.js` (gemeinsame DOM-Hilfen).
- Fix: „Jetzt“ hebt die Bindung an einen per Tab gewählten Tag auf (in einer nicht scrollbaren Liste blieb sonst der zuvor gewählte Tab aktiv).
- Fix (W7): `decodeEntities` wird für die Main-Texte des Programmführers nicht mehr aufgerufen — ein Titel wie `Tom &amp;lt; Jerry` bleibt in Liste, Detail, Planungsdialog und Planungseintrag unverändert.
- Esc-Kette (`handleKeyShortcut`, mit 3.4 in `epg-view.js` `handleEscape`): erst Rückfrage, dann Detail-Modal, dann (3.4) Kanalansicht (zurück zur Herkunft), dann Overlay; der Programmführer steht dabei vor Einstellungen und TV-Seitenleiste. Solange er offen ist, zappen ArrowUp/ArrowDown nicht, sondern scrollen die Liste. Einstiege `tvSidebarEpgBtn` und `dashboardEpgOpen` öffnen den neuen Programmführer.
- Entfernt: altes Raster `renderEpg`, Zeitslot-Buttons 2h–24h (`epgSlotHours`, `epgRangeLabel`), altes Detail-Modal `showEpgDetail` samt `epgDetail*`-Verdrahtung, die zugehörigen `index.html`-Blöcke und `epg-*`-Regeln in `styles.css`. `#epgOverlay` ist jetzt ein leerer Container; die Oberfläche baut `epg-view.js` auf.
- Tests: Neu `epg-grid-model` (Achse, Zoom/Anker, Blockgeometrie, Ruler inkl. Sommerzeit, Buckets, Slot-Speicher, P9 im Raster, Großfixture), `epg-view-model` (Tage inkl. Sommerzeit, Zeilen, Layout/Virtualisierung inkl. Großfixture 438 Kanäle × 10 Tage, Scroll-Ziele, Toggle/8-Tage-Regel, Zustände, Moduswechsel ohne Zustandsverlust) und `epg-view-wiring` (keine toten Referenzen, Einstiege, Esc-Kette, Planungsweg); `schedule-ui` auf die neue Verdrahtung angepasst. E2E: `schedule.spec.js` (Marker/Toggle im Modal), neu `epg-overlay.spec.js` (Liste, Tabs, Nacht-Badge, Modal, Esc-Kette, Toggle, Marker live, „&amp;lt;“-Titel, Aktualisieren, Öffnen/Schließen ohne Reste, Großfixture mit P14 und Sprung < 300 ms; Raster: Moduswechsel, sticky, Zoom, Blöcke, Marker, P9, Großfixture).

### Etappe 3.4: Kanalansicht

Kanal-Detailansicht im Programmführer (Design B2, Zustand „Kanalansicht“; AUF-§3.7 Etappe 3, P7–P10/P19). Keine neue IPC, keine Änderung an Main, `lib/` oder Scheduler.

- Kanalansicht als MODUS im Overlay (P7), kein eigener Screen und kein dritter Segment-Button: Das Segment bleibt „Liste | Raster“ (in der Kanalansicht ist keiner der beiden hervorgehoben; ein Klick führt zurück und wechselt ggf. den Modus). Kopfzeile: „← Alle Sender“ (Esc), Senderlogo (gleicher Aufbau wie im Raster: `createChannelLogo` in `epg-dom.js`, `safeResourceUrl`, Kürzel-Fallback), Kanalname, „Jetzt läuft: … · noch N min“ bzw. „Als Nächstes: …“.
- Einstiege (P19) nur: (1) Sendername in der Liste (neue Button-Zelle `.epg-chan-link`) und im Raster (Senderspalte ist jetzt Button), Enter/Space, Fokusanzeige, `aria-label` „Alle Sendungen von <Sender>“; (2) Link „Alle Sendungen des Senders“ im Detail-Modal (schließt das Modal; in der Kanalansicht selbst ausgeblendet). Nicht Dashboard, Player oder Seitenleiste. Erreichbar für jeden Sender der aktuellen Auswahl mit EPG-Schlüssel.
- Programmliste über 7 TV-Tage ab dem heutigen TV-Tag (P8, 05:00–05:00): Tages-Tabs (springen auf 05:00, aktiver Tab folgt der Scrollposition, explizite Wahl bleibt wie in der Liste), je Tag ein Kopf; Zeile mit Zeit „Start–Ende“, Titel, Genre-Spalte/Farbbalken (Genre-Mechanik aus 3.3), Dauer, Aufnahme-Toggle. Laufende Sendung mit Kennzeichen „Jetzt“, Fortschrittsbalken und „noch N min“, nächste Sendung mit „Nächste“, Vergangenes gedämpft, Nachtsendungen (vor 05:00) beim Vorabend mit Badge „Nacht“. Beim Öffnen und bei „Jetzt“ scrollt die Liste auf die laufende bzw. nächste Sendung (heute), sonst auf 05:00 des gewählten Tages. Tage ohne Sendungen: Tab ausgegraut, in der Liste Hinweis. Eine beim Öffnen noch laufende Sendung vom Vorabend-TV-Tag (z. B. 04:40–05:30) steht am Anfang des ersten Tages.
- Daten: ein `epg:range-many`-Aufruf für den Kanal über alle Tage (schlank inkl. Genre), Beschreibung weiter beim Öffnen des Modals über `epg:find`. Neu laden bei `epg:changed` (Position und Tag bleiben, bei unveränderten Daten kein Neuaufbau), Marker live über `schedule:changed`/`recording:changed` (`matchMarkers`). Der 30-s-Tick aktualisiert nur Fortschritt, Klassen und Kennzeichen („Jetzt“/„Nächste“ wandern mit), baut nichts neu.
- P9: Slots mehr als 8 Tage voraus: Button deaktiviert und sichtbarer Hinweis „Planung nur bis 8 Tage im Voraus“ in der Zeile (im Modal wie bisher). Da die 7 TV-Tage die Grenze nie überschreiten, gibt es dafür den Schalter „+ Weitere Tage“ (Mockup: „+ Cache-Tage“): zeigt die Tage 8–14, soweit der Cache reicht; jeder Einstieg beginnt mit 7 Tagen.
- Zurück ohne Zustandsverlust: Die Herkunftsansicht bleibt unter der Kanalansicht bestehen (`inert`, Fokus-Falle schließt sie aus); beim Einstieg wird zusätzlich ein Snapshot (Modus, Tag, Zeitanker, Zoom, Auswahl, Scrollposition Liste bzw. Raster, Fokusziel) gemerkt und beim Zurück geprüft/wiederhergestellt; der Fokus kehrt auf den Sendernamen bzw. die Zeile zurück. Esc-Kette in `epg-view.js` (`handleEscape`, `renderer.js` unverändert): Rückfrage → Detail-Modal → Kanalmodus (zurück zur Herkunft) → Overlay.
- Zustände (M9) der Kanalansicht: lädt, Fehler mit „Jetzt aktualisieren“, Quelle ohne EPG, Cache leer, „Kein Programm“ (kein Programm in den 7 TV-Tagen).
- Neu: `epg-channel-model.js` (rein: 7 TV-Tage inkl. Zeitumstellung, Gruppierung, Slot-Status, Kennzeichnung, Zustände, Ansichtszustand mit Herkunfts-Snapshot), `epg-channel-view.js` (Kopf, Liste, Zustand), `epg-row-dom.js` (gemeinsame Zeile, aus `epg-view.js` herausgelöst). Geändert: `epg-view.js`, `epg-dom.js` (`createChannelLogo`, Fokus-Falle überspringt `inert`), `epg-grid-view.js` (Logo-Helfer, Senderspalte klickbar, `scrollTop`/`setScroll`/`channelElement`), `styles.css` (`epg-channel*`, `epg-crow*`), `eslint.config.js` (Browser-Globals für die neuen Module).
- Tests: Neu `tests/epg-channel-model.test.js` (Tage inkl. Sommerzeit Herbst 25 h/Frühjahr 23 h, Gruppierung mit Nachtsendungen/Mitternacht/doppelter Stunde, Slot-Status inkl. 8-Tage-Grenze, Kennzeichnung, Zustände, Zustandserhalt beim Wechsel), `tests/epg-view-wiring.test.js` erweitert (Modus statt Segment, nur drei Einstiege, ein Toggle-Weg, Esc-Kette, keine toten Referenzen). `e2e/epg-overlay.spec.js` erweitert: Einstieg per Sendername (Maus/Enter/Space) und Modal-Link, Tageswechsel, Nachtsendung beim Vorabend, Jetzt/Nächste, Aufnehmen → Planungsdialog → Marker, Abbrechen mit Rückfrage, laufende Aufnahme zeigt „Stoppen“, >8-Tage-Hinweis, Zurück ohne Zustandsverlust (Liste und Raster), Esc-Kette, Zustände „Kein Programm“ und Fehler, kein Rest beim wiederholten Öffnen/Schließen; Großfixture: Kanalansicht bei 438 Kanälen unter 300 ms bis zur sichtbaren Liste.

#### Abnahme-Fixes 3.4

User-Abnahme auf dem Mac, keine neue IPC, `lib/` unverändert.

- Raster, laufende Aufnahme: Der Toggle rechts im Block (`.epg-block-rec[data-kind="stop"]`) pulsierte zusätzlich zum Marker (zwei pulsierende Punkte). Jetzt statischer Stopp-Knopf (■, roter Grund, keine Animation); pulsierend bleibt nur der Marker links (`prefers-reduced-motion` schaltet weiter ab). Liste und Kanalansicht (dort pulsiert nur der Marker) unverändert.
- Stoppen ohne Rückmeldung: `runToggle` ignorierte das Ergebnis und rief nur `refreshMarkers()`. `recording:stop` antwortet im Main erst NACH der Nachbearbeitung (`RecorderService.stop` wartet auf `_remuxAfterStop`), und der Planungseintrag bleibt bis zum nächsten 30-s-Takt (`_reconcileRecordings`) auf `recording`, obwohl der Job längst weg ist; `matchMarkers` wertet Einträge mit `state: 'recording'` direkt als laufend. Folge: Marker/Punkte blieben bis zu Remux-Dauer plus 30 s, keine Meldung. Gemeinsamer Pfad für Liste, Raster, Kanalansicht und Modal (seit 3.3 so). Neu `stopRuns` in `epg-view.js`: sofort Meldung „wird beendet …“ und Zwischenzustand (Marker `stopping`, gedämpft ohne Pulsieren; Toggle „■ Wird beendet …“ deaktiviert; Flag `stopping` über `matchRowMarkers`, einziger Aufrufer von `grid.matchMarkers`, Raster über optionales `deps.matchMarkers`), danach Erfolgsmeldung bzw. Fehlermeldung (Stopp fehlgeschlagen vs. „Aufnahme beendet, die Nachbearbeitung ist fehlgeschlagen“, je nach Bibliotheksstatus). `markerList()` zählt einen Planungseintrag `recording` nicht mehr als laufend, sobald die Bibliothek (`recording:list`) seine Aufnahme nicht mehr als `recording` führt (`recording:changed` beim Übergang nach `remux-pending`): der Marker verschwindet damit sofort nach dem Stopp, nicht erst nach dem Scheduler-Takt.
- Navbar im Programmführer nicht einblendbar: Das Overlay (`position: fixed`, z-index 100) lag über der Navbar (z-index 90) und ihrer 12-px-Hover-Zone. Jetzt meldet `epg-view` Öffnen/Schließen über den Hook `onOpenChange`; `renderer.js` (`handleEpgOpenChange`) klappt die Navbar ein (`nav-collapsed`, `always-visible` ab), setzt `body.epg-open` (CSS hebt die Navbar auf z-index 105, sie liegt im 14-px-Rand über dem Rahmen) und stellt den vorherigen Zustand beim Schließen wieder her. Navigation aus der Navbar (`showDashboard`/`navigateTo`) schließt den Programmführer zuerst (`closeEpgForNavigation`), sonst läge er über dem Ziel. Zusatzfix: Die eingeklappte Navbar fing Klicks mit unsichtbaren Buttons ab (`.nav-settings-item`/`.active` setzen `pointer-events: auto !important`); ohne Hover jetzt `pointer-events: none`. Overlay-Layout, Esc-Kette und Fokusfalle unverändert.
- Tests: `tests/epg-view-wiring.test.js` (3 Abnahme-Tests), `tests/epg-view-model.test.js` (`toggleState` stopping), E2E in `e2e/epg-overlay.spec.js`: Raster (Marker pulsiert, Knopf statisch, Stopp mit Rückmeldung und Marker-Ende bei simuliertem Main inkl. verzögerter Antwort), Liste (Fehler der Nachbearbeitung), Navbar (Hover, Klick, Zustand nach Schließen).

## 0.7.0 (2026-10-04) — Aufnahme-Planung

Geplante Aufnahmen aus dem EPG (Main-Prozess, auch bei geschlossenem Fenster) auf Basis des neuen Aufnahme-Fundaments. Die Einträge sind nach Etappen gegliedert.

### Etappe 1: Fundament im Main

- Aufnahme (L1): „Bis zum Ende der Sendung“ gibt dem Main-Prozess jetzt einen Stopp-Zeitpunkt (`stopAt`) mit; der `RecordJob` beendet die Aufnahme selbst — auch bei geschlossenem Fenster (Tray-Betrieb). Die Renderer-Timer (`armAutoStopFor` u. a.) entfallen. Zusätzlich gilt eine harte Höchstdauer pro Aufnahme als Notbremse (Standard 6 h, einstellbar 1–24 h, auch im Main geklemmt). Die Fälligkeit wird gegen eine injizierbare Uhr in Teilschritten von höchstens 30 s geprüft (robust gegen Standby/Uhrenwechsel). Das Meta-Feld `stopReason` (`stop-at`, `max-duration`, `disk-full`, `storage-lost`) hält den Grund fest.
- Aufnahme (L2): Das Parallel-Limit ist ein Soft-Limit. `RecorderService.start` wirft ohne `force` einen unterscheidbaren Fehler (`code: 'PARALLEL_LIMIT'`); die UI fragt mit „Trotzdem aufnehmen / Verwerfen“. Über IPC kommt das Limit als Ergebnisobjekt `{ code: 'PARALLEL_LIMIT', limit, active }` statt als Wurf. Der Duplikat-Schutz pro Kanal bleibt hart. Das Limit (Standard 3) ist in „LiveTV → Aufnahmen“ einstellbar.
- Aufnahme (L6, Speicher voll / NAS-Ausfall): Der 5-s-Tick prüft den freien Platz (injizierbares statfs). Unterhalb der Reserve (Standard 1 GB, Minimum 512 MB; Eingabe darunter zeigt „Mindestens 512 MB, sonst kann die Aufnahme nicht sauber beendet werden“ und setzt/speichert das Minimum automatisch; Clamp auch beim Laden und im Main) stoppt die Aufnahme kontrolliert: SIGINT mit kurzer Grace (3 s; gilt für jeden Auto-Stopp, auch stopAt/Höchstdauer — ffmpeg liest nach dem ersten SIGINT sonst bis zu ~10 s weiter; die Aufnahme kann daher noch wenige Sekunden über das Sendungsende hinauslaufen, das letzte unfertige Segment kann entfallen), `#EXT-X-ENDLIST`, Meta-Grund „Speicher voll“, Benachrichtigung in Tray und App. Ein Remux läuft nur bei ausreichend Platz (Größe der Zwischenform + 512 MB); sonst bleibt die Aufnahme in der abspielbaren HLS-Form (`remux-pending`, Status „Nicht konvertiert — Speicher knapp“) und wird beim nächsten Start bzw. nach dem Löschen einer Aufnahme nachgeholt. Nach erschöpftem Retry-Budget bei nicht mehr beschreibbarem Speicherort endet die Aufnahme ebenfalls kontrolliert statt als `failed`.
- EPG im Main (§3.2): Neu `lib/epg/` (`EpgService`, `EpgStore`, Streaming-XMLTV-Parser, geteilter Download). Wochen-Cache je Kanal (`jetzt − 1 Tag … + 10 Tage`) in `userData/epg-cache.json`, sofort aus dem Cache nutzbar, Refresh im Hintergrund beim Start und alle 12 h (auch ohne offenes Fenster), bei Fehlschlag bleibt der alte Cache. Quelle ist die `epgUrl` je TV-Quelle. Kanal-Zuordnung über `normalizeTvId` aus typed-core. Download-Validierung (`remoteHttpUrl`, `MAX_EPG_BYTES`, Redirects) ist mit dem `fetch-epg`-Handler geteilt; rohe `.gz`-Antworten werden per Stream entpackt (Limit auch entpackt). Neue IPC `epg:range`, `epg:find`, `epg:status`, `epg:refresh` (nur Hauptfenster, validiert). Das Renderer-EPG (Grid/„Jetzt“) bleibt unverändert; es gibt noch keinen Scheduler und keine Planungs-UI. Settings „LiveTV → EPG“ zeigen den Stand des Wochen-Caches. Isolierte Testläufe (`STREAMING_HUB_USER_DATA`) laden nicht automatisch aus dem Netz (`STREAMING_HUB_EPG_REFRESH=on` schaltet es ein).
- Fix (EPG): `parseEpgTime` (typed-core) und `parseEpgTimeMs` (ui-model) wandten das Vorzeichen eines negativen Zeitzonen-Offsets nur auf die Stunden an (`-0530` ergab −270 statt −330 Minuten). Europäische Offsets waren nicht betroffen.
- Tests: neue Tests `recording-settings`, `recorder-stopat`, `recorder-soft-limit`, `recorder-disk-full` (simuliertes statfs), `recorder-disk-full-volume` (echtes `hdiutil`-Volume mit echtem ffmpeg, ffprobe und Decode-Check; läuft nur mit `STREAMING_HUB_VOLUME_TEST=1` auf macOS, sonst übersprungen), `epg-parser`, `epg-service`, `epg-ipc`; Fixture `tests/fixtures/epg-sample.xml`; Helfer `tests/helpers/recorder-fakes.js`.

### Etappe 2a: Planung MVP

- Planung (§3.3/§3.4): Aufnahmen lassen sich aus dem EPG planen und laufen im Main-Prozess, unabhängig vom Fenster (die App muss laufen, im Tray genügt). Neu `lib/recorder/ScheduleStore.js` (`schedules.json` in userData, atomar geschrieben, korrupte Datei wird gesichert und tolerant geladen; Zeiten als ISO mit Offset, verglichen wird in ms — Sommerzeitwechsel korrekt), `Scheduler.js` (30-s-Takt mit injizierbarer Uhr/Timern, Neubewertung bei Standby-`resume`) und `schedule-logic.js` (reine Zeit-/Konfliktlogik). Start bei `epgStart − Vorlauf`, Stopp über `stopAt = epgStop + Nachlauf` im `RecordJob`. Die Stream-URL wird beim Start frisch aus der Senderliste aufgelöst (M3U der Quelle + Overrides); der gespeicherte URL-Snapshot dient nur als Fallback, wenn die Senderliste nicht ladbar ist. Fehlt der Kanal, endet der Eintrag als `failed` mit lesbarer Meldung.
- Spätstart / verpasst (E4): War die App zur Startzeit aus oder im Standby und läuft die Sendung noch, startet die Aufnahme sofort mit Hinweis „ab hh:mm“ (abschaltbar); ist auch das Sendungsende vorbei, wird der Eintrag `missed` (Meldung in der Liste + Benachrichtigung). Engine-Fehler setzen den Eintrag auf `failed` mit dem Engine-Text — es gibt kein stilles Wiederholen. Vor dem Start wird der Platz gegen die Reserve geprüft („Speicher knapp“, kein Start). Nach einem Neustart werden hängende `recording`-Einträge ohne Job aufgelöst (`done`/`failed`).
- Konflikte (§3.4): Beim Anlegen prüft ein Überlappungs-Sweep über `[Start − Vorlauf, Ende + Nachlauf]` einschließlich laufender Aufnahmen gegen das Parallel-Limit; bei Überschreitung „Trotzdem planen / Verwerfen“ (der Scheduler startet dann mit `force`). Gleicher Sender direkt hintereinander mit überlappenden Puffern: Mittelpunkt-Regel (Grenze in der Mitte der Überlappung, auf das Sendungsende von A bzw. den Sendungsbeginn von B geklemmt; abgeleitet, nicht in die Einträge geschrieben) oder „Eine durchgehende Aufnahme“ (Start von A, Stopp von B). Beides ist im Dialog sichtbar.
- Zukunfts-Regel (§3.7): Der Button „Aufnehmen“ im EPG-Detail ist immer sichtbar; nur Sendungen mit `epgStart > jetzt` öffnen den Planungsdialog. Laufende Sendungen („… Aufnahme-Button im Player“) und vergangene Sendungen zeigen eine Meldung statt eines Dialogs. Dieselbe Regel gilt im Main (`schedule:add` lehnt `epgStart ≤ jetzt` ab; Systemuhr des Main). Start in weniger als dem Vorlaufpuffer bleibt planbar. Der Main plausibilisiert Sendezeit und Sender gegen den Main-EPG-Cache (kein Cache-Eintrag → „Für diesen Sender liegt kein planbares EPG im Cache vor“).
- UI: Planungsdialog (Vorbelegung, Puffer überschreibbar, Konfliktwarnung, Esc/Fokus-Trap), Dashboard „Aufnahmen“ mit Tabs „Bibliothek“ / „Geplant“ (Zeit, Sender, Titel, Status inkl. Spätstart-/Fehlermeldung, Bearbeiten (Puffer), Absagen, Live-Update per `schedule:changed`), Settings-Karte „Planung“ (Puffer vorher/nachher, Spätstart). EPG-Texte werden ausschließlich als Text gerendert. Absagen: geplanter Eintrag → `abgesagt` (bleibt im Verlauf), abgeschlossene Einträge lassen sich entfernen; eine laufende Aufnahme wird dabei nie abgebrochen.
- Settings: `bufferBeforeMin` (Standard 2), `bufferAfterMin` (Standard 5), jeweils 0–30, und `lateStart` (Standard an); Altdaten laden mit Defaults, Clamp im Main. Neue Einträge übernehmen die aktuellen Defaults, bestehende behalten ihre Puffer.
- IPC (nur Hauptfenster, validiert): `schedule:add/update/remove/list/check-conflicts`; strikte ISO-Zeiten mit Offset, max. 24 h Dauer und 8 Tage voraus, Puffer 0–30 min, Titel ≤ 300, Beschreibung ≤ 2000. `preload.js` exponiert nur feste Funktionen.
- App-Verhalten: Beim Schließen des letzten Fensters bleibt die App auch bei anstehenden Planungen im Tray (bisher nur bei laufender Aufnahme). Beenden-Dialog, Tray-Einträge, Schedule-Slip und Standby-Schutz folgen in Etappe 2b.
- Tests: neue Tests `schedule-logic`, `schedule-store`, `scheduler`, `schedule-ipc`, `recording-settings-schedule`, `schedule-ui`, `schedule-integration` (Fake-ffmpeg, injizierte Uhr, lokale XMLTV-Fixture `tests/fixtures/epg-schedule.xml`); E2E `e2e/schedule.spec.js` (ohne Netz). Test-Hook `STREAMING_HUB_EPG_FIXTURE=<XMLTV-Datei>` (nur zusammen mit `STREAMING_HUB_USER_DATA`) ersetzt den EPG-Download für Main-Cache und Renderer-EPG.

### Etappe 2b: Absicherung

- Schedule-Slip (§3.4): 10 min vor `epgStart − Vorlauf` lädt der Scheduler das EPG der Quelle des Eintrags gezielt neu (`EpgService.refreshForSource`, nur die EPG-URL dieser TV-Quelle) und gleicht den Eintrag mit dem frischen Cache ab (`lib/recorder/schedule-slip.js`). Dieselbe Sendung wird über den (normalisierten) Titel auf dem Kanal erkannt, Beginn höchstens 3 h neben dem alten. Verschiebung nach hinten und nach vorne wird automatisch übernommen, solange der Start noch nicht erreicht ist; Hinweis am Eintrag („Sendezeit laut EPG geändert (20:00–20:15 → 20:10–20:25)“) plus Benachrichtigung. Wurde die Sendung aus dem EPG entfernt (oder ist der Titel ein anderer / die Verschiebung größer als 3 h), bleibt der Eintrag bestehen und es wird nur gewarnt — nie gelöscht. Nach einer Übernahme wird die Konfliktprüfung (Parallel-Limit) erneut bewertet und bei Überschreitung gewarnt; die Mittelpunkt-Regel wirkt weiter abgeleitet. Die Prüfung blockiert den 30-s-Takt nicht (läuft nebenher), ist einmal pro Eintrag und Fenster fällig (`lastSlipCheck`, überlebt den Neustart; nach einer Verschiebung nach hinten prüft das neue Fenster erneut) und läuft nie nach Erreichen des Starts. Schlägt der Refresh fehl, bleibt der alte Cache unverändert; der nächste Versuch folgt nach 3 min. Zusammengelegte Einträge („A + B“, neues Feld `merged`) sind vom Slip ausgenommen.
- Beenden-Dialog (§3.5, E2): Bei Fenster-X und beim Beenden (Cmd+Q, Dock, Tray-„Beenden“) erscheint nur dann „Es ist eine Aufnahme geplant: Das Erste — Tagesschau, heute 20:15. Streaming Hub muss dafür laufen.“ mit [Im Hintergrund behalten] / [Trotzdem beenden], wenn in den nächsten 24 h (Grenze inklusiv) eine Planung beginnt; sonst wird still beendet wie bisher. Semantik: „Im Hintergrund behalten“ = Fenster schließen, App bleibt im Tray (bei Cmd+Q wird der Beenden-Versuch abgebrochen und das Fenster geschlossen); „Trotzdem beenden“ = Quit mit dem normalen Cleanup (`before-quit`, `quitSweep`, keine verwaisten ffmpeg). Kein doppelter Dialog (solange einer offen ist, werden Fenster-X/Quit verschluckt), Updater-Relaunch und System-Shutdown blockiert der Dialog nie (Flags `allowQuit('updater')`, `markSystemShutdown()` mit 60-s-Gültigkeit), fällt der Dialog selbst aus, wird nicht blockiert. Der Tray-Dialog „Beenden …“ bei laufender Aufnahme fragt zuerst diesen Dialog. Auf Linux gilt derselbe Dialog (keine Sonderpfade). Text bereinigt (Sender ≤ 40, Titel ≤ 60 Zeichen, Steuer-/Bidi-Zeichen raus). Logik rein und testbar: `quit-guard.js`, `planned-summary.js`, Ablauf `QuitCoordinator.js`. Ergänzt den Punkt „App-Verhalten“ aus 2a.
- Fenster-X-Verhalten: Das Hauptfenster wird beim Schließen nicht mehr als zerstörtes Objekt weiterverwendet. Tray „App öffnen“/„Planung öffnen“ und das macOS-Dock-Icon (`activate`) erzeugen es nach „Fenster zu, App im Tray“ neu; `registerRecorderIpc` bekommt dafür `getMainWindow()`.
- Tray (§3.5, E3): Das Menü zeigt „Geplant: Das Erste — Tagesschau · heute 20:15“ (nächste 3, weitere als „… und N weitere geplant“) und „Planung öffnen“ (Hauptfenster zeigen, Dashboard Aufnahmen → Tab „Geplant“; „Aufnahmen-Bibliothek“ öffnet den Tab „Bibliothek“). Das Icon bleibt im Leerlauf violett (auch mit Planung), Rot nur bei laufender Aufnahme. Das Menü aktualisiert sich bei `schedule:changed` und ändert sich nur bei Inhaltsänderung beim Takt. Labels bereinigt (Länge, Steuerzeichen). Modell als reine Funktion: `tray-menu-model.js`.
- Benachrichtigungen: Die Schedule-Meldungen (bisher direkt `Notification` in `main.js`) laufen jetzt wie die Aufnahme-Meldungen über den gemeinsamen, testbaren `Notifier` (`lib/recorder/Notifier.js`; Text bereinigt, fehlende Unterstützung nie fatal), angebunden über `TrayController.attachScheduler`.
- Standby-Schutz (§3.5): `StandbyGuard` hält `powerSaveBlocker('prevent-app-suspension')` bei laufender Aufnahme (bisher gab es keinen Blocker) und für geplante Aufnahmen ab 5 min vor `epgStart − Vorlauf` bis zum Aufnahmestart bzw. Fensterende; idempotent (kein Doppel-Start), Freigabe beim Beenden. Er weckt keinen schlafenden Rechner. Nach Standby-`resume` werden Planung (Spätstart/verpasst aus 2a, Slip-Prüfung) und Blocker neu bewertet.
- Text-Hilfen: `clampText` schneidet kein halbes Surrogatzeichen mehr ab (Emoji an der Kürzungsgrenze); neu `sanitizeLabel` für Fremdtext in nativen Oberflächen.
- Refactoring: `resolveScheduledStream` aus `main.js` nach `lib/recorder/stream-resolver.js` extrahiert (Verhalten unverändert, jetzt testbar).
- Planungsliste: Der Status „Geplant“ zeigt Hinweise am Eintrag (Slip, Zusammenlegung).
- IPC: keine neuen Kanäle. `recordings:open` (Main → Renderer) trägt jetzt `{ tab: 'library' | 'planned' }` (Whitelist im Renderer); `preload.js` reicht den Wert durch. Test-Hook `STREAMING_HUB_TEST_QUIT_DIALOG=mock` (nur zusammen mit `STREAMING_HUB_USER_DATA`) ersetzt den nativen Beenden-Dialog durch eine Attrappe.
- Tests: neue Tests `schedule-slip`, `quit-guard`, `tray-menu-model`, `standby-guard`, `stream-resolver` (Fake-`powerSaveBlocker`, injizierte Uhr, XMLTV ohne Netz); E2E `e2e/quit-dialog.spec.js` (Beenden-Dialog mit und ohne Planung, Fenster neu erzeugen).

## 0.6.0 (2026-10-03) — Einstellungen neu organisiert (#4)

- Einstellungen (#4): Das Einstellungs-Panel ist keine lange Einzelkarte mehr, sondern eine Zwei-Spalten-Ansicht mit Seitenleiste und genau einer Seite: Allgemein (Backup), LiveTV (aufklappbar: Quellen, Sender, EPG, Wiedergabe, Aufnahmen), Streaming und Mediatheken (jeweils Dienste-Liste mit „Hinzufügen“). Seitenleiste aus einem Konfigurations-Array (`settings-view.js`), Tastaturbedienung (Tablist, Pfeiltasten/Home/End), letzte Seite wird gemerkt, bei schmalem Fenster Tab-Leiste oben; `showDashboard('settings', { page })` unterstützt Deep-Links (`openSettingsPage`). Das Dashboard „LiveTV“ und die Senderauswahl erhalten den Button „Senderverwaltung“. Doppelte Überschrift „Einstellungen“ entfernt.
- Quellen (#4): „LiveTV → Quellen“ zeigt die TV-Quellen inline (Name, Typ, URL, EPG-URL, Farbe) und erlaubt Hinzufügen (inkl. Dateiauswahl), **Bearbeiten (neu)** und Entfernen mit Bestätigung. Favoriten, Reihenfolge und Sender-Anpassungen bleiben beim Bearbeiten erhalten (Update über `update-tv-source`, Spread-Merge). Die Seite rendert bei `tv-sources-changed` neu. „LiveTV → EPG“ zeigt/ändert die EPG-URL je Quelle und bietet „EPG aktualisieren“ mit Status und Zeitpunkt des letzten Abrufs. Verständliche Fehlermeldung bei ungültiger URL, Status wird nach „Abbrechen“ geleert. Neu: `settings-tv-sources.js`.
- Senderverwaltung (#4): „LiveTV → Sender“ ist eine echte Verwaltungsseite mit Quellenfilter, Suche, Ansicht Alle/Favoriten, Favoriten per Stern und Umsortieren der Favoriten (Drag&Drop innerhalb einer Seite sowie Hoch/Runter-Buttons, per Tastatur bedienbar, relativ zu sichtbaren Favoriten – „Geister“-Favoriten behalten ihren Platz –, Seitenwechsel über die Seitengrenze mit Fokuserhalt), EPG-Status je Sender, Detailbereich mit Name, EPG-Zuweisung (tvg-id mit Auswahlliste aus dem geladenen EPG), Logo-URL mit Vorschau (Platzhalter bei Ladefehlern) und Stream-URL-Überschreibung mit „Auf Original zurücksetzen“. Große Listen (5000+ Sender) werden seitenweise dargestellt, Logos laden lazy; ungespeicherte Eingaben bleiben bei Quellen-Updates erhalten; Escape schließt Combobox bzw. Detailbereich lokal, ohne die Einstellungen zu verlassen und ohne stillen Entwurfsverlust. Datenformat von `tvsources.json` unverändert (kompatibel zu iOS/tvOS). Neu: `settings-tv-channels.js`, `lib/settings-channel-logic.js`.
- Aufgeräumt (#4): Die alten Overlays „TV-Quellen verwalten“ (`#tvModal`) und „Sender bearbeiten“ (`#tvChModal`) samt Code und CSS sind entfernt (Sidebar-Aktionen verlinken auf die neuen Seiten). Das Senderauswahl-Overlay „Alle Sender“ (startet die Wiedergabe) und die versteckte TV-Sidebar bleiben bestehen.
- Fix (LiveTV): Schlägt das Laden einer TV-Quelle fehl, zeigt die App eine verständliche Ursache statt „fetch failed“ (Host nicht gefunden, Verbindung abgelehnt, Zeitüberschreitung, TLS-/Zertifikatsfehler, Weiterleitung nicht erlaubt), nie mit URL oder Zugangsdaten. Der IPC-Handler `fetch-and-parse-m3u` liefert Ladefehler als `{ error }` statt zu werfen; dadurch entfällt der rote „Error occurred in handler“-Eintrag im Terminal. Verhalten im Renderer unverändert. Neu: `lib/m3u-fetch-error.js`.
- Fix (Sicherheit/Validierung): `isPrivateHostname` (genutzt für Quellen-, EPG-, PiP-, Dienst- und Stream-URLs) erkennt jetzt 0.0.0.0/8, CGNAT (100.64.0.0/10), 192.0.0.0/24, 198.18.0.0/15, Multicast, Reserviert/Broadcast, IPv6 (Loopback, `::`, IPv4-gemappt wie `[::ffff:127.0.0.1]`, ULA, Link-Local, Site-Local, Multicast, NAT64/6to4/SIIT), die Namensendungen `.lan`, `.internal`, `.home.arpa`, `.localdomain`, einteilige Hostnamen und mehrfache Trailing-Dots; öffentliche Ziele und alle Default-URLs bleiben gültig. Der Main-Prozess prüft `channelOverrides` beim Schreiben über `update-tv-source` (Typen, Längen, Stream-URL nur öffentliches http/https ohne Zugangsdaten, Logo nur http/https oder sicherer relativer Pfad – kein `//host`, UNC, `file:`, `javascript:`, `data:`), nur neue oder geänderte Felder, unveränderte Bestandsdaten bleiben unberührt.
- Fix (Senderverwaltung): Die Sender-Liste baute nach jeder Änderung (eigenes Render plus `tv-sources-changed`-Broadcast) zweimal kurz hintereinander neu auf; ein Klick oder Drag zwischen beiden Aufbauten traf ein bereits ersetztes Element (selten verlorene Drops/Klicks, vor allem unter Last). Identische Ergebnisse ersetzen die vorhandenen Zeilen jetzt nicht mehr. Die E2E-Prüfung der Logo-Vorschau liefert das Bild per Route aus und hängt nicht mehr vom Netz ab.
- Tests: neue Unit-Tests (`settings-view`, `settings-tv-sources`, `settings-channel-logic`, `m3u-fetch-error`, `with-tmp`, erweiterte `input-validation`) und E2E (`e2e/smoke.spec.js` erweitert, neu `e2e/channels.spec.js` mit isoliertem Profil und 5003 Sendern aus lokalen M3U-Dateien: Performance, Suche, Favoriten, Umsortieren, Override speichern/validieren/zurücksetzen ohne Datenverlust, Escape, Seitengrenze, Deep-Links). `e2e/smoke.spec.js` startet Electron mit `--use-mock-keychain` (nur Test).
- Tests (Infra): Testläufe räumen ihre Temp-Verzeichnisse auf. `scripts/with-tmp.js` legt pro Lauf ein eigenes `TMPDIR` an, reicht den Exit-Code durch und löscht genau dieses Verzeichnis (Erfolg, Fehler, Abbruch, Signale; Pfad-/Präfix-/Symlink-Prüfung); eingebunden in `npm test`, `test:updater`, `test:e2e` und neu `test:smoke-updater`. `scripts/smoke-updater-gui-path.js` kopiert kein `release/`, `out/` und `bin/ffmpeg|ffprobe` mehr und löscht seinen Ordner immer.
- Offene Folgepunkte: #5 (Backup-Restore prüft `channelOverrides` nicht inhaltlich), #6 (absolute `tvgLogo`-Overrides wirken in Player-/Senderlisten nicht, `packages/typed-core/src/tv.ts`), #7 (ID-Kollision bei doppelter tvg-id), #8 (`fetch-epg` loggt Ladefehler weiterhin als Handler-Fehler).

## 0.5.27 (2026-10-03) — macOS-Signatur-Fix (Gatekeeper „beschädigt“)

- Fix (Build, macOS): Das Release-ZIP enthielt eine inkonsistente Ad-hoc-Signatur (`codesign --verify --deep --strict`: „code has no resources but signature indicates they must be present“; Info.plist nicht gebunden, Sealed Resources = none). Nach manuellem Browser-Download zeigte Gatekeeper deshalb „Streaming Hub ist beschädigt“. `scripts/evs-afterPack.js` signiert die gesamte `.app` nach dem VMP-Signieren (`castlabs_evs.vmp sign-pkg`) mit `codesign --force --deep -s -` konsistent ad-hoc neu und verifiziert sie (`--verify --deep --strict`); `build.mac.identity: null` verhindert erneutes Signieren durch electron-builder. Die VMP-Signatur bleibt gültig (`verify-pkg` am entpackten ZIP: „streaming“). Weiterhin nicht notarisiert: README beschreibt Rechtsklick → Öffnen bzw. `xattr -cr`.

## 0.5.26 (2026-10-03) — macOS-Updater-Fix (default_app.asar ENOENT)

- Fix (Updater, macOS): In-App-Update scheiterte mit `ENOENT, not found in …/Contents/Resources/default_app.asar`. Root-Cause: Electrons asar-fs-Patch behandelt `Contents/Resources/default_app.asar` im Updater-Prozess als Archiv, sodass `copyBundleTree` beim Kopieren des Bundles warf — jedes Mac-Update scheiterte. Beleg: `~/Library/Logs/Streaming Hub/updater.log`; mit Castlabs-Electron reproduziert und behoben. `updater.js` setzt jetzt `process.noAsar = true` (vor allen fs-Zugriffen), `main.js` übergibt `ELECTRON_NO_ASAR=1` an beide `fork()`-Aufrufe. Regressionstest `tests/updater-asar.test.js`.
- Tests: `e2e/smoke.spec.js` (Isolation) vergleicht das echte `~/Library/Logs/Streaming Hub/updater.log` vor/nach dem Lauf (Größe/mtime) statt Nicht-Existenz zu verlangen — grün auch auf Rechnern mit früheren Updates. `scripts/smoke-updater-gui-path.js` sendet `999.0.0` und erwartet `hasUpdate === false` + gültiges Semver statt hartkodierter Release-Stände.
- Tests: `tests/recorder-folder-meta-offset.test.js` („-ss VOR -i“) war flaky (~1 von 10 Läufen): der Test überschrieb das Fake-ffmpeg-Skript während der echte RecordJob es startete, und Job-Spawn sowie ein künstlicher Test-Respawn schrieben konkurrierend in dieselbe `args.txt`. Jetzt wird das Skript vor dem Job-Start fertig geschrieben, jeder Aufruf schreibt seine Args atomar in eine eigene Datei, und der Test prüft die Args des echten Job-Spawns. Keine Produktionsänderung.

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
