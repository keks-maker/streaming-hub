# Etappe 3.7 — Renderer-EPG-Datenweg: Inventur der Verbraucher

**Datum:** 2026-10-05  
**Status:** READ-ONLY, Ergebnis aus Codebase-Analyse  
**Ersatzziele:** Main-APIs `epg:now-next(channelKeys[])` und `epg:channels` implementieren

---

## Konsumenten des Renderer-EPG-Wegs (zu ersetzen)

| Datei:Zeile | Verbraucher | Art | Ersatz-API |
|---|---|---|---|
| **renderer.js:70** | `tvEpgIndex = null` (Deklaration) | Initialisierung | Entfernen |
| renderer.js:9-10 | Import `buildEpgIndex`, `getEpgChannelList` | Modul-Import | Entfernen (nur typed-core Tests) |
| renderer.js:120 | `getEpgNowNext()` - Jetzt/Nächste per tvEpgIndex | Lesen (Sidebar) | `epg:now-next` |
| renderer.js:598, 603 | `getEpgAt()` - Lookup zur Zeit t | Lesen (Detail-Panel) | `epg:find` (bereits vorhanden) |
| renderer.js:1497-1500 | `needsEpg`-Check, `loadEpgData()` aufrufen | Startup/Source-Wechsel | `epg:status`, `epg:refresh` |
| renderer.js:1518 | EPG-Status in Startup-UI (`tvEpgIndex.size`) | Display | `epg:status` |
| renderer.js:1587-1612 | `loadEpgData()` - Download + `buildEpgIndex()` | Laden/Parse | Entfernen (Main kümmert sich) |
| renderer.js:1628, 1644 | Refresh-Aufrufe nach Source-Wechsel | Reload | `epg:refresh` |
| renderer.js:1695, 1738, 2663, 2728 | tvEpgIndex-Lookups für Zapping-UI | Lesen (Zapping) | `epg:now-next` |
| renderer.js:3405-3410 | `getEpgIndex()`, `getEpgChannelList()` in Settings-API | Lesen (Settings) | **Neue API**: `epg:channels` |
| **settings-tv-channels.js:43** | Import `getEpgChannelList` | Modul-Import | Entfernen |
| settings-tv-channels.js:304 | `getEpgChannelList()` aufrufen | Lesen (EPG-Kanal-Zuordnung) | **Neue API**: `epg:channels` |
| **tv.html:1739-1750** | `epg-update`-Message mit `epgEntries` (XMLTV-Format) | Schreiben (DVR-Marker) | Bleibt, Format adapter: `epgEntry.start` / `.stop` → XMLTV-Zeitstring |
| **main.js:2** | Import `parseXMLTV` | Modul-Import | Main nutz es selbst weiter (nicht entfernen) |
| main.js:1596 | `parseXMLTV(xml)` | Parse im Main | Main-intern (nicht entfernen) |
| main.js:1589 | `ipcMain.handle('fetch-epg', …)` | IPC-Handler | Entfernen (Renderer lädt nicht mehr herunter) |
| **preload.js:52** | `fetchEPG: url => ipcRenderer.invoke('fetch-epg', url)` | IPC-Whitelist | Entfernen |
| preload.js:61-76 | Bestehende Main-APIs | Whitelist | Bleiben: `epg:range`, `epg:find`, `epg:range-many`, `epg:search`, `epg:status`, `epg:refresh`, `epg:changed` |

---

## Bereits verfügbare Main-APIs (Etappe 3.1+)

- `epg:range(channelKey, fromMs, toMs)` — Raster im Bereich
- `epg:find(channelKey, atMs)` — Sendung zur Zeit
- `epg:range-many(channelKeys[], fromMs, toMs)` — Mehrere Kanäle
- `epg:search(channelKeys[], query, …)` — Volltextsuche
- `epg:status()` — EPG-Status (loading/success/error)
- `epg:refresh()` — Refresh auslösen
- `epg:changed` (Event: Main → Renderer) — Signalisiert neuen Stand nach Refresh

## Neue Main-APIs zu implementieren (Etappe 3.7, Arbeitspaket 2)

| API | Signatur | Rückgabe | Zweck |
|---|---|---|---|
| **epg:now-next** | `(channelKeys[])` | `{ channelKey: { current: EpgEntry, next: EpgEntry } }` oder `null` | Sidebar Jetzt/Nächste, Zapping-Anzeige, Dashboard-Status |
| **epg:channels** | `()` | `[{ normId, channelId, sampleTitle }, …]` | Settings EPG-Kanal-Zuordnung (Dropdowns) |

---

## Risiken & Grenzen

| Risiko | Ort | Gegenmassnahme |
|---|---|---|
| **Zapping-Rendering:** Vier Stellen in renderer.js (`renderEpgNowNext`, `updateZappingInfo`, DVR-Leiste) lesen tvEpgIndex | renderer.js:1695, 1738, 2663, 2728 | `epg:now-next` implementieren, Renderer-Lookups ersetzen |
| **DVR-Marker-Format:** tv.html erwartet XMLTV-Zeitstrings (`2026-10-05T20:30:00+02:00`), typed-core liefert `EpgEntry` mit `start` / `stop` als ms | tv.html:1739-1750, tv.html Funktion `recomputeDvrMarkers()` | Adapter in renderer.js: `epgEntry.start` / `.stop` → `parseEpgTime()` format beim Senden an tv.html |
| **Settings Kanal-EPG-Zuordnung:** getEpgChannelList() wird über Settings-IPC abgerufen; Renderer-seitige Liste muss weg | settings-tv-channels.js:304 | Neue API `epg:channels` implementieren; preload erweitern |
| **Startup-Verzögerung:** Cache-leer (erster Start nach Reinstall) verzögert nun auch Sidebar/Dashboard Initial-Render | renderer.js:1497-1518 | Parallele Async-Ladung: Settings-UI zeigt erst Spinner, dann nach `epg:changed` den Stand. Test: `schedule.spec.js` |
| **Unbekannte Verbraucher:** Nur per grep gesehen; Änderungen im EPG-Grid/Detail-Modul (3.3+) könnten weitere Abhängigkeiten geschaffen haben | epg-grid-view.js, epg-view.js (neue Module) | Code-Review dieser Module; Tests `epg-view-model.test.js:457` verbietet `tvEpgIndex` |

---

## Grösse & Aufwand

| Posten | Aufwand |
|---|---|
| Neue Main-APIs implementieren (epg:now-next, epg:channels) | 2–3 PT (Impl. + Unit-Tests) |
| Renderer-Umstellung je Verbraucher (5 Stellen + Settings) | 3–4 PT (Refactor + E2E-Test) |
| DVR-Marker-Adapter (tv.html ↔ EpgEntry-Format) | 1–2 PT |
| Entfernen: loadEpgData, tvEpgIndex, fetch-epg-Handler | 1 PT |
| Regression-Testing (Smoke, Channels, Schedule, EPG-Overlay E2E) | 2 PT |
| **Summe** | **9–12 PT** |

**Grösse nach Plan:** L (viele Fundstellen, DVR-Anbindung, hohes Regressionsrisiko).

---

## Befund zusammengefasst

- **51 Referenzen** auf EPG-Verbraucher gefunden (grep, einschließlich Tests/Kommentare).
- **Kritische Stellen:** Startup (loadEpgData), Zapping (4 Stellen), DVR-Marker (tv.html), Settings Kanal-Zuordnung.
- **Bestehende Main-APIs:** 7 vorhanden (range, find, range-many, search, status, refresh, changed).
- **Neue APIs nötig:** `epg:now-next` (Jetzt/Nächste), `epg:channels` (Kanal-Liste).
- **Abhängigkeiten:** 3.1–3.6 müssen gemergt sein; typed-core-Exports NICHT löschen (Tests, Schwesterprojekte).

---

## Orchestrator-Korrekturen (Stichprobe + Vollständigkeits-grep, 05.10.2026)

Das Dokument wurde von Haiku erstellt und vom Orchestrator geprüft.

- Falsche Funktionsnamen: renderer.js:120 ist `getEpgForChannel` (nicht `getEpgNowNext`), 598/603 `getCurrentEpg` (nicht `getEpgAt`). Ersatz `epg:find` für 598/603 ist ungeprüft.
- "Sidebar"/"Alle Sender"-Verbraucher entfallen seit 3.6b; Verbraucher sind Zapping/Liste, `epg-update` (renderer.js:2681, 2751 → tv.html:1739) und Settings.
- Fehlend: renderer.js:3519 (`loadEpgData` in Settings-/Quellenweg), main.js:71 (Kommentar fetch-epg), `eslint.config.js:146` und `.eslintrc.json:17,38` (Global `tvEpgIndex`), `lib/epg/download.js:4` und `xmltv-stream-parser.js:3` (nur Kommentare), `scripts/test-u-scrubbar.cjs:208` (epg-update-Fixture).
- Tests, die den Ist-Zustand festschreiben und angepasst werden müssen: `tests/dashboard-hub.test.js:339,342` (verlangt `loadEpgData(collectEpgUrls(`), `tests/epg-ipc.test.js:165` (verlangt `fetch-epg`-Handler und `parseXMLTV`), `e2e/smoke.spec.js:34` (erwartet fetch-epg-Fehlermeldung), `e2e/schedule.spec.js:6`.
- `epg:now-next` und `epg:channels` existieren nirgends im Code (neu). Wegfall von `fetch-epg` kollidiert mit den genannten Tests.
- Die Größenschätzung (9–12 PT) ist unbelegt; Einschätzung: L.
