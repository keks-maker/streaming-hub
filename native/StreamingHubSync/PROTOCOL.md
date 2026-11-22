# StreamingHubSync: Protokoll (Version 1)

`main.js` startet `StreamingHubSync.app/Contents/MacOS/StreamingHubSync [--state-dir <Ordner>]` und spricht über stdin/stdout.
Eine Nachricht = eine Zeile UTF-8, ein JSON-Objekt, getrennt durch `\n`. stderr ist nur für Logs. Der Helfer beendet sich
mit Exit 0, sobald stdin geschlossen wird (EOF) oder `shutdown` kam; ein laufender Abgleich wird vorher beendet.
Standard für `--state-dir`: `~/Library/Application Support/Streaming Hub/SyncHelper/` (nur Datei `state.json`; Zustand der
CloudKit-Engine). Andere Daten der Desktop-App berührt der Helfer nie.

## Befehle (main.js an Helfer)

Jeder Befehl hat `id` (nicht leerer String, vom Aufrufer vergeben) und `cmd`. Befehle werden nacheinander bearbeitet.
Vor `hello` antwortet der Helfer auf alles außer `hello` mit `not_ready`.

| cmd | Felder | Antwort `result` |
|---|---|---|
| `hello` | `protocol` (Ganzzahl, hier 1) | `{protocol, helperVersion, account, kinds, lastSync}` |
| `status` | | `{account, lastSync}` |
| `sync` | `local` (alle lokalen Records), `pending` (optional, Liste Namen) | siehe unten |
| `shutdown` | | `{}`, danach Exit 0 |

`account`: `available`, `no_account` (kein Konto oder eingeschränkt), `unavailable` (vorübergehend). `kinds`:
`["Progress","Recent","Queue"]`. `lastSync`: Unix-Sekunden oder `null`.

### Record (Format wie `lib/sync-merge.js` und Core `SyncRecord`)

`{"name":"p:<videoID>","kind":"Progress","modified":1763800000.5,"deleted":false,"fields":{...}}`.
Namen: `p:<videoID>` (Progress), `r:<videoID>` (Recent), `queue` (Queue, `fields.items` = JSON-Text). `deleted` = Löschmarke
(Progress `done`). Unbekannte Felder bleiben erhalten. Records anderer Arten (Merklisten) in `local` werden ignoriert, solche
vom Server weder angewendet noch verändert. Ein unlesbarer Record in `local` ergibt `bad_request` für den ganzen Befehl.

### `sync`

JS liefert den gesamten lokalen Bestand einschließlich Löschmarken (`local`) und die seit dem letzten erfolgreichen Abgleich
lokal geänderten Namen (`pending`; leer reicht beim allerersten Lauf, der Helfer gleicht dann alles ab). Der Helfer holt die
Server-Änderungen, wendet `SyncMerge` mit den Core-Regeln an (`CloudSyncMerge.mergeKeepingPendingTombstones`: Last Writer Wins,
Tiebreak, 30-Tage-Löschmarken, wartende Marken bleiben geschützt; nichts wird auf dem Server gelöscht) und lädt aus.
Antwort `result`:

```json
{"apply":[<Record>],"remove":["p:abc"],"uploaded":["p:x"],"settled":["p:x","p:y"],"failed":["p:z"],"zoneReset":false,"lastSync":1763800000}
```

- `apply`: Records, die JS lokal übernehmen muss (Gewinner ungleich dem gelieferten Stand). JS schreibt sie ohne sie wieder
  als lokale Änderung zu markieren.
- `remove`: lokal entfallende Namen (abgelaufene Löschmarken).
- `uploaded`: auf dem Server gespeichert.
- `settled`: aus `pending` erledigt (gespeichert oder Server-Stand gewann); JS nimmt sie aus `pending`.
- `failed`: Senden fehlgeschlagen oder nach den Sende-Runden offen, bleibt in `pending`. `settled` und `failed` sind disjunkt (`failed` hat Vorrang).
- Der Erstabgleich (Hochladen des gesamten lokalen Bestands) gilt erst nach einem Lauf ohne Fehler und ohne `failed` als erledigt; andernfalls wird er im nächsten Lauf wiederholt, auch bei leerem `pending`.
- Hat JS zwischen Anfrage und Antwort einen Record erneut geändert, gilt dessen neuere `modified`; JS wendet `apply` nur an,
  wenn der lokale Record noch dem gelieferten entspricht, und lässt ihn sonst pending.

## Antworten

`{"id":"<id>","ok":true,"result":{...}}` oder `{"id":"<id>","ok":false,"error":{"code":"...","message":"..."}}`.
Ist die `id` nicht lesbar, ist sie `null`.

| code | Bedeutung |
|---|---|
| `bad_request` | Zeile kein JSON-Objekt, `id`/`cmd`/Felder fehlen oder haben falschen Typ |
| `unknown_command` | `cmd` unbekannt |
| `not_ready` | Befehl vor erfolgreichem `hello` |
| `unsupported_protocol` | `hello.protocol` passt nicht; Helfer bleibt offen, Aufrufer sollte stdin schließen |
| `no_account` | Kein iCloud-Konto (nur bei `sync`) |
| `account_unavailable` | iCloud vorübergehend nicht erreichbar (nur bei `sync`) |
| `sync_failed` | Netz-/CloudKit-Fehler oder Zone nicht anlegbar; `message` enthält die Beschreibung |

## Ereignisse (unaufgefordert, ohne `id`, erst nach erfolgreichem `hello`)

- `{"event":"remoteChange"}`: Server-Änderung (Push) eingetroffen; JS soll `sync` senden. Eigene Abrufe/Sendungen lösen es nicht aus.
- `{"event":"account","status":"available|no_account|unavailable"}`: Kontostatus hat sich geändert (Anmeldung, Abmeldung, Wechsel).

## Ablauf

1. Start, `hello` senden, `account` prüfen (nicht `available`: Schalter in den Einstellungen auf „kein iCloud-Konto“, kein `sync`).
2. `sync` beim Start, auf `remoteChange`, nach lokalen Änderungen (entprellt, empfohlen 45 s wie der Core) und bei `account` -> `available`.
3. Beim Beenden stdin schließen (EOF); Helfer beendet sich selbst.

Änderungen an Feldern sind abwärtskompatibel (unbekannte Felder ignorieren); inkompatible Änderungen erhöhen `protocol`.
