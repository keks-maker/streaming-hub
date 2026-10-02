// Fix-Set 9 (Karte t_0fa7efdf, User-Befund B): DVR-Seek-Planung für
// „Ab Bildposition starten" / „Aktuell angezeigte Sendung aufnehmen".
//
// Problem (User-Test 02.10., ARD 2-h-Fenster, 60-min-Rückstand): ffmpeg
// `-ss <offset>` VOR `-i` auf einer LIVE-Playlist scheiterte mit
// „could not seek to position" — der HLS-Demuxer startet am Live-Edge
// (Default live_start_index -3) und kann von dort NICHT zurückseeken,
// obwohl die angeforderte Position nachweislich im DVR-Fenster liegt
// (der Player zeigt sie in der Scrubbar an!).
//
// Lösung: die Quelle-Playlist wird VOR dem Spawn gelesen und die
// Startposition wird SEGMENTGENAU als ffmpeg-Argumente übersetzt:
//   -live_start_index <k-m>   → Demuxer startet beim Segment k (negativ
//                               = von Ende gezählt; Basis: Sliding-Window)
//   -ss <residual>            → Rest-Sekunden INNERHALB von Segment k
//                               (klein ≤ Segmentdauer → verlässlicher Seek)
//
// ffmpeg liest danach laufend NEUE Segmente der Live-Playlist (kein
// ENDLIST) — die Aufnahme läuft am Live-Edge weiter. Reconnect-Attempts
// (≥ 2) nutzen bewusst NICHT diesen Plan (Sliding-Window-Naht, siehe
// RecordJob-Kopfkommentar), sondern das Bestandsverhalten.
//
// Reine Funktion (kein I/O, kein Electron) — deterministisch testbar.

'use strict';

/**
 * Parst eine HLS-Media-Playlist und berechnet den ffmpeg-Seek-Plan für
 * einen DVR-Rückstand von offsetSec Sekunden (gemessen ab Live-Edge =
 * Ende des letzten Segments).
 *
 * @param {string} playlistText - Rohtext der Media-Playlist (#EXTM3U).
 * @param {number} offsetSec - DVR-Rückstand in Sekunden (> 0).
 * @returns {null | {
 *   mode: 'segments',
 *   liveStartIndex: number,   // negativ, ffmpeg live_start_index (k - m)
 *   segmentIndex: number,     // absolute Segment-Nummer k
 *   residualSec: number,      // Seek innerhalb von Segment k (≥ 0, ≤ SegDauer)
 *   withinWindow: boolean,    // offset ≤ Fenster-Tiefe
 *   windowDepthSec: number,   // Summe aller Segment-Dauern
 * }} null, wenn die Playlist nicht auswertbar ist (Master-Playlist,
 *         keine Segmente, ungültige Dauern) → Aufrufer fällt auf den
 *         Legacy-`-ss`-Pfad zurück.
 */
/**
 * Fix-Set 10 (Karte t_28a3bff2): Liest aus einer MASTER-Playlist die URL der
 * ERSTEN Video-Variant-Playlist (die Zeile direkt nach #EXT-X-STREAM-INF —
 * identisch zu ffmpegs eigener Variant-Auswahl). #EXT-X-I-FRAME-STREAM-INF
 * wird NICHT als Variante behandelt. Rückgabe: absolute URL oder null.
 */
function firstVariantUrl(masterText, baseUrl) {
  if (typeof masterText !== 'string' || !masterText.includes('#EXTM3U')) return null;
  // /^#EXT-X-STREAM-INF/ matcht nicht #EXT-X-I-FRAME-STREAM-INF — bewusst
  // zeilenbasiert (kein Freitext-Regex), damit I-Frame-Playlists nie als
  // Video-Variante landen.
  const lines = masterText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const tag = lines[i].trim();
    if (!/^#EXT-X-STREAM-INF/.test(tag)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith('#')) continue;
      try {
        return new URL(line, baseUrl).href;
      } catch (_) {
        return null;
      }
    }
    return null; // STREAM-INF ohne folgende URI → malformed
  }
  return null;
}

function computeDvrSeek(playlistText, offsetSec) {
  if (typeof playlistText !== 'string' || !playlistText.includes('#EXTM3U')) return null;
  if (!Number.isFinite(offsetSec) || offsetSec <= 0) return null;

  // Master-Playlist (#EXT-X-STREAM-INF) → nicht segmentgenau auswertbar
  if (/#EXT-X-STREAM-INF/.test(playlistText)) return null;

  const lines = playlistText.split('\n');
  const durations = []; // EXTINF-Dauer je Segment (Sekunden)
  let pendingDuration = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:\s*([0-9.]+)/.exec(line);
      pendingDuration = m ? parseFloat(m[1]) : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    // erste Nicht-Kommentarzeile nach EXTINF = Segment-URI
    durations.push(Number.isFinite(pendingDuration) && pendingDuration >= 0 ? pendingDuration : 0);
    pendingDuration = null;
  }

  const m = durations.length;
  if (m === 0) return null;

  const windowDepthSec = durations.reduce((a, b) => a + b, 0);
  if (!(windowDepthSec > 0)) return null;

  // offset ab Live-Edge zurückrechnen: Zielpunkt = windowDepth - offset
  // (in der EXTINF-Kumulierung, Segment 0 = frühestes Fenster-Segment).
  const withinWindow = offsetSec <= windowDepthSec + 1e-6;
  // Ziel auch bei knapp über dem Fenster auf das früheste Segment klemmen —
  // der eigentliche Out-of-Window-Gate läuft im Dialog (tv.html); hier wird
  // nur der frühestmögliche Start gebaut (graceful, kein ffmpeg-Abriss).
  let target = windowDepthSec - offsetSec;
  if (target < 0) target = 0;

  // Erstes Segment, dessen Ende ≥ target: kumuliert bis k (exklusiv) < target.
  let k = 0;
  let acc = 0;
  while (k < m && acc + durations[k] <= target) {
    acc += durations[k];
    k += 1;
  }
  // k == m kann bei Floating-Rest nicht passieren (target < windowDepth),
  // defensiv: auf das letzte Segment klemmen.
  if (k >= m) k = m - 1;

  const residualSec = Math.max(0, Math.min(target - acc, durations[k]));

  return {
    mode: 'segments',
    liveStartIndex: k - m, // negativ = von der Live-Edge rückwärts
    segmentIndex: k,
    residualSec: Math.round(residualSec * 1000) / 1000,
    withinWindow,
    windowDepthSec: Math.round(windowDepthSec * 1000) / 1000,
  };
}

/**
 * Baut die ffmpeg-Argumente für den Seek-Plan (Fix-Set 9). Liefert das
 * Präfix VOR `-i`:
 *   - segments-Modus: [-live_start_index, k-m, (-ss, residual)] — `-ss`
 *     entfällt bei residualem Rest ≤ 0.2 s (Segmentgrenze ≙ Zielpunkt).
 *   - null/kein Plan → Legacy: [-ss, offset] (Aufrufer).
 *
 * @param {object|null} plan - Ergebnis von computeDvrSeek().
 * @param {number} fallbackOffsetSec - Legacy-Offset (Karte t_f36663be).
 * @returns {string[]}
 */
function dvrSeekArgs(plan, fallbackOffsetSec) {
  if (plan && plan.mode === 'segments') {
    const args = ['-live_start_index', String(plan.liveStartIndex)];
    if (plan.residualSec > 0.2) args.push('-ss', String(plan.residualSec));
    return args;
  }
  return Number.isFinite(fallbackOffsetSec) && fallbackOffsetSec > 0
    ? ['-ss', String(fallbackOffsetSec)]
    : [];
}

module.exports = { computeDvrSeek, dvrSeekArgs, firstVariantUrl };
