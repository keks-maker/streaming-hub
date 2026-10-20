'use strict';

// Dialog „Download-Optionen“ (rein, ohne DOM): Vorbelegung aus den Einstellungen, wählbare Werte aus dem Plan der Quelle
// (downloads:plan), Vorschau (geschätzte Größe, freier Platz, Warnungen) und Entscheidung, ob der Dialog übersprungen wird.

const { formatBytes, formatDateTime } = require('./mediathek-downloads-model.js');

const HEIGHT_LABELS = { best: 'Beste verfügbare', 1080: 'Bis 1080p (Full HD)', 720: 'Bis 720p (HD)', 540: 'Bis 540p (sparsam)', 360: 'Bis 360p (sehr sparsam)' };
const CONTAINER_LABELS = { mp4: 'MP4 (empfohlen)', mkv: 'MKV' };
const AUDIO_MODE_LABELS = { preferred: 'Nur bevorzugte Sprache', all: 'Alle Tonspuren' };
const AUDIO_DESCRIPTION_LABELS = { never: 'Keine Audiodeskription', additional: 'Zusätzlich als eigene Tonspur', fallback: 'Nur, wenn es keine normale Spur gibt' };
const SUBTITLE_MODE_LABELS = { none: 'Keine', preferred: 'Bevorzugte Sprache', all: 'Alle' };
const SUBTITLE_DELIVERY_LABELS = { embedded: 'In die Datei einbetten', external: 'Als .srt-Datei daneben' };
const LANGUAGE_LABELS = { deu: 'Deutsch', orig: 'Originalsprache', eng: 'Englisch', fra: 'Französisch', ita: 'Italienisch', spa: 'Spanisch', nld: 'Niederländisch', pol: 'Polnisch', tur: 'Türkisch' };

/** Standard im Dialog: höchstens 1080p statt „Beste“ (spart Platz, die Quellen liefern selten mehr). */
const DIALOG_DEFAULT_HEIGHT = '1080';

const OVERRIDE_FIELDS = ['maxHeight', 'container', 'audioMode', 'audioLanguages', 'audioDescription', 'subtitleMode', 'subtitleLanguage', 'subtitleDelivery'];

/** Vorbelegung des Dialogs aus den Download-Einstellungen. */
function initialOverrides(settings) {
  const s = settings || {};
  const result = {};
  for (const field of OVERRIDE_FIELDS) if (s[field] !== undefined) result[field] = Array.isArray(s[field]) ? [...s[field]] : s[field];
  if (!result.maxHeight || result.maxHeight === 'best') result.maxHeight = DIALOG_DEFAULT_HEIGHT;
  return result;
}

/** Ein-Klick-Download: Dialog überspringen? Nur mit der Einstellung; Überschreibungen entfallen dann (Einstellungen gelten). */
function shouldSkipDialog(settings) {
  return Boolean(settings && settings.skipOptionsDialog);
}

/** Auswahl der Höchstauflösung: „Beste“ plus die Stufen, die die Quelle anbietet (ohne Angabe alle bekannten). */
function heightChoices(available, current) {
  const known = ['1080', '720', '540', '360'];
  const top = available && Array.isArray(available.heights) && available.heights.length ? Math.max(...available.heights) : null;
  // „Bis X“ nur, wenn die Quelle mindestens so hoch auflöst (sonst wäre es dasselbe wie „Beste“); der aktuelle Wert bleibt wählbar
  const offered = known.filter(h => top === null || Number(h) <= top * 1.1 || h === String(current));
  const values = ['best', ...offered];
  return values.map(value => ({ value, label: HEIGHT_LABELS[value] }));
}

const choicesOf = labels => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** Alle Auswahllisten des Dialogs. */
function choices(available, current = {}) {
  return {
    maxHeight: heightChoices(available, current.maxHeight),
    container: choicesOf(CONTAINER_LABELS),
    audioMode: choicesOf(AUDIO_MODE_LABELS),
    audioDescription: choicesOf(AUDIO_DESCRIPTION_LABELS),
    subtitleMode: choicesOf(SUBTITLE_MODE_LABELS),
    subtitleDelivery: choicesOf(SUBTITLE_DELIVERY_LABELS),
  };
}

/** Kurzliste der Spuren, die die Quelle anbietet (Information unter den Auswahlfeldern). */
function availabilityText(available) {
  const audio = (available && available.audio) || [];
  const subs = (available && available.subtitles) || [];
  const name = track => track.label || LANGUAGE_LABELS[track.language] || track.language || 'Spur';
  return {
    audio: audio.length ? `Tonspuren der Quelle: ${[...new Set(audio.map(name))].join(', ')}` : null,
    subtitles: subs.length ? `Untertitel der Quelle: ${[...new Set(subs.map(name))].join(', ')}` : 'Die Quelle bietet keine Untertitel an.',
    hasAudioDescription: audio.some(track => track.kind === 'audioDescription' || track.kind === 'ad'),
  };
}

/**
 * Vorschau aus dem Ergebnis von downloads:plan.
 * Liefert { kind: 'ready'|'restricted'|'duplicate'|'error', rows: [{label, value}], warnings: [], blocking: string|null, canDownload }.
 */
function previewOf(result) {
  if (!result || result.ok === false) {
    return { kind: 'error', rows: [], warnings: [], blocking: (result && result.message) || 'Die Vorschau ist nicht möglich.', canDownload: false };
  }
  const rows = [];
  const warnings = [];
  const free = formatBytes(result.freeBytes);
  if (result.duplicate) {
    const done = result.duplicate.status === 'done';
    return { kind: 'duplicate', rows, warnings, blocking: done ? 'Diese Folge ist bereits heruntergeladen.' : 'Diese Folge ist bereits in der Warteschlange.', canDownload: false };
  }
  if (result.restricted) {
    const when = result.restriction && formatDateTime(result.restriction.retryAt);
    const text = (result.restriction && result.restriction.message) || 'Die Folge ist altersgesperrt.';
    rows.push({ label: 'Hinweis', value: when ? `${text.replace(/\.$/, '')}. Der Download startet automatisch ab ${when}.` : text });
    if (free) rows.push({ label: 'Freier Platz', value: free });
    return { kind: 'restricted', rows, warnings, blocking: null, canDownload: true };
  }
  const plan = result.plan || {};
  if (plan.video) rows.push({ label: 'Bild', value: [plan.video.label || (plan.video.height ? `${plan.video.height}p` : null), plan.video.codec].filter(Boolean).join(' · ') || 'Standard' });
  if (Array.isArray(plan.audio)) rows.push({ label: 'Ton', value: plan.audio.length ? plan.audio.map(track => track.label || LANGUAGE_LABELS[track.language] || 'Spur').join(', ') : 'Standardspur' });
  if (Array.isArray(plan.subtitles)) rows.push({ label: 'Untertitel', value: plan.subtitles.length ? plan.subtitles.map(track => track.label || LANGUAGE_LABELS[track.language] || 'Spur').join(', ') : 'Keine' });
  const size = formatBytes(plan.estimatedBytes);
  rows.push({ label: 'Geschätzte Größe', value: size ? `ca. ${size}` : 'unbekannt' });
  if (free) rows.push({ label: 'Freier Platz', value: free });
  for (const warning of plan.warnings || []) warnings.push(String(warning));
  if (result.enoughSpace === false) warnings.push('Der freie Platz reicht voraussichtlich nicht (inklusive Reserve). Wähle eine niedrigere Qualität oder einen anderen Speicherort.');
  return { kind: 'ready', rows, warnings, blocking: null, canDownload: true };
}

/** Überschreibungen für downloads:enqueue/plan: nur geänderte oder alle bekannten Felder, leere Sprachlisten entfallen. */
function overridesForRequest(form) {
  const result = {};
  for (const field of OVERRIDE_FIELDS) {
    const value = form[field];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    result[field] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

module.exports = {
  DIALOG_DEFAULT_HEIGHT,
  OVERRIDE_FIELDS,
  LANGUAGE_LABELS,
  initialOverrides,
  shouldSkipDialog,
  heightChoices,
  choices,
  availabilityText,
  previewOf,
  overridesForRequest,
};
