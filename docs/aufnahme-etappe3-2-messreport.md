# Messreport Etappe 3.2 — Datenmodell B (EPG)

Stand: 04.10.2026 · Branch `feature/etappe-3-2-epg-daten` · Entscheidungen: AUF-E (Etappe-3-Plan T3/P5/P12/P13/P18), EPG-E7.

## 1. Messaufbau

- **Quelle:** genau EIN Download der `epgUrl` aus `tvsources.json` (`https://iptv-epg.org/files/epg-de.xml`, 04.10.2026 ca. 20:33), 49 431 585 Byte (47,1 MB), danach nur noch Messläufe gegen die lokale Datei; Datei nach den Messungen gelöscht, nicht im Repo.
- **Skript:** `scripts/measure-epg.js <datei> [--lib-dir <lib>] [--now <ISO>] [--table <json>] [--write-categories <out>] [--json]` nutzt die echten Module (`EpgService.refresh()` mit einer Download-Seam auf die lokale Datei, danach `EpgStore.load()`), lädt nie aus dem Netz. Fester Bezugszeitpunkt `--now 2026-10-04T18:40:00Z` (Fenster jetzt − 1 Tag … + 10 Tage, wie in der App), damit Vorher/Nachher dieselben 73 602 Sendungen / 434 Kanäle enthalten.
- **„Vorher“ (v1):** Modulstand von `main` (`git archive HEAD lib` in ein Scratch-Verzeichnis), Cache-Format v1. **„Nachher“ (v2):** dieser Branch. Jeder Lauf ist ein eigener Prozess (Peak-RSS sonst nicht vergleichbar); je Variante 3 Läufe, Werte stabil (Streuung unter 3 %), Median angegeben.
- **Peak-RSS:** gesampelt alle 20 ms über `process.memoryUsage().rss`, Basis (Prozess nach dem Laden der Module) ca. 47 MB. Der RSS-Peak umfasst Download-Stream, Parser, Slot-Objekte und das Schreiben des Caches.
- Rechner: lokaler Mac (Node der Electron-Umgebung des Repos), Zeiten ohne Netz (lokale Datei) — **echte Download-Zeit und gzip-Transfer: nicht gemessen** (Quelle wurde per `curl` einmal als 47,1 MB Klartext geladen).

## 2. Cachegröße, Zeit, Speicher (vorher/nachher)

| Messwert | v1 (main) | v2 (Branch) | Änderung |
|---|---|---|---|
| Cachedatei `epg-cache.json` | 17 428 837 B (16,6 MB) | 23 987 271 B (22,9 MB) | **+6,6 MB (+37,6 %)** |
| Refresh gesamt (Parse + Cache bauen + Schreiben) | 427 ms | 676 ms | +249 ms (+58 %) |
| Parse allein (Parser, Datei im Speicher, 3 Läufe) | 295 ms | 473 ms | +178 ms (+60 %) |
| Laden des Caches (`load()`) | 57 ms | 80–99 ms | +25–40 ms |
| Peak-RSS beim Refresh | 316 MB (+268 MB zur Basis) | 247 MB (+199 MB) | **−69 MB** |
| Gehaltener Heap nach GC (Cache im Speicher) | 79 MB | 67 MB | −12 MB |
| Sendungen / Kanäle im Fenster | 73 602 / 434 | 73 602 / 434 | unverändert |

Einordnung:

- **Cachegröße:** Erwartung laut Konzept +6–7 MB auf ~18 MB — gemessen +6,6 MB auf 16,6 MB. Die Bild-URL-Stringtabelle hält 15 096 eindeutige URLs für 54 221 Sendungen mit Bild (je URL einmal in der Datei). Zeilen mit leeren Feldern am Ende werden gekürzt (v1-förmige 4-Element-Zeilen bleiben möglich).
- **Parse-/Refresh-Zeit:** Der Mehraufwand kommt vom Feld-Scan je Sendung (Kategorien, Credits, Icon, …) und dem Umkopieren der gespeicherten Strings. Für den Schedule-Slip (lädt dieselbe Quelle erneut) bedeutet das rund 0,25 s mehr Rechenzeit je Refresh auf diesem Rechner; der Netzdownload dominiert weiterhin. Die Last bleibt im Streaming (Event-Loop wird je Chunk freigegeben).
- **Speicher:** Zwei Maßnahmen drücken den Verbrauch trotz zusätzlicher Felder unter den Stand von v1: (1) gespeicherte Strings werden vom Lese-Chunk gelöst (V8-„Sliced Strings“ halten sonst den ganzen Chunk — und damit bei v1 Teile der Quelldatei — im Speicher), (2) der Cache wird stückweise geschrieben statt als eine 25-MB-Zeichenkette. Der Speicher wächst nicht mit der Dateigröße (Parser-Puffer < 200 000 Zeichen, siehe Parser-Test).

## 3. Abdeckung der Felder (Sendungen im Fenster, n = 73 602)

| Feld | Sendungen | Anteil |
|---|---|---|
| `category` (mind. eine) | 58 010 | 78,8 % |
| `icon` (gültige http/https-URL) | 54 221 | 73,7 % |
| `date` → Jahr (1900–2100) | 55 118 | 74,9 % |
| `episode-num` (→ „S2 E3“ o. Ä.) | 23 819 | 32,4 % |
| `credits` (irgendein Eintrag) | 17 787 | 24,2 % |
| davon `director` / `actor` / `presenter` | 13 400 / 12 400 / 4 | 18,2 % / 16,8 % / 0,0 % |
| `sub-title` | 0 | 0 % |
| `rating` | 0 | 0 % |

`sub-title` und `rating` liefert die aktuelle Quelle nicht (wie im Konzept vermutet, EPG-E7); der Parser liest sie trotzdem (Fixture-Tests). `presenter` kommt praktisch nicht vor. Die Quelle nennt Episoden teils ohne `system`-Attribut (z. B. „S1 E3“, „E826“) — diese werden unverändert übernommen.

## 4. Genre-Verteilung (Konzept §5/B3, P13)

Verwendete Tabelle: `lib/epg/genre-table.json` (Vorschlag aus dem Konzept, Teilstring-Regeln nur wo eindeutig). Der Parser liefert 325 distinkte Kategorienamen (das Konzept nennt „333“ in der Rohquelle; Differenz durch Fenster, Kürzung auf 40 Zeichen und max. 3 Kategorien je Sendung).

| Gruppe | Sendungen | Anteil (von 73 602) |
|---|---|---|
| (keine Kategorie) | 15 592 | 21,2 % |
| news | 12 166 | 16,5 % |
| doku | 11 419 | 15,5 % |
| kinder | 7 546 | 10,3 % |
| film | 6 926 | 9,4 % |
| show | 6 688 | 9,1 % |
| **sonstiges** | **5 330** | **7,2 %** |
| sport | 4 350 | 5,9 % |
| serie | 2 496 | 3,4 % |
| musik | 1 089 | 1,5 % |

- **Abnahmekriterium „≥ 90 % der Sendungen mit Kategorie nicht in sonstiges“:** erfüllt — 5 330 von 58 010 Sendungen mit Kategorie landen in „sonstiges“ = **9,2 %** (90,8 % zugeordnet). Es ist knapp. Maßgeblich ist hier die Sendung (die Prioritätsliste news, sport, kinder, doku, serie, film, show, musik wirkt bei mehreren Kategorien).
- Zählt man jedes einzelne Kategorie-Vorkommen (95 713), liegt der Anteil „sonstiges“ bei **14,2 %** — dahinter steckt die Konzept-Vorgabe, dass Magazin/Gesellschaft/Ratgeber/Lifestyle/Kochen/Auto/Kultur ausdrücklich „sonstiges“ sind.
- **Top-Werte, die in „sonstiges“ fallen** (Vorkommen): Magazin 3 649, Gesellschaft 2 766, Ratgeber 2 367, Lifestyle 1 464, Kochen 1 077, Verschiedenes 555, Auto 534, Kultur 336, Heimwerker 188, Werbesendung 127, Küche 108, Queer 84, Familie 66, Umweltmagazin 16, Gesundheitsmagazin 15, Kulturmagazin 15, Medienmagazin 15, Auslandsmagazin 14.
- **Alle 53 nicht zugeordneten Kategorien** (Vorkommen): Magazin (3649), Gesellschaft (2766), Ratgeber (2367), Lifestyle (1464), Kochen (1077), Verschiedenes (555), Auto (534), Kultur (336), Heimwerker (188), Werbesendung (127), Küche (108), Queer (84), Familie (66), Umweltmagazin (16), Gesundheitsmagazin (15), Kulturmagazin (15), Medienmagazin (15), Auslandsmagazin (14), Infomagazin (12), Mode (12), Programmende (12), Automagazin (10), Boulevardmagazin (10), Globalisierungsmagazin (10), Servicemagazin (10), Wirtschaft (10), Wirtschaftsmagazin (9), Fitnessmagazin (8), Kunstmagazin (7), Verbrauchermagazin (7), Fitnessübungen (5), Lifestylemagazin (5), Werbung (5), Antiquitätenratgeber (3), Freizeitmagazin (3), Kunst (3), Tiervermittlung (3), Finanzmagazin (2), Medizin (2), Religionsbericht (2), Sonstige (2), „- kein Charakter -“ (1), Bürgersendung (1), Frauenmagazin (1), Gottesdienst (1), Kinomagazin (1), Klamauk (1), Kochmagazin (1), Kochsendung (1), Tanz (1), Übertragung (1), Umweltlotterie (1), Volksfestmagazin (1).

**Änderungswünsche zur Feinjustierung (nur Vorschlag, Entscheidung P13 liegt beim User):**

1. *Nichts ändern:* Tabelle gemäß Konzept erfüllt das Kriterium (9,2 %), der Wert „sonstiges“ bleibt für Service-/Lifestyle-Sendungen bewusst bestehen.
2. *Magazin-/Service-Familie in „doku“ (Info-Programm) ziehen:* `Magazin, Gesellschaft, Ratgeber, Lifestyle, Kochen, Küche, Auto, Kultur, Heimwerker, Mode, Wirtschaft, Verschiedenes` als `exact` und die Teilstrings `magazin`, `ratgeber` in `contains.doku`. Gemessen (gleiche Quelle): „sonstiges“ fällt auf **157 Sendungen = 0,3 %** der Sendungen mit Kategorie (doku wächst von 15,5 % auf 25,8 % aller Sendungen); die Gruppen news/sport/kinder bleiben unberührt, da sie in der Priorität davor stehen. Nachteil: „doku“ wird dann zur Sammelgruppe „Information/Magazin“ — die Genre-Farbe sagt weniger aus. Umsetzung wäre reine Datenänderung in `genre-table.json`.
3. Einzeleinträge (klein, ohne Nebenwirkung): `Familie` → kinder (66), `Werbesendung`/`Werbung` → eigene Behandlung (UI-Entscheidung), `Queer` → sonstiges belassen.

## 5. Bild-Hosts (Befund für P12 „Sendungsbilder laden“-Schalter)

| Host | Sendungen mit Bild | Anteil |
|---|---|---|
| `iptv-epg.org` | 54 221 | **100,0 %** |

- Protokoll: **100,0 % https**, 0,0 % http.
- 15 096 eindeutige Bild-URLs (je Quelle in der Stringtabelle einmal gespeichert).
- Befund: In dieser Quelle zeigen alle Icons auf denselben Host wie das EPG selbst (`iptv-epg.org`); Konzept B5 („Anfragen gehen direkt an `iptv-epg.org`“) trifft für diese Quelle zu. Fremdhosts kommen nicht vor. Offen für P12: andere, vom Nutzer eingetragene EPG-Quellen können beliebige Hosts liefern (der Parser lässt jede http/https-URL zu); ob der Schalter dennoch nötig ist, ist die Entscheidung des Users. Der Parser verwirft `javascript:`, `data:`, `ftp:`, `file:` und URLs > 512 Zeichen.

## 6. Nicht gemessen

- Echte Download-Zeit und Transfergröße (gzip) der Quelle (nur lokale Datei, Einmal-Download).
- Peak-RSS im laufenden Electron-Main-Prozess (gemessen im reinen Node-Prozess mit denselben Modulen; Electron-Overhead und Renderer nicht enthalten).
- Zeit bis zur Anzeige im Renderer (keine UI in 3.2).
- Mehrere Quellen gleichzeitig (nur die eine konfigurierte `epgUrl`).
- Schedule-Slip-Laufzeit end-to-end gegen die Live-Quelle (nur die Parse-/Refresh-Zeit, die er verursacht, siehe §2; Verhalten mit v1- und v2-Cache ist in `tests/schedule-epg-cache-versions.test.js` abgedeckt).

## 7. Reproduzierbarkeit

- Genre-Abnahme: `tests/epg-genre.test.js` liest `tests/fixtures/epg-category-values.json` (325 Werte mit Häufigkeit und 922 Kategorie-Kombinationen je Sendung, kein Rohdaten-Dump) und prüft den 10-%-Grenzwert; Fixture erzeugt mit `node scripts/measure-epg.js <epg.xml> --now 2026-10-04T18:40:00Z --write-categories tests/fixtures/epg-category-values.json`.
- Messung wiederholen: `node scripts/measure-epg.js <lokale epg-de.xml> --now 2026-10-04T18:40:00Z --json` (v2) bzw. mit `--lib-dir <Export von main>/lib` (v1).
