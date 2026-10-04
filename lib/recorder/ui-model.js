// v0.5.9 – UI-Modell der Aufnahme (Phase 1c, Karte t_bafa7928)
//
// Reine Hilfsfunktionen der Aufnahme-UI, die der Renderer (index.html-Screens)
// und tv.html-Host-Logik gemeinsam nutzen. Kein Electron-Zugriff, kein I/O —
// dadurch unit-testbar ohne Mocks (Konzept §4: testbare Kernlogik).
//
// Enthalten:
// - formatDuration: Sekunden → „H:MM:SS“ / „MM:SS“ (Bibliothek, Chip, Tray)
// - currentEpgStopMs: Ende der laufenden Sendung aus den Roh-EPG-Einträgen
//   (XMLTV-Zeitstrings via typed-core parseEpgTime-Format) → Auto-Stopp
//   „Bis zum Ende der Sendung“ (Konzept §3.1)
// - isProbablyNetworkPath: Heuristik für die Netzwerkpfad-Warnung in den
//   Settings (Konzept §3.4: NAS/SMB/NFS erlaubt, aber mit Hinweis)

'use strict';

/**
 * Sekunden → „H:MM:SS“ (≥ 1 h) oder „MM:SS“. Nicht-endliche/negative Werte
 * werden zu „00:00“ normalisiert.
 */
function formatDuration(totalSec) {
  const sec = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Parst XMLTV-Zeitstrings wie „20260930123000 +0200“ (gleiche Formate wie
 * typed-core parseEpgTime, hier lokal, damit ui-model ohne typed-core-Dep
 * im Node-Test lädt). Rückgabe: ms oder NaN bei ungültigem Format.
 */
function parseEpgTimeMs(timeStr) {
  if (typeof timeStr !== 'string') return NaN;
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})/.exec(timeStr.trim());
  if (m) {
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const sign = m[7].startsWith('-') ? -1 : 1; // Vorzeichen gilt auch für die Minuten
    const tzOffset = sign * (Math.abs(+m[7]) * 60 + +m[8]);
    return utc - tzOffset * 60000;
  }
  m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(timeStr.trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * Ende (ms) der aktuell laufenden Sendung aus den Roh-EPG-Einträgen.
 * entries: [{start, stop, title?}] mit XMLTV-Zeitstrings.
 * nowMs: Referenzzeit (Default Date.now(), injizierbar für Tests).
 * Rückgabe: ms des Sendungsendes oder null (kein EPG / keine laufende Sendung).
 */
function currentEpgStopMs(entries, nowMs = Date.now()) {
  if (!Array.isArray(entries)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const startMs = parseEpgTimeMs(e.start);
    const stopMs = parseEpgTimeMs(e.stop);
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) continue;
    if (startMs <= now && stopMs > now) return stopMs;
  }
  return null;
}

/**
 * Heuristik: sieht der Pfad nach einem Netzwerkpfad aus (UNC, SMB/NFS-Mount,
 * NAS-Mountpunkt)? Für die Settings-Warnung (Konzept §3.4) — kein hartes
 * Gate, nur Hinweis-Trigger. Bestehende Mountpoints unter /mnt, /media und
 * /Volumes gelten als potenziell netzwerkgebunden.
 */
function isProbablyNetworkPath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (/^\\\\/.test(p)) return true; // Windows-UNC
  if (/^smb:|^nfs:|^afp:|^cifs:/i.test(p)) return true; // URI-Formen
  // POSIX-Mountpunkte, die typischerweise Netzwerk-Filesysteme tragen
  if (/^\/(mnt|media|Volumes)\//.test(p)) return true;
  return false;
}

module.exports = {
  formatDuration,
  parseEpgTimeMs,
  currentEpgStopMs,
  isProbablyNetworkPath,
};
