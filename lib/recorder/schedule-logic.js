// Reine Planungslogik (Etappe 2a; Konzept §3.3/§3.4): ISO-Zeiten mit Offset,
// effektive Aufnahmefenster (Mittelpunkt-Regel), Überlappungs-Sweep gegen das
// Parallel-Limit und das Zusammenlegen direkt aufeinanderfolgender Sendungen.
//
// Keine I/O-, Electron- oder Uhr-Abhängigkeit: alle Zeiten sind Millisekunden
// seit Epoch, "jetzt" wird von außen hereingereicht. Dadurch deterministisch
// testbar (auch Sommerzeitwechsel: ISO-Strings tragen ihren Offset, verglichen
// wird ausschließlich in ms).
//
// ── Semantik, verbindlich (Konzept §3.4) ──
//
// Aufnahmefenster eines Eintrags E:  [epgStart − bufferBefore, epgStop + bufferAfter)
//   (halboffen: zwei Fenster, die sich nur an der Kante berühren, überlappen nicht).
//
// Mittelpunkt-Regel (gleicher Kanal, direkt hintereinander): Sind A und B vom
//   selben Kanal und überlappen sich ihre Fenster (Nachlauf A reicht über den
//   Vorlauf-Beginn von B hinaus), würde der Duplikat-Schutz der Engine den Start
//   von B blockieren. Deshalb wird die Grenze auf den Mittelpunkt der
//   Überlappungszone gelegt:
//        mid = (startFensterB + endeFensterA) / 2
//   geklemmt auf [epgStop(A), epgStart(B)] (Sendungsinhalt wird nie
//   abgeschnitten), auf ganze Sekunden abgerundet. A endet bei mid (Nachlauf
//   gekürzt), B beginnt bei mid (Vorlauf gekürzt) — lückenlos, ohne Überlappung.
//   Die Kürzung ist ABGELEITET (effectiveWindows), nicht in die Einträge
//   geschrieben: Absagen von B stellt den vollen Nachlauf von A wieder her.
//   Läuft A bereits (laufender Job mit bekanntem stopAt), kann dessen Ende nicht
//   mehr geändert werden; dann beginnt B frühestens bei A.stopAt.
//
// Alternative "eine durchgehende Aufnahme" (mergeEntries): A und B werden zu
//   EINEM Eintrag mit Start von A und Stopp von B (Titel "A + B"); das Fenster
//   nutzt Vorlauf von A und Nachlauf von B. Im Dialog wird das Ergebnis vorab
//   gezeigt (describeAdjacency).
//
// Konflikt-Sweep: Zähle für jeden Zeitpunkt im Fenster des Kandidaten, wie viele
//   Fenster (andere geplante Einträge, laufende Aufnahmen, der Kandidat selbst)
//   gleichzeitig aktiv sind. Mehr als maxParallel → Überschreitung. Laufende
//   Aufnahmen: Ende = stopAt, ohne bekanntes Ende "offen" (bis Ende des
//   Prüffensters, also des Kandidaten-Fensters).

'use strict';

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strikt: nur ISO-8601 mit Zeitzonen-Offset (Z oder ±hh:mm). Gibt ms seit
 * Epoch oder NaN zurück. Nicht existierende Daten (z. B. 31.02.) → NaN.
 */
function parseIsoWithOffset(value) {
  if (typeof value !== 'string' || value.length > 40) return NaN;
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return NaN;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return NaN;
  let offsetMin = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 14 || om > 59) return NaN;
    offsetMin = sign * (oh * 60 + om);
  }
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60000;
}

/** ms → ISO-String mit Offset (Default UTC "Z"), Sekundenauflösung. */
function formatIsoWithOffset(ms, offsetMin = 0) {
  if (!Number.isFinite(ms)) throw new Error('Ungültiger Zeitpunkt');
  const shifted = new Date(ms + offsetMin * 60000);
  const pad = n => String(n).padStart(2, '0');
  const base =
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  if (offsetMin === 0) return `${base}Z`;
  const abs = Math.abs(offsetMin);
  return `${base}${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function sameChannel(a, b) {
  if (a.channelId && b.channelId) return a.channelId === b.channelId;
  if (a.channelName && b.channelName) return a.channelName === b.channelName;
  return false;
}

function entryTimes(entry) {
  const epgStartMs = parseIsoWithOffset(entry.epgStart);
  const epgStopMs = parseIsoWithOffset(entry.epgStop);
  return { epgStartMs, epgStopMs };
}

/**
 * Effektive Aufnahmefenster aller Einträge (Mittelpunkt-Regel angewandt).
 * entries: Einträge mit {id, channelId, channelName, epgStart, epgStop,
 * bufferBeforeSec, bufferAfterSec}. running: laufende Aufnahmen
 * [{channelId, channelName, stopAt|null}] — für B nach laufendem A.
 * Rückgabe: Map id → { startMs, endMs, epgStartMs, epgStopMs }.
 */
function effectiveWindows(entries, running = []) {
  const result = new Map();
  const items = [];
  for (const entry of entries) {
    const { epgStartMs, epgStopMs } = entryTimes(entry);
    if (!Number.isFinite(epgStartMs) || !Number.isFinite(epgStopMs)) continue;
    const item = {
      entry,
      epgStartMs,
      epgStopMs,
      startMs: epgStartMs - Math.max(0, entry.bufferBeforeSec || 0) * 1000,
      endMs: epgStopMs + Math.max(0, entry.bufferAfterSec || 0) * 1000,
    };
    items.push(item);
  }
  // Pro Kanal nach Start sortiert, benachbarte Paare angleichen
  const sorted = [...items].sort((a, b) => a.epgStartMs - b.epgStartMs || a.epgStopMs - b.epgStopMs);
  for (let i = 0; i < sorted.length; i += 1) {
    const b = sorted[i];
    // Vorgänger: letzter Eintrag desselben Kanals davor
    let a = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (sameChannel(sorted[j].entry, b.entry)) {
        a = sorted[j];
        break;
      }
    }
    if (a && a.endMs > b.startMs) {
      const lo = Math.min(a.epgStopMs, b.epgStartMs);
      const hi = Math.max(a.epgStopMs, b.epgStartMs);
      let mid = Math.floor((b.startMs + a.endMs) / 2);
      mid = Math.floor(Math.min(hi, Math.max(lo, mid)) / 1000) * 1000;
      a.endMs = Math.min(a.endMs, mid);
      b.startMs = Math.max(b.startMs, mid);
    }
    // Laufende Aufnahme desselben Kanals: B beginnt frühestens bei deren stopAt
    for (const job of running) {
      if (!sameChannel(job, b.entry)) continue;
      if (Number.isFinite(job.stopAt) && job.stopAt > b.startMs && job.stopAt <= b.epgStartMs) {
        b.startMs = job.stopAt;
      }
    }
  }
  for (const item of items) {
    result.set(item.entry.id, {
      startMs: item.startMs,
      endMs: Math.max(item.endMs, item.startMs),
      epgStartMs: item.epgStartMs,
      epgStopMs: item.epgStopMs,
    });
  }
  return result;
}

/**
 * Überlappungs-Sweep (halboffene Intervalle). intervals: [{id, startMs, endMs,
 * label?}]. Prüft nur das Fenster [fromMs, toMs). Rückgabe:
 * { maxConcurrent, firstOverloadAtMs|null, overlapping: [ids bei der Spitze] }.
 */
function sweepOverlap(intervals, fromMs, toMs, limit) {
  const events = [];
  for (const iv of intervals) {
    const s = Math.max(iv.startMs, fromMs);
    const e = Math.min(iv.endMs, toMs);
    if (!(e > s)) continue;
    events.push({ t: s, d: 1, id: iv.id });
    events.push({ t: e, d: -1, id: iv.id });
  }
  // Enden vor Starts bei gleichem Zeitpunkt (halboffen)
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  const active = new Set();
  let maxConcurrent = 0;
  let firstOverloadAtMs = null;
  let peakIds = [];
  for (const ev of events) {
    if (ev.d === 1) active.add(ev.id);
    else active.delete(ev.id);
    if (active.size > maxConcurrent) {
      maxConcurrent = active.size;
      peakIds = [...active];
    }
    if (active.size > limit && firstOverloadAtMs === null) {
      firstOverloadAtMs = ev.t;
      peakIds = [...active];
    }
  }
  return { maxConcurrent, firstOverloadAtMs, overlapping: peakIds };
}

/**
 * Konfliktprüfung beim Anlegen/Ändern. candidate: Eintrag (id darf fehlen →
 * '__candidate__'), entries: bestehende Einträge (nur state 'scheduled' zählt;
 * 'recording'-Einträge sind über `running` repräsentiert), running: laufende
 * Aufnahmen [{id, channelId, channelName, startedAtMs, stopAt|null}].
 * excludeId: ein bestehender Eintrag, der ersetzt wird (Update).
 */
function findConflicts({ candidate, entries = [], running = [], maxParallel, excludeId = null }) {
  const cand = { ...candidate, id: candidate.id || '__candidate__' };
  const planned = entries.filter(e => e.state === 'scheduled' && e.id !== excludeId && e.id !== cand.id);
  const windows = effectiveWindows([...planned, cand], running);
  const candWin = windows.get(cand.id);
  if (!candWin) return { exceeds: false, maxConcurrent: 0, limit: maxParallel, firstOverloadAtMs: null, overlapping: [] };
  const intervals = [];
  const labels = new Map();
  for (const e of planned) {
    const w = windows.get(e.id);
    if (!w) continue;
    intervals.push({ id: e.id, startMs: w.startMs, endMs: w.endMs });
    labels.set(e.id, `${e.channelName || e.channelId} — ${e.title}`);
  }
  running.forEach((job, idx) => {
    const id = `run:${job.id || idx}`;
    intervals.push({
      id,
      startMs: Number.isFinite(job.startedAtMs) ? job.startedAtMs : -Infinity,
      endMs: Number.isFinite(job.stopAt) ? job.stopAt : Infinity,
    });
    labels.set(id, `${job.channelName || job.channelId} (läuft)`);
  });
  intervals.push({ id: cand.id, startMs: candWin.startMs, endMs: candWin.endMs });
  labels.set(cand.id, `${cand.channelName || cand.channelId} — ${cand.title}`);
  const sweep = sweepOverlap(intervals, candWin.startMs, candWin.endMs, maxParallel);
  return {
    exceeds: sweep.firstOverloadAtMs !== null,
    maxConcurrent: sweep.maxConcurrent,
    limit: maxParallel,
    firstOverloadAtMs: sweep.firstOverloadAtMs,
    overlapping: sweep.overlapping.filter(id => id !== cand.id).map(id => ({ id, label: labels.get(id) || id })),
  };
}

/**
 * Direkt benachbarter Eintrag desselben Kanals, dessen Fenster sich mit dem des
 * Kandidaten überlappen (Mittelpunkt-Regel greift) — für die Dialog-Anzeige.
 * Rückgabe null oder { entry, position:'before'|'after', gapSec, midpointMs,
 * midpointIso, otherAfterSec/otherBeforeSec..., merged: {…} }.
 */
function describeAdjacency({ candidate, entries = [], mergeLimitSec = 15 * 60 }) {
  const cand = { ...candidate, id: candidate.id || '__candidate__' };
  const { epgStartMs: cs, epgStopMs: ce } = entryTimes(cand);
  if (!Number.isFinite(cs) || !Number.isFinite(ce)) return null;
  let best = null;
  for (const other of entries) {
    if (other.state !== 'scheduled' || other.id === cand.id || !sameChannel(other, cand)) continue;
    const { epgStartMs: os, epgStopMs: oe } = entryTimes(other);
    if (!Number.isFinite(os) || !Number.isFinite(oe)) continue;
    let first;
    let second;
    let position;
    if (oe <= cs) {
      first = other;
      second = cand;
      position = 'before';
    } else if (ce <= os) {
      first = cand;
      second = other;
      position = 'after';
    } else {
      continue; // Sendungen überlappen selbst: keine "direkt hintereinander"-Nachbarschaft
    }
    const win = effectiveWindows([first, second]);
    const raw = {
      aEnd: parseIsoWithOffset(first.epgStop) + Math.max(0, first.bufferAfterSec || 0) * 1000,
      bStart: parseIsoWithOffset(second.epgStart) - Math.max(0, second.bufferBeforeSec || 0) * 1000,
    };
    if (raw.aEnd <= raw.bStart) continue; // Puffer überlappen nicht
    const wa = win.get(first.id);
    const wb = win.get(second.id);
    const gapSec = Math.round((wb.epgStartMs - wa.epgStopMs) / 1000);
    if (!best || gapSec < best.gapSec) {
      best = {
        entry: other,
        position,
        gapSec,
        midpointMs: wb.startMs,
        midpointIso: formatIsoWithOffset(wb.startMs),
        firstAfterSec: Math.round((wa.endMs - wa.epgStopMs) / 1000),
        secondBeforeSec: Math.round((wb.epgStartMs - wb.startMs) / 1000),
        canMerge: gapSec <= mergeLimitSec,
        merged: gapSec <= mergeLimitSec ? mergePreview(first, second) : null,
      };
    }
  }
  return best;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function mergePreview(first, second) {
  return {
    title: truncate(`${first.title} + ${second.title}`, 300),
    epgStart: first.epgStart,
    epgStop: second.epgStop,
    bufferBeforeSec: first.bufferBeforeSec,
    bufferAfterSec: second.bufferAfterSec,
  };
}

/**
 * Legt zwei direkt aufeinanderfolgende Sendungen desselben Kanals zu einer
 * durchgehenden Aufnahme zusammen (Start von `first`, Stopp von `second`).
 * Wirft bei ungeeigneten Paaren. Gibt die Felder zurück, die das Ergebnis
 * ausmachen (Beschreibung wird gekürzt zusammengesetzt).
 */
function mergeEntries(first, second, { maxDurationMs = 24 * 3600 * 1000 } = {}) {
  if (!sameChannel(first, second)) throw new Error('Zusammenlegen ist nur für denselben Sender möglich');
  const { epgStartMs: fs, epgStopMs: fe } = entryTimes(first);
  const { epgStartMs: ss, epgStopMs: se } = entryTimes(second);
  if (!(fe <= ss)) throw new Error('Die Sendungen liegen nicht direkt hintereinander');
  if (se - fs > maxDurationMs) throw new Error('Die zusammengelegte Aufnahme wäre länger als 24 Stunden');
  const preview = mergePreview(first, second);
  return {
    ...preview,
    description: truncate([first.description, second.description].filter(Boolean).join('\n\n'), 2000),
  };
}

module.exports = {
  parseIsoWithOffset,
  formatIsoWithOffset,
  sameChannel,
  entryTimes,
  effectiveWindows,
  sweepOverlap,
  findConflicts,
  describeAdjacency,
  mergeEntries,
};
