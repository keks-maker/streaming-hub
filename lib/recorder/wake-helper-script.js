// Wake-Helfer: /bin/sh-Skript, das per `osascript … with administrator privileges`
// INLINE (als Argument von `sh -c`) als root gestartet wird. Es liegt nie in
// einer vom Nutzer beschreibbaren Datei. Konzept §4.3.
//
// Positionsargumente: UID PID TOKEN PMSET BASE
//   UID    numerische Nutzer-UID (nur diese UID darf Aufträge senden)
//   PID    PID der App; endet sie, beendet sich der Helfer (Wächter, alle 2 s)
//   TOKEN  32 Hex-Zeichen (Zufall der App) — Teil des Verzeichnisnamens
//   PMSET  Pfad von pmset (/usr/bin/pmset; in Tests ein Mock)
//   BASE   Elternverzeichnis (/var/run; in Tests ein Temp-Verzeichnis)
//
// Kanal: BASE/streaminghub-wake-UID-TOKEN/ (root:wheel 0711, von root per
// mkdir angelegt — schlägt fehl, wenn der Name schon existiert) mit der FIFO
// `cmd` (UID:0600). Der Nutzer kann im root-eigenen Verzeichnis nichts
// ersetzen oder verlinken.
//
// Aufträge (je eine Zeile, max. 40 Zeichen), alles andere wird verworfen:
//   wake MM/dd/yy HH:mm:ss     → pmset schedule wake "…" StreamingHub
//   cancel MM/dd/yy HH:mm:ss   → pmset schedule cancel wake "…" StreamingHub
//   quit                       → aufräumen und beenden
// Eingaben werden nur gegen feste Muster geprüft und nie in eine Shell
// eingesetzt (Argumentliste, kein eval). Der Skripttext liegt in wake-helper.sh.

'use strict';

const fs = require('fs');
const path = require('path');

// Der Skripttext wird beim Laden gelesen und als Argument von `sh -c` übergeben
// (Inline-Ausführung; nie als Datei-Pfad unter root).
const HELPER_SCRIPT = fs.readFileSync(path.join(__dirname, 'wake-helper.sh'), 'utf8');

module.exports = { HELPER_SCRIPT };
