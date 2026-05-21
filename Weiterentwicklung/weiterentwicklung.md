# Weiterentwicklung – Streaming Hub

## 🔥 Hoher Mehrwert, mittlerer Aufwand

### 1. Dienste-Konfiguration auslagern (services.json) + Eingabemaske
Statt hartcodierter Liste in renderer.js + index.html eine externe JSON.
Der Nutzer kann eigene Dienste über eine UI-Maske hinzufügen/bearbeiten/löschen.

### 2. Tastatur-Shortcuts
- Strg+Tab / Strg+Shift+Tab – nächster/vorheriger Dienst
- Strg+L – URL-Leiste fokussieren
- F11 – Vollbild
- Strg+P – PiP togglen
- Escape – Vollbild verlassen

### 3. Media Session API + globale Medientasten ✅
Systemweit Pause/Play über MPRIS (Linux), Touch Bar (macOS) oder Medien-Tasten.

### 4. Auto-Update (electron-updater)
Automatische Updates über Gitea-Releases oder eigenen Update-Server.

## 🚀 Nützliche Erweiterungen

### 5. PiP mit Steuerung
Play/Pause, Skip ±10s, Lautstärke direkt im PiP-Fenster per IPC.

### 6. Tabs / Split-Screen
Zwei Webviews nebeneinander – z.B. Twitch + YouTube gleichzeitig.

### 7. Such-/Filterleiste
Schnell einen Dienst finden, wenn die Liste wächst. Per Strg+K oder Strg+F.

### 8. History / Favoriten ✅
- Zuletzt abgespielte Inhalte (Titel, Dienst, Datum/Uhrzeit) in `history.json`
- Uhr-Icon in Overlay-Bar → mittiges Overlay

## 🛠 Technisch

### 9. TypeScript-Migration
Typensicherheit für electronAPI, IPC-Channel, Provider-Konfiguration.

### 10. Logger-System
Strukturierte Logs (info/warn/error) mit Timestamps.

### 11. Unit-Tests (Vitest)
Anti-Detection-Logik und Widevine-Parsing testen.
