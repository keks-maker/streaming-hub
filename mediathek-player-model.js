'use strict';

// Wiedergabe-Logik der Mediathek (rein, ohne DOM): Stream-Art, Qualitätsstufe, Tonspur/Untertitel nach Einstellung,
// Startposition und gedrosseltes Speichern des Fortschritts.

const PROGRESS_INTERVAL_MS = 10000;

/** 'hls' für .m3u8-Adressen, sonst 'mp4' (progressiver Download). */
function streamKind(url) {
  try {
    return /\.m3u8$/i.test(new URL(String(url)).pathname) ? 'hls' : 'mp4';
  } catch {
    return 'mp4';
  }
}

/** Nur https-Adressen werden abgespielt (CSP und Quellen liefern https). */
function isPlayableUrl(url) {
  try {
    return new URL(String(url)).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Index der Qualitätsstufe nach Einstellung ("auto" -> -1 = hls.js entscheidet): höchste Stufe bis zur gewünschten Höhe,
 * sonst die niedrigste vorhandene.
 */
function pickLevel(levels, quality) {
  const target = Number(quality);
  if (!Array.isArray(levels) || !levels.length || !Number.isFinite(target)) return -1;
  let best = -1;
  let lowest = -1;
  levels.forEach((level, index) => {
    const height = Number(level && level.height) || 0;
    if (lowest < 0 || height < (Number(levels[lowest].height) || 0)) lowest = index;
    if (height <= target && (best < 0 || height > (Number(levels[best].height) || 0))) best = index;
  });
  return best >= 0 ? best : lowest;
}

const lang = track => String((track && track.lang) || '').toLowerCase().split('-')[0];
const label = track => String((track && track.name) || '').toLowerCase();
const looksOriginal = track => /original|\bov\b|\bvo\b|\bomu\b/.test(label(track));
const looksSpecial = track => /audiodeskription|hörfilm|hörgeschädigt|gebärden|forced|\bad\b/i.test(label(track));

/**
 * Tonspur nach Sprachwunsch ('de' | 'original'); Audiodeskription wird nicht gewählt. Ergebnis: Index in tracks oder -1
 * (Standard des Streams bleibt).
 */
function pickAudioTrack(tracks, preference) {
  if (!Array.isArray(tracks) || tracks.length < 2) return -1;
  const normal = tracks.map((track, index) => ({ track, index })).filter(item => !looksSpecial(item.track));
  const hit =
    preference === 'original'
      ? normal.find(item => looksOriginal(item.track)) || normal.find(item => lang(item.track) !== 'de' && lang(item.track) !== '')
      : normal.find(item => lang(item.track) === 'de' && !looksOriginal(item.track));
  return hit ? hit.index : -1;
}

/** Untertitelspur nach Einstellung ('off' | 'de' | 'original'); -1 = keine. */
function pickSubtitleTrack(tracks, preference, audioLang = '') {
  if (!Array.isArray(tracks) || preference === 'off') return -1;
  const usable = tracks.map((track, index) => ({ track, index })).filter(item => !/forced/i.test(label(item.track)));
  if (preference === 'de') {
    const hit = usable.find(item => lang(item.track) === 'de' && !/hörgeschädigt|sdh/i.test(label(item.track))) || usable.find(item => lang(item.track) === 'de');
    return hit ? hit.index : -1;
  }
  const original = usable.find(item => looksOriginal(item.track)) || usable.find(item => lang(item.track) && lang(item.track) !== 'de' && lang(item.track) !== audioLang);
  return original ? original.index : -1;
}

/** Anzeigename einer Spur für das Menü. */
function trackLabel(track, index) {
  const name = track && track.name ? String(track.name) : '';
  const code = track && track.lang ? String(track.lang) : '';
  return name || code || `Spur ${index + 1}`;
}

/** Startposition in Sekunden aus dem Ergebnis von resolve-playback (kein Rücksprung auf 0 nötig). */
function startPosition(result) {
  const value = result && result.startPosition;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Speichert den Fortschritt höchstens alle `intervalMs`; flush() schreibt sofort (Pause, Ende, Schließen).
 * save({ position, duration }) -> Promise|void.
 */
function createProgressSaver({ save, intervalMs = PROGRESS_INTERVAL_MS, now = () => Date.now() }) {
  let lastSave = -Infinity;
  let latest = null;
  const write = () => {
    if (!latest) return;
    lastSave = now();
    const payload = latest;
    latest = null;
    try {
      const done = save(payload);
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch {
      /* Fortschritt ist nicht kritisch */
    }
  };
  return {
    tick(position, duration) {
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
      latest = { position: Math.min(position, duration), duration };
      if (now() - lastSave >= intervalMs) write();
    },
    flush: write,
  };
}

module.exports = { PROGRESS_INTERVAL_MS, streamKind, isPlayableUrl, pickLevel, pickAudioTrack, pickSubtitleTrack, trackLabel, startPosition, createProgressSaver };
