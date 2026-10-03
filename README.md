# Streaming Hub

Zentrale Streaming-Anwendung mit Widevine-DRM-Unterstützung über Castlabs Electron. Bündelt Streaming-Dienste, Mediatheken und Live-TV in einer einheitlichen Oberfläche. Der Installer unterstützt Linux x86_64 sowie macOS auf Intel- und Apple-Silicon-Macs.

## Unterstützte Dienste

### Streaming
| Dienst | URL |
|---|---|
| Netflix | https://www.netflix.com |
| YouTube | https://www.youtube.com |
| Disney+ | https://www.disneyplus.com |
| Prime Video | https://www.primevideo.com |
| Twitch | https://www.twitch.tv |
| Spotify | https://open.spotify.com |

### Mediatheken
| Dienst | URL |
|---|---|
| ARD Mediathek | https://www.ardmediathek.de/ |
| ZDF Mediathek | https://www.zdf.de/ |
| ARTE | https://www.arte.tv/de/ |

## Funktionen

- **Start-Dashboard** – Schnellzugriff auf Live-TV, Streaming-Dienste, Mediatheken, Aufnahmen und Einstellungen
- **Live-TV** – Sender-Kacheln, Favoriten, aktuell laufende Sendungen und Senderverwaltung (M3U-Quellen, Suche, Sortierung)
- **EPG (Programmübersicht)** – Vollbild-Ansicht mit Favoriten und Zeitslots (2/4/8/12/24h)
- **Aufnahmen** – Live-TV-Sendungen aufnehmen, auch vom Beginn der laufenden Sendung an, und später in der App abspielen
- **Zeitversetztes Fernsehen (Timeshift)** – Bei unterstützten Live-Streams zurückspulen und Sendungen per EPG-Marker anspringen
- **Mediathek-Suche** – ARD, ZDF und ARTE direkt aus der Programmübersicht durchsuchen
- **Bild-in-Bild** – Schwebendes Fenster für paralleles Schauen (auch TV-Streams)
- **Verlauf** – Zuletzt gesehene Inhalte mit Direktsprung
- **Streaming-DRM** – Netflix, Disney+ und Prime Video funktionieren mit Widevine
- **Gespeicherte Logins** – Du meldest dich bei jedem Dienst nur einmal an
- **Einstellungen** – Dienste, TV-Quellen, Sender, EPG, Wiedergabe und Aufnahmen an einem Ort
- **Backup/Restore** – Einstellungen, Dienste, TV-Quellen und Verlauf sichern und wiederherstellen
- **Auto-Update** – Neue Versionen direkt aus der App installieren
- **Tastaturkürzel** – für Navigation, Verlauf, Aufnahmen, Bild-in-Bild und Vollbild

## Voraussetzungen

| Voraussetzung | Unterstützung |
|---|---|
| **Node.js** | >= 22.12 |
| **npm** | Kommt mit Node.js |
| **Linux** | x86_64; Paketmanager apt, dnf, pacman oder zypper |
| **macOS** | Intel (x64) und Apple Silicon (arm64) |

## Installation

Unter Linux und macOS erkennt der Installer Betriebssystem und Architektur automatisch:

```bash
curl -fsSL https://raw.githubusercontent.com/keks-maker/streaming-hub/main/install.sh | bash
```

Unter Linux wird die App standardmäßig nach `~/.local/share/streaming-hub` installiert und im Anwendungsmenü eingetragen. Unter macOS liegen die App-Dateien standardmäßig in `~/Library/Application Support/Streaming Hub`; das native App-Bundle für Finder und Dock wird unter `~/Applications/Streaming Hub.app` installiert. Ein abweichender Installationspfad kann über `INSTALL_DIR` gesetzt werden.

Der Installer kann Node.js unter Linux über den jeweiligen Paketmanager installieren. Auf macOS nutzt er Homebrew, falls Node.js fehlt oder zu alt ist und Homebrew bereits installiert ist.

Homebrew-Installation (https://brew.sh/):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Andernfalls müssen Node.js und npm vorher installiert sein. Windows wird von `install.sh` nicht unterstützt.

### Manueller macOS-Download (ZIP aus dem Browser)

Die App ist nicht notarisiert (kein Apple-Developer-Account); das Bundle ist nur
ad-hoc signiert. Wird das ZIP manuell im Browser geladen, setzt macOS das
Quarantäne-Flag und Gatekeeper blockiert den ersten Start:

- Entpacken, `Streaming Hub.app` nach `/Applications` ziehen, beim ersten Start
  Rechtsklick → **Öffnen** → **Öffnen** bestätigen (ggf. unter Systemeinstellungen →
  Datenschutz & Sicherheit → „Trotzdem öffnen“).
- Meldet macOS „Streaming Hub ist beschädigt und kann nicht geöffnet werden“,
  Quarantäne-Flag entfernen: `xattr -cr "/Applications/Streaming Hub.app"`

Installationen über den In-App-Updater oder den Installer sind nicht betroffen
(kein Quarantäne-Flag).

## Bedienung

### Startseite

Die Startseite bündelt die Bereiche Live-TV, Streaming, Mediatheken, Aufnahmen und Einstellungen. Wähle eine Kachel, um den Bereich zu öffnen.

![Start-Dashboard mit den Bereichen Live-TV, Streaming, Mediatheken, Aufnahmen und Einstellungen](assets/screenshots/startseite.png)

### Navigationsleiste

In den Bereichen erscheint die Navigationsleiste am oberen Bildschirmrand. Sie wechselt zwischen Live-TV, Streaming, Mediatheken, Aufnahmen und Einstellungen.

![Navigationsleiste und Streaming-Dashboard](assets/screenshots/navbar.png)

### Streaming-Dienste nutzen

Nach dem Klick auf einen Dienst wird die Webseite im Hauptbereich geladen. Deine Login-Daten und Sessions werden gespeichert – du musst dich nur einmal anmelden.

### Live-TV

#### Live-TV-Dashboard öffnen

Wähle in der Navigationsleiste **LiveTV**. Das Dashboard zeigt geladene Sender als Kacheln, Favoriten sowie die aktuelle EPG-Programmübersicht. Über **Alle Sender** öffnest du die Senderverwaltung.

![Live-TV-Dashboard mit Favoriten und aktueller Sendung](assets/screenshots/livetv-dashboard.png)

#### Sender verwalten

Die Senderverwaltung findest du unter **Einstellungen → LiveTV → Sender** (auch über **Senderverwaltung** im Live-TV-Dashboard). Sie bietet eine Suche, getrennte Ansichten für alle Sender und Favoriten sowie Sortierung und Senderbearbeitung (Name, EPG-Zuweisung, Logo, Stream-URL). Ein Hinweis zeigt, ob zu einem Sender EPG-Daten gefunden wurden.

![Senderverwaltung unter Einstellungen → LiveTV → Sender](assets/screenshots/tv-senderverwaltung.png)

#### TV-Quellen verwalten

Öffne **Einstellungen → LiveTV → Quellen**, um TV-Quellen zu pflegen. Du kannst Quellen hinzufügen, bearbeiten und entfernen:
- **Name** – z.B. „Deutsche Sender“
- **M3U-URL** – Link zu einer M3U-Playlist (oder lokale Datei über 📁)
- **EPG-URL** (optional) – Link zu einer XMLTV-Datei für Programminformationen
- **Farbe** – Kennzeichnung der Quelle

Favoriten und Anpassungen bleiben beim Bearbeiten einer Quelle erhalten. Eine vorkonfigurierte Quelle (Deutsche Öffentlich-Rechtliche) ist bereits enthalten. Unter **LiveTV → EPG** siehst du die EPG-URL je Quelle und kannst das Programm manuell aktualisieren.

#### Sender auswählen

Klicke eine Sender-Kachel im Live-TV-Dashboard oder einen Eintrag in der Senderverwaltung an, um den Stream zu starten. Die Senderverwaltung lässt sich über **Alle Sender** öffnen und bietet Suche sowie Gruppen.

#### Favoriten

Klicke in der Senderverwaltung auf den Stern (☆), um einen Sender als Favorit zu markieren. Im Tab **Favoriten** kannst du die Favoriten separat ansehen und sortieren.

#### Favoriten sortieren

Öffne in der Senderverwaltung den Tab **Favoriten**, wähle **Reihenfolge bearbeiten** und verschiebe Sender per Drag & Drop. Die Sortierung wird gespeichert.

#### Kanalwechsel im TV-Modus

Im laufenden TV-Stream kannst du die Sender wechseln:
- **Pfeiltasten hoch/runter** – nächster/vorheriger Sender

Beim Wechsel erscheint kurz ein Kanal-Overlay mit dem aktuellen Sender und den umgebenden Kanälen (inkl. EPG-Info).

#### TV-Player Steuerung

Bewege die Maus, um die Steuerungs-Overlays einzublenden:

**Oben links:** Sendername + Logo

**Unten:** Komplette Player-Steuerung:
- **EPG-Leiste** – Aktuelle Sendung mit Uhrzeit
- **DVR-Leiste** – Sendungsmarker anklicken, zurückspulen oder mit `L` zur Live-Kante springen (bei unterstützten Streams)
- **Play/Pause** – Button oder `Leertaste` / `K`
- **Lautstärke** – Slider oder `+` / `-`
- **Stumm** – Button oder `M`
- **Audiospur** – Dropdown bei Sendern mit mehreren Tonspuren
- **Vollbild** – Button oder `F`

#### Sender bearbeiten

Unter **Einstellungen → LiveTV → Sender** verwaltest du alle Sender: Suche, Filter nach Quelle, Favoriten per Stern und Reihenfolge der Favoriten. Wähle einen Sender, um ihn anzupassen:
- **Name** – Anzeigename
- **EPG-Zuordnung** – Programmdaten (tvg-id) zuweisen, mit Auswahlliste
- **Logo-URL** – Senderlogo ersetzen, mit Vorschau
- **Stream-URL** – Stream überschreiben, mit „Auf Original zurücksetzen“

Die Änderungen werden pro TV-Quelle gespeichert und sind sofort aktiv.

#### Aufnahmen

Live-TV-Sendungen lassen sich direkt im TV-Player aufnehmen und später ansehen. Voraussetzung ist, dass die Aufnahme-Komponente (ffmpeg) verfügbar ist; ihren Status zeigt **Einstellungen → LiveTV → Aufnahmen**.

**Aufnahme starten:** Klicke im TV-Player unten auf den Aufnahme-Button (Ring mit Punkt) oder drücke `R`. Es erscheint ein Dialog mit drei Optionen:
- **Ab Bildposition starten** – Beginnt an der Stelle, die du gerade im Zeitversatz ansiehst (am Live-Bild nicht verfügbar)
- **Aktuell angezeigte Sendung aufnehmen** – Nimmt die laufende Sendung ab ihrem Anfang auf, sofern dieser noch im Zeitversatz-Fenster des Senders liegt
- **Bis zum Ende der Sendung** – Nimmt ab jetzt auf und stoppt automatisch am Sendungsende (benötigt EPG-Daten)

Nicht verfügbare Optionen sind ausgegraut; ein Hinweis nennt den Grund. Es können bis zu drei Aufnahmen gleichzeitig laufen (je Sender eine).

![Aufnahme-Dialog im TV-Player](assets/screenshots/aufnahme-dialog.png)

**Laufende Aufnahme:** Oben im Player zeigt ein „REC“-Hinweis mit Laufzeit, Sender und Sendung, dass aufgenommen wird – auch wenn du den Sender wechselst. Ein Klick darauf (oder auf den roten Aufnahme-Button) öffnet die Verwaltung zum Beenden. Aufnahmen laufen weiter, wenn du das Fenster schließt: Die App bleibt dann im Tray (Symbol rot bei laufender Aufnahme) und lässt sich von dort öffnen oder die Aufnahme stoppen. Reißt die Verbindung kurz ab, versucht die App automatisch, die Aufnahme fortzusetzen; nach einem Absturz werden unvollständige Aufnahmen beim nächsten Start gerettet.

**Aufnahmen ansehen:** Öffne auf der Startseite die Kachel **Aufnahmen** oder drücke `Strg` + `R`. Die Übersicht zeigt Titel, Sender, Datum, Dauer und Status jeder Aufnahme. Hier kannst du Aufnahmen abspielen und löschen. Während eine Aufnahme nach dem Beenden in das MP4-Format umgewandelt wird, siehst du den Fortschritt; fertige Aufnahmen liegen als normale MP4-Dateien im Speicherordner und lassen sich auch mit anderen Playern öffnen.

![Aufnahmen-Übersicht](assets/screenshots/aufnahmen-dashboard.png)

**Speicherort:** Standardmäßig `~/Videos/Streaming Hub`. Unter **Einstellungen → LiveTV → Aufnahmen** kannst du einen anderen Ordner wählen (auch Netzwerkpfade, mit Warnhinweis). Der Wechsel ist nur möglich, solange keine Aufnahme läuft.

![Einstellungen für Aufnahmen: Speicherort und ffmpeg-Status](assets/screenshots/einstellungen-aufnahmen.png)

> **Hinweis:** Aufnahmen funktionieren für Live-TV-Sender aus deinen M3U-Quellen, nicht für DRM-geschützte Streaming-Dienste.

### EPG – Programmübersicht

Klicke im Live-TV-Dashboard auf **EPG öffnen**, um die vollständige Programmübersicht aufzurufen.

![EPG-Programmübersicht](assets/screenshots/epg-uebersicht.png)

Die EPG-Ansicht zeigt:
- **Zeitleiste** – Alle Favoriten-Sender mit Sendungen als Balken
- **Jetzt-Linie** – Vertikale Linie für die aktuelle Uhrzeit
- **Zeitslots** – Wähle 2h, 4h, 8h, 12h oder 24h Ansicht

Klicke auf eine Sendung für Details:
- **Sender öffnen** – Sender direkt starten
- **In Mediathek ansehen** – Sendung in ARD/ZDF/arte Mediathek suchen (falls verfügbar)

![EPG-Sendungsdetails mit Aktionen](assets/screenshots/epg-sendung.png)

### Mediathek-Suche

Aus der EPG-Übersicht kannst du Sendungen direkt in den Mediatheken suchen. Der Button "In Mediathek ansehen" öffnet den entsprechenden Dienst (ARD, ZDF oder ARTE) mit dem Sendungstitel als Suchbegriff.

### Verlauf

Klicke auf das Uhr-Icon in der Navigationsleiste oder drücke `Strg+H`, um den Verlauf zu öffnen. Er zeigt die zuletzt abgespielten Inhalte mit Titel, Dienst und Zeitstempel.

Ein Klick auf einen Eintrag springt direkt zum entsprechenden Dienst oder TV-Sender. Mit "Löschen" kannst du den gesamten Verlauf leeren.

![Wiedergabeverlauf](assets/screenshots/verlauf.png)

### Einstellungen

Klicke auf das Zahnrad-Icon in der Navigationsleiste, um die Einstellungen zu öffnen. Links wählst du eine Seite aus:

- **Allgemein** – Backup & Restore
- **LiveTV** – Quellen, Sender, EPG, Wiedergabe (TV-Modus) und Aufnahmen
- **Streaming** – Streaming-Dienste hinzufügen und entfernen
- **Mediatheken** – Mediatheken hinzufügen und entfernen

![Einstellungen mit Seitenleiste und Senderverwaltung](assets/screenshots/settings.png)

#### Backup & Restore
- **Backup erstellen** – Speichert Dienste, TV-Quellen und Verlauf als Datei
- **Backup einspielen** – Stellt ein vorheriges Backup wieder her

#### Dienste verwalten
Über **+** fügst du eigene Streaming-Dienste oder Mediatheken hinzu (Name, URL, Icon, Farbe); mit dem ×-Button entfernst du sie wieder.

#### TV-Modus
- **FreeTV** – TV-Button öffnet die Sidebar mit eigenen M3U-Sendern
- **MagentaTV** – TV-Button öffnet web.magentatv.de im Webview

### Tastaturkürzel

Drücke `?` für eine Übersicht aller Kürzel:

| Kürzel | Funktion |
|---|---|
| `Strg` + `Tab` | Nächster Dienst |
| `Strg` + `Umsch` + `Tab` | Vorheriger Dienst |
| `Alt` + `←` | Zurück zur vorherigen Ansicht |
| `Strg` + `H` | Verlauf anzeigen |
| `Strg` + `R` | Aufnahmen öffnen |
| `Strg` + `T` | Live-TV öffnen |
| `Strg` + `P` | Bild-in-Bild umschalten |
| `F11` | Vollbild umschalten |
| `?` | Kürzel-Übersicht |
| `Escape` | Modal / Overlay schließen |

**Im TV-Player zusätzlich:**

| Kürzel | Funktion |
|---|---|
| `Leertaste` / `K` | Play / Pause |
| `F` | Vollbild |
| `M` | Stumm schalten |
| `←` / `→` | 10s zurück / vor |
| `L` | Zur Live-Kante springen (DVR-Streams) |
| `R` | Aufnahme starten bzw. verwalten |
| `+` / `-` | Lautstärke hoch / runter |

### Auto-Update

Der Update-Button in der Navigationsleiste zeigt den Status:
- **Grüner Haken** – App ist aktuell
- **Roter Pfeil (pulsierend)** – Update verfügbar

Klicke auf den Button, um das Update zu starten. Die App lädt die neue Version herunter und startet automatisch neu. Laufende Aufnahmen solltest du vorher beenden.

## Lizenz

MIT
