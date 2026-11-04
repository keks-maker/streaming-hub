// Live-TV-Player (tv.html): Modell der EPG-Leiste. Reine Funktionen ohne DOM und IPC.
// Im DVR-Modus zeigt die Leiste die Sendung an der WIEDERGABEZEIT (nicht an der Uhrzeit); die Aufnahme
// „Aktuell angezeigte Sendung“ folgt derselben Sendung. Ohne DVR bleibt alles bei der Uhrzeit.
//
// tv.html läuft ohne Node-Integration und lädt dieses Modul per <script> (Global TvEpgModel);
// die Tests laden es per require().

/* global module, self */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TvEpgModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NEAR_LIVE_SEC = 5; // wie tvOS TimeshiftNavigation.behindLiveText

  /** XMLTV-Zeitstring ("20260908143000 +0200") → Date; ungültig → Date(0). */
  function parseEpgTime(timeStr) {
    var s = typeof timeStr === 'string' ? timeStr : '';
    var m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})/);
    if (m) {
      var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      var tzOffset = (+m[7]) * 60 + (+m[8]);
      return new Date(utc - tzOffset * 60000);
    }
    var m2 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m2) return new Date(0);
    return new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5], +m2[6]));
  }

  /**
   * Bezugszeit der Leiste. DVR an + PDT-Anker + EPG-Einträge → Wanduhrzeit der Wiedergabeposition
   * (im DVR-Modus immer, auch nahe der Kante: keine Schwelle). Sonst die Uhrzeit.
   * anchor = { mediaSec, wallSec } (PROGRAM-DATE-TIME-Zuordnung), currentTime in Mediensekunden.
   * Rückgabe: { ms, playback } — playback=true, wenn die Wiedergabezeit gilt.
   */
  function referenceTime(opts) {
    var o = opts || {};
    var nowMs = isFinite(o.nowMs) ? o.nowMs : Date.now();
    var anchor = o.anchor;
    var usable = !!o.dvrEnabled && !!anchor && isFinite(anchor.mediaSec) && isFinite(anchor.wallSec) &&
      isFinite(o.currentTime) && o.entryCount > 0;
    if (!usable) return { ms: nowMs, playback: false };
    var ms = (anchor.wallSec + (o.currentTime - anchor.mediaSec)) * 1000;
    return isFinite(ms) ? { ms: ms, playback: true } : { ms: nowMs, playback: false };
  }

  function normalizeEntries(entries) {
    var out = [];
    if (!Array.isArray(entries)) return out;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e) continue;
      var startMs = parseEpgTime(e.start).getTime();
      var stopMs = parseEpgTime(e.stop).getTime();
      if (!startMs || !stopMs || stopMs <= startMs) continue;
      out.push({ startMs: startMs, stopMs: stopMs, title: typeof e.title === 'string' ? e.title : '' });
    }
    return out;
  }

  /**
   * Sendung an refMs und „Danach“ (früheste Sendung, die nach refMs beginnt).
   * Überlappen Einträge, gilt der mit dem spätesten Start. { current, next } mit null für „nicht vorhanden“.
   */
  function findShowAt(entries, refMs) {
    var list = normalizeEntries(entries);
    var current = null;
    var next = null;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.startMs <= refMs && s.stopMs > refMs) {
        if (!current || s.startMs > current.startMs) current = s;
      } else if (s.startMs > refMs) {
        if (!next || s.startMs < next.startMs) next = s;
      }
    }
    return { current: current, next: next };
  }

  /** Fortschritt 0..1 der Sendung zur Bezugszeit. */
  function showProgress(show, refMs) {
    if (!show) return 0;
    var total = show.stopMs - show.startMs;
    if (!(total > 0)) return 0;
    return Math.min(1, Math.max(0, (refMs - show.startMs) / total));
  }

  /** Zeitversatz auf 10 s gerundet ("-12:30", "-1:02:10"); null nahe der Live-Kante. */
  function formatBehindLive(seconds) {
    if (!isFinite(seconds) || seconds <= NEAR_LIVE_SEC) return null;
    var total = Math.round(seconds / 10) * 10;
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? '-' + h + ':' + pad(m) + ':' + pad(s) : '-' + m + ':' + pad(s);
  }

  function formatClock(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  var NO_PROGRAM_TEXT = 'Keine Programminformation';

  /**
   * Anzeige der Leiste im DVR-Modus.
   * opts: { entries, refMs, behindSec, isLive }.
   * behindText nur, wenn nicht isLive. Lücke an der Wiedergabeposition → noInfo (Leiste bleibt sichtbar).
   */
  function describeBar(opts) {
    var o = opts || {};
    var found = findShowAt(o.entries, o.refMs);
    var cur = found.current;
    var nxt = found.next;
    return {
      noInfo: !cur,
      startText: cur ? formatClock(cur.startMs) : '',
      endText: cur ? formatClock(cur.stopMs) : '',
      title: cur ? cur.title : NO_PROGRAM_TEXT,
      nextText: nxt ? 'Danach ' + formatClock(nxt.startMs) + ' ' + nxt.title : '',
      progress: cur ? showProgress(cur, o.refMs) : null,
      behindText: o.isLive ? null : formatBehindLive(o.behindSec),
    };
  }

  /** Tooltip der Scrub-Leiste an der Mausposition: "HH:MM · Titel" bzw. "HH:MM · Keine Programminformation". */
  function hoverText(entries, wallMs) {
    if (!isFinite(wallMs)) return '';
    var cur = findShowAt(entries, wallMs).current;
    return formatClock(wallMs) + ' · ' + (cur ? cur.title : NO_PROGRAM_TEXT);
  }

  return {
    parseEpgTime: parseEpgTime,
    referenceTime: referenceTime,
    findShowAt: findShowAt,
    showProgress: showProgress,
    formatBehindLive: formatBehindLive,
    formatClock: formatClock,
    describeBar: describeBar,
    hoverText: hoverText,
    NO_PROGRAM_TEXT: NO_PROGRAM_TEXT,
  };
});
