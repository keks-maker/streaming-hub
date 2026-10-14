# Streaming Hub — Konzept Online-Radio (v0.2, Entwurf)

Stand: 14.10.2026. Status: Konzept; Entscheidungen §9 nach Empfehlung getroffen, R0 abgeschlossen (Messreport `docs/radio-r0-messreport.md` auf Branch `spike/radio-r0`). Umsetzung ab R1.
Vorbild ist LiveTV (Dashboard, Senderverwaltung, Favoriten mit globaler Reihenfolge, Quellen mit Merge beim Update) und der Tray aus dem Aufnahme-Konzept.

## 1. Ziele und Abgrenzung

**Ziele (v1)**
1. Radio hören in der App, mit mitgelieferter Liste, vorrangig deutsche Sender.
2. Eigene Sender per Stream-URL hinterlegen (Einstellungen).
3. Steuern aus App und Menüzeilensymbol (Tray); Radio läuft weiter, wenn das Fenster geschlossen wird.
4. Eigene Navigationskachel „Radio“ → Dashboard mit Favoriten → Senderverwaltung (Suche, Favoriten, Sortierung), verknüpft mit den Einstellungen.

**Nicht in v1**: Radio aufnehmen (ffmpeg-Recorder existiert, siehe §10), Podcasts, Senderlisten-Import per M3U-Datei, tvOS/iPad-Umsetzung (Datenformat wird aber gemeinsam gedacht, §8).

## 2. Architektur-Entscheidung: Wiedergabe im Main-gesteuerten Player-Host

LiveTV spielt in einer `<webview>` (`tvView`), die beim Seitenwechsel ausgeblendet wird. Für Radio ungeeignet: Ton muss über Seitenwechsel **und** bei geschlossenem Fenster weiterlaufen.

**Vorschlag:** ein unsichtbares `BrowserWindow` (`radio-player.html`, `show:false`, `backgroundThrottling:false`, `sandbox:true`, eigenes Preload mit minimaler IPC-Schnittstelle) als einzige Audio-Engine.

- Der Main-Prozess hält den Zustand (`RadioController`: Sender, Status `idle|loading|playing|paused|error`, Lautstärke, Now-Playing) und ist Single Source of Truth.
- Hauptfenster-Renderer (Dashboard, Mini-Player) und Tray sind nur Fernbedienungen: IPC `radio:play|pause|stop|next|prev|volume` und Event `radio:state`.
- Im Player-Host: `<audio>` für MP3/AAC/Ogg direkt; HLS (`.m3u8`) über das vorhandene `hls.js` (wie `tv.html`); `navigator.mediaSession` liefert macOS-„Läuft gerade“ und Medientasten ohne Zusatzcode.
- CSP des Players: `media-src http: https: blob:` (viele Sender liefern nur `http`), `connect-src http: https:`.
- Fenster zu: Wie bei Aufnahmen bleibt die App im Tray, solange Radio spielt (Ergänzung in `window-all-closed` und `QuitCoordinator`; Beenden über Tray stoppt die Wiedergabe).
- Konflikte: Startet LiveTV/Streaming/Aufnahme-Player Ton, wird Radio pausiert (Einstellung „Radio beim Start von TV pausieren“, Standard an). Kein automatisches Fortsetzen.

**Playlist-Auflösung (Main, `lib/radio-resolve.js`, rein + testbar):** Eingabe-URL kann direkter Stream, `.pls`, `.m3u`, `.asx` oder `.m3u8` sein. Der Main lädt Playlists (Timeout, Größenlimit, nur http/https), nimmt den ersten gültigen Eintrag, folgt Redirects begrenzt. Ergebnis `{ streamUrl, kind: 'direct'|'hls' }`.

**Now Playing (ICY):** Der Main öffnet parallel zur Wiedergabe keinen zweiten Stream, sondern der Player-Host liest ICY-Metadaten mit `fetch` + `Icy-MetaData: 1` nur, wenn der Sender das erlaubt; sonst keine Titelanzeige (Sendername genügt). Parser `lib/icy-parser.js` (rein). Bei HLS ggf. ID3 aus hls.js. Bewusst „best effort“, Sender ohne Titel sind kein Fehler. Zu klären im Spike (§11, R0): ein Stream oder zwei.

**Fehlerverhalten:** Verbindungsabbruch → bis zu 3 Wiederverbindungsversuche mit Backoff, dann Status `error` mit Klartext („Stream nicht erreichbar“, „Format nicht unterstützt“), Toast im Hauptfenster, Tray-Eintrag zeigt Fehler. Kein Endlos-Retry.

## 3. Senderdaten

### 3.1 Mitgelieferte Liste
`radiosources.json` im Bundle, Format analog `tvsources.json`:

```json
[{
  "id": "deutsche-radiosender",
  "name": "Deutsche Radiosender",
  "type": "bundled",
  "stations": [{
    "id": "swr3", "name": "SWR3", "streamUrl": "https://…",
    "logo": "https://…", "genre": "Pop", "region": "BW/RP", "country": "DE",
    "codec": "mp3", "bitrate": 128, "homepage": "https://…"
  }],
  "sortOrder": ["swr3", "…"]
}]
```

- Inhalt: öffentlich-rechtliche Landeswellen (SWR, WDR, NDR, BR, HR, MDR, rbb, SR, RB), Deutschlandfunk-Familie, große Privatsender, Genre-/Webradios. Zielgröße ca. 150–300 Sender.
- Pflege per Skript `scripts/build-radio-list.js` aus dem offenen Verzeichnis **radio-browser.info** (Filter Land DE, nur erreichbare HTTPS-/HTTP-Streams, Dubletten über `stationuuid`, Mindest-Votes), danach manuell kuratiert eingecheckt. Offline-fähig, keine Laufzeitabhängigkeit.
- Streams ändern sich. Daher optional Feld `rbUuid`; „Liste aktualisieren“ (Dashboard und Einstellungen) fragt radio-browser nach der aktuellen URL zu dieser UUID und merkt sie als Override (nicht in der Bundle-Datei). Zusätzlich liefern App-Updates eine neue Bundle-Liste.
- Rechtliches: nur öffentlich verbreitete Stream-URLs und Logos per URL verlinken, keine Logos einbetten (Lizenz); Platzhalter-Icon bei Ladefehler. Vor Release gegen Nutzungsbedingungen von radio-browser prüfen (Spike).

### 3.2 Eigene Sender
Quelle `eigene-radiosender` (`type:"user"`, immer vorhanden, nicht löschbar). Felder je Sender: Name (Pflicht), Stream-URL (Pflicht), Logo-URL, Genre (frei, mit Vorschlägen). Validierung in `lib/input-validation.js` ergänzen (`radioStreamUrlError`, nur `http:`/`https:`, Länge; LAN-/localhost-Adressen sind erlaubt, da bewusst nutzereigene Quelle). Button **„Stream prüfen“** ruft `radio:probe` (Auflösung + kurzer Verbindungstest + Content-Type) und zeigt Ergebnis, bevor gespeichert wird.

### 3.3 Persistenz und Update-Verhalten
- `lib/user-storage.js`: neuer Typ `radioSources: 'radiosources.json'` (Nutzerkopie in userData).
- `lib/radiosources-merge.js` analog `tvsources-merge.js`: Bundle-Liste ersetzt Stationen, Nutzerdaten bleiben (`favorites`, `favoriteRank`, `stationOverrides` {name, logo, streamUrl}, eigene Sender komplett). Entfernte Bundle-Sender, die Favorit sind, bleiben als „nicht mehr in der Liste“ markiert statt still zu verschwinden.
- Globale Favoriten-Reihenfolge: `favoriteRank` wie bei LiveTV. `lib/settings-channel-logic.js` (`globalFavoriteList` u. a.) soll **generalisiert** statt kopiert werden (Schlüssel `sourceId+stationId`).
- `lib/backup.js` und `post-update-reconcile` um Radio erweitern; Backup-Format abwärtskompatibel (fehlendes `radioSources` ist erlaubt).
- Zuletzt gehörter Sender und Lautstärke in `radio-settings.json` (neuer Storage-Typ, wie `epgViewSettings`).

## 4. Navigation und Dashboard

- **Hauptnavigation**: neuer Eintrag `radio` in `renderNav` und in den Startseiten-Kacheln (`renderer.js`, Liste `groups`/`sections`), Position direkt nach LiveTV, Icon `assets/icons/radio-icon.png`, Akzentfarbe z. B. `#f59e0b`. `showDashboard('radio')` ergänzt `overlayLocation` („Radio“), Navigations-Historie (`pushNavState`) und Wiederherstellung.
- **Radio-Dashboard** (gleiche Dashboard-Hülle wie LiveTV, `dashboardView` mit Modus `radio-dashboard`):
  - Werkzeugleiste (wie `dashboard-hub-toolbar`): **Senderverwaltung** (springt in Einstellungen → Radio → Sender), **Liste aktualisieren**, Statuszeile („12 Favoriten · Liste vom …“).
  - Kachelraster der Favoriten in globaler Reihenfolge: Logo, Name, Genre. Klick = Wiedergabe, erneuter Klick = Pause. Aktive Kachel mit Equalizer-Animation (respektiert `prefers-reduced-motion`), Fehlerkachel mit Hinweis.
  - Ohne Favoriten: Leerzustand mit Button „Senderverwaltung öffnen“ und Kurzliste „Beliebte Sender hinzufügen“ (ein Klick setzt 5–8 deutsche Standardsender als Favoriten, nur auf Nutzeraktion).
- **Mini-Player** (neue Leiste unten im Hauptfenster, sichtbar auf allen Seiten, solange Radio nicht `idle` ist): Logo, Sender, Titel/Interpret (wenn vorhanden), Vorheriger/Play-Pause/Nächster Favorit, Lautstärke, Stopp. Auf dem Radio-Dashboard sowie in LiveTV/Streaming identisch; im Webview-Vollbild ausgeblendet. Tastatur: Fokusreihenfolge, `aria-live` für Statuswechsel.

## 5. Senderverwaltung und Einstellungen

`settings-view.js`: neue Gruppe **Radio** (`SETTINGS_NAV`) mit Seiten:

| Seite | Inhalt |
|---|---|
| **Sender** | Suche (Name, Genre, Region; ohne Umlaut-/Groß-Kleinschreibungsabhängigkeit), Tabs **Alle / Favoriten**, Filter Quelle · Genre · Region, Stern zum Favorisieren, **Reihenfolge bearbeiten** (Drag & Drop, Tastatur-Alternative ▲▼, wie LiveTV), Sender anhören per Vorhör-Button, Sender bearbeiten (Name, Logo, URL als Override), Zähler „n von m“ |
| **Eigene Sender** | Liste, Hinzufügen/Bearbeiten/Löschen, „Stream prüfen“ |
| **Wiedergabe** | Start-Lautstärke, „Beim Start letzten Sender fortsetzen“ (Standard aus), „Radio pausieren, wenn TV/Streaming Ton abspielt“, Verhalten beim Fensterschließen (weiterspielen, Standard an), Sleep-Timer-Voreinstellung (optional, §9) |

Umsetzung: `settings-radio-stations.js` und `settings-radio-custom.js`, schlank, ohne EPG-/Override-Komplexität; gemeinsame Bausteine (Suche, Favoriten-Sortierung, Drag & Drop) aus `settings-tv-channels.js` in ein gemeinsames Modul herausziehen statt 784 Zeilen zu duplizieren. Die Dashboard-Schaltfläche „Senderverwaltung“ ruft `showDashboard('settings', { page: 'radio-stations' })`.

## 6. Menüzeilensymbol (Tray)

Der Tray existiert bereits dauerhaft (`TrayController`, Menümodell rein in `lib/recorder/tray-menu-model.js`). Ergänzung:

- Neuer Abschnitt **Radio** oben im Menü (vor Aufnahmen, solange keine Aufnahme läuft; sonst unterhalb):
  - Zeile (deaktiviert): `▶ SWR3 — Interpret – Titel` bzw. „Radio aus“
  - **Pause/Fortsetzen**, **Stopp**
  - **Nächster / Vorheriger Favorit**
  - Untermenü **Favoriten** (Sender in Dashboard-Reihenfolge, aktiver mit Häkchen)
  - Untermenü **Lautstärke** (Stumm, 25/50/75/100 %), da Menüs keinen Slider erlauben
  - **Radio-Dashboard öffnen**
- Icon: Aufnahme (rot) hat Vorrang; bei reiner Radiowiedergabe eigenes Icon-Paar `tray-radio` (Wellen-Symbol; `scripts/generate-tray-icons.js` erweitern). Titel-Tooltip zeigt Sender.
- Menü-Aktualisierung nur bei Änderung (`onlyIfChanged`, Signatur-Vergleich existiert), Titelwechsel gedrosselt (max. alle 5 s), damit der Tray nicht flackert.
- Das Menümodell bekommt `radio`-Parameter und bleibt rein, daher per `node --test` prüfbar. Der Radio-Controller wird dem `TrayController` per Konstruktor injiziert (wie `recorder`).
- Linux: Tray-Menüs verhalten sich je Desktop unterschiedlich; Funktionsumfang gilt als „best effort“, Hauptsteuerung bleibt der Mini-Player.

## 7. Modulübersicht (neu/geändert)

Neu: `lib/radio/RadioController.js`, `lib/radio/radio-resolve.js`, `lib/radio/icy-parser.js`, `lib/radio/radio-state.js`, `lib/radiosources-merge.js`, `radio-player.html` + `preload-radio.js`, `radiosources.json`, `scripts/build-radio-list.js`, `radio-dashboard-model.js`/`-view.js` (Muster `dashboard-hub-*`), `radio-miniplayer-view.js`, `settings-radio-*.js`.
Geändert: `main.js` (IPC `radio:*`, Fenster, window-all-closed, Quit), `preload.js` (API `window.radio`), `renderer.js` (Nav, showDashboard, Konflikt mit TV), `index.html`, `styles.css`, `settings-view.js`, `lib/user-storage.js`, `lib/backup.js`, `lib/input-validation.js`, `lib/ipc-validation.js` (Sender der Nachrichten prüfen), `lib/recorder/TrayController.js` + `tray-menu-model.js`, `scripts/generate-tray-icons.js`, `README.md`, `CHANGELOG.md`.

Sicherheit: alle `radio:*`-IPC-Kanäle mit Absenderprüfung und Schema-Validierung (Muster `ipc-validation.js`); URLs nur http/https; Main-seitiges Fetchen mit Timeout, Größen- und Redirect-Limit; keine Stream-/Playlist-Inhalte als HTML rendern (`textContent`).

## 8. Plattform-Abgleich

Radio-Datenformat (`radiosources.json`: Quellen, Stationen, `favorites`, `favoriteRank`, Overrides) ist so gewählt, dass tvOS/iPad es später lesen können (Skill `cross-platform-sync`). In v1 nur Desktop; vor der Umsetzung Feldnamen mit `../StreamingHub-tvOS` und `../StreamingHub-iOS` abgleichen, damit später keine Migration nötig wird.

## 9. Entscheidungen (getroffen, Empfehlungen übernommen)

1. **Senderkatalog**: Nur kuratierte mitgelieferte Liste (Empfehlung für v1) oder zusätzlich Online-Suche im gesamten radio-browser-Verzeichnis („Sender aus Verzeichnis hinzufügen“)? Online-Suche wäre eine kleine Zusatzetappe nach R3.
2. **Weiterspielen bei geschlossenem Fenster** (Empfehlung: ja, App bleibt im Tray). Ändert das heutige Beenden-Verhalten.
3. **Mini-Player-Leiste** im Hauptfenster (Empfehlung: ja) oder Steuerung nur im Radio-Dashboard und im Tray.
4. **Sleep-Timer** in v1? (Empfehlung: nein, v1.1; Tray-Untermenü 15/30/60 min wäre günstig nachzurüsten.)
5. **Radio-Aufnahme**: außerhalb v1; die Aufnahme-Pipeline (ffmpeg) könnte Audio-Streams später übernehmen. Einverstanden?

## 10. Risiken

- Instabile Stream-URLs (Sender wechseln Hosts): Gegenmaßnahmen Wiederverbindung, `rbUuid`-Aktualisierung, Listenpflege je Release.
- `http`-Streams: Chromium blockt sie nicht in `file://`-Seiten mit der gewählten CSP, im Spike gegen echte Sender prüfen; Fallback: Main-Proxy-Stream (nur falls nötig).
- Audio im ausgeblendeten Fenster kann auf macOS gedrosselt werden: `backgroundThrottling:false`, `powerSaveBlocker('prevent-app-suspension')` während Wiedergabe, im Spike bei geschlossenem Hauptfenster über 30 min prüfen.
- Ton-Konflikte mit LiveTV/Aufnahmen: Regel in §2, E2E-Test.
- Aufwand der Senderverwaltung: Wiederverwendung statt Kopie, sonst doppelte Pflege.

## 11. Umsetzungsplan (Etappen, je `dev` → `qa`)

- **R0 Spike (klein)**: Player-Host-Fenster mit 5 echten Sendern (MP3, AAC, HLS, `.pls`, ICY), Wiedergabe bei geschlossenem Hauptfenster, radio-browser-Datenqualität/Lizenz prüfen, Entscheidung ein/zwei Streams für ICY. Ergebnis: kurzer Messbericht.
- **R1 Kern**: `RadioController`, Auflösung, ICY-Parser, Datenmodell, Storage, Merge, Backup, IPC. Unit-Tests (`resolve`, `icy`, `merge`, `state`, Validierung).
- **R2 Oberfläche**: Navigation, Dashboard, Mini-Player, TV-Konflikt.
- **R3 Einstellungen**: Senderverwaltung, eigene Sender mit „Stream prüfen“, Wiedergabeseite.
- **R4 Tray**: Menümodell, Icons, Weiterspielen bei Fenster zu, Medientasten/Now Playing.
- **R5 Abschluss**: README (Abschnitt Radio), CHANGELOG, E2E (Playwright mit lokalem Test-Stream-Server, stumm), Release-Freigabe durch den User.

**Tests**: pure Modelle per `node --test` (`radio-resolve`, `icy-parser`, `radiosources-merge`, Tray-Menümodell mit Radio, Favoriten-Reihenfolge, Validierung); E2E-Smoke: Navigation → Favorit setzen → Wiedergabe gegen lokalen HTTP-Stream → Fenster schließen → Tray-Zustand → Eigener Sender mit ungültiger URL wird abgelehnt.

**Abnahmekriterien v1**: Kachel „Radio“ in der Navigation; Dashboard zeigt Favoriten in gespeicherter Reihenfolge; Senderverwaltung (Suche/Stern/Sortieren) erreichbar aus Dashboard und Einstellungen; eigener Sender per URL hinzufügbar und abspielbar; Steuerung aus Tray; Radio läuft nach Fensterschließen weiter; Update erhält Favoriten und eigene Sender.

## 12. Änderungen durch R0 (Spike-Ergebnisse)

- Audio-Host im unsichtbaren Fenster **bestätigt**: 65/65 Sender (MP3, AAC, Opus, HLS, .pls, .m3u), 47 davon `http`. Pflicht: `autoplayPolicy: 'no-user-gesture-required'`.
- Weiterspielen ohne Hauptfenster **bestätigt** (30 min, 0 Aussetzer). `powerSaveBlocker` brachte keinen messbaren Nutzen, bleibt optional.
- ICY: `<audio>` liefert keine Metadaten → **kurze Zweitverbindung im Main** (`Icy-MetaData: 1`, Titel nach 8–16 KB, Neuverbindung alle 20–30 s); 55/63 Direktsender mit Titel. §2 „ein oder zwei Streams“ damit entschieden: zwei.
- Playlist-Auflösung: globaler `fetch` mit `AbortController` genügt (50/50 gegen Top-50); `node:http` nur optional. Nicht belegt, daher nicht übernommen: Ablehnung von „ICY 200 OK“, Hängen von `net.fetch`.
- `hls.js` funktioniert; gemeldeter `internalException` ist in R1 zu untersuchen.
- radio-browser.info: 50/50 Top-Sender erreichbar. Etikette: sprechender User-Agent, Serverliste per DNS `all.api.radio-browser.info` mit Zufallswahl und Failover, Klickzähler `/json/url/<uuid>`. **Offen:** Datenlizenz nicht genannt, Rechte an Logos/Streams ungeklärt → Logos nur per URL verlinken, vor Release klären.
- `mediaSession`: API vorhanden; macOS „Läuft gerade“ und Medientasten **ungeprüft**, manuelle Prüfung in R4.
