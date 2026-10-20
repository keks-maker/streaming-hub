'use strict';

// Einstellungen ▸ Mediatheken ▸ Downloads (rein, ohne DOM): Felder je Unterseite, Auswahllisten, Sprachfolge, Schema-Vorschau und
// die Hinweise zu Werten, die der Main begrenzt hat (Antwort von downloads:settings-set: clamped).

const { LANGUAGE_LABELS } = require('./mediathek-download-options-model.js');

const NOTICE_TITLE = 'Nutzung der Downloads';
const NOTICE_TEXT = [
  'Die Nutzungsbedingungen der Mediatheken sind auf das Streaming ausgelegt. Heruntergeladene Folgen sind nur für den privaten Gebrauch gedacht.',
  'Du bist selbst dafür verantwortlich, dass du Inhalte rechtmäßig nutzt: Gib Downloads nicht weiter und veröffentliche sie nicht.',
  'Viele Beiträge sind nur zeitlich begrenzt verfügbar. Die Anbieter können Downloads jederzeit einschränken oder sperren.',
];

const labelled = (values, labels) => values.map(value => ({ value, label: labels[value] || value }));

const HEIGHT_LABELS = { best: 'Beste verfügbare', 1080: 'Bis 1080p (Full HD)', 720: 'Bis 720p (HD)', 540: 'Bis 540p (sparsam)', 360: 'Bis 360p (sehr sparsam)' };

/** Felder je Unterseite. type: select | toggle | number | scheme | root | languages | notice. */
const PAGES = {
  storage: {
    title: 'Mediatheken: Downloads – Ablage',
    desc: 'Wohin die Folgen gespeichert werden und wie die Dateien heißen.',
    fields: [
      { type: 'root', key: 'storageRoot', label: 'Speicherort' },
      { type: 'scheme', key: 'fileNameScheme', label: 'Dateiname', hint: 'Platzhalter: {title} Titel, {series} Serie, {season2} Staffel (zweistellig), {episode2} Folge (zweistellig), {season}, {episode}, {date} Sendedatum, {year} Jahr. Ohne Staffel und Folge heißt die Datei „Titel (Datum)“.' },
      { type: 'toggle', key: 'seriesFolders', label: 'Ordner je Serie anlegen', hint: 'Ablage als Speicherort/Quelle/Serie/Datei. Ohne Ordner liegen alle Dateien einer Quelle zusammen.' },
      { type: 'toggle', key: 'writeNfoCover', label: 'NFO-Datei und Cover schreiben', hint: 'Metadaten und Titelbild neben der Datei, für Jellyfin, Plex und Kodi.' },
    ],
  },
  quality: {
    title: 'Mediatheken: Downloads – Qualität',
    desc: 'Auflösung und Dateiformat. Im Dialog „Download-Optionen“ lässt sich beides je Folge ändern.',
    fields: [
      { type: 'select', key: 'maxHeight', label: 'Höchste Auflösung', options: labelled(['best', '1080', '720', '540', '360'], HEIGHT_LABELS), hint: 'Die Quelle liefert höchstens diese Höhe; „Beste verfügbare“ nimmt, was angeboten wird. Niedrigere Stufen sparen Platz.' },
      { type: 'select', key: 'container', label: 'Container', options: labelled(['mp4', 'mkv'], { mp4: 'MP4 (empfohlen)', mkv: 'MKV' }), hint: 'MP4 läuft fast überall. MKV kann mehr Tonspuren und Untertitel in einer Datei ablegen.' },
    ],
  },
  audio: {
    title: 'Mediatheken: Downloads – Ton & Untertitel',
    desc: 'Welche Tonspuren und Untertitel in die Datei kommen, soweit die Quelle sie anbietet.',
    fields: [
      { type: 'select', key: 'audioMode', label: 'Tonspuren', options: labelled(['preferred', 'all'], { preferred: 'Nur bevorzugte Sprachen', all: 'Alle Tonspuren' }) },
      { type: 'languages', key: 'audioLanguages', label: 'Reihenfolge der Sprachen', hint: 'Die erste vorhandene Sprache zählt als Hauptton. „Originalsprache“ nimmt den Originalton.' },
      { type: 'select', key: 'audioDescription', label: 'Audiodeskription', options: labelled(['never', 'additional', 'fallback'], { never: 'Nie', additional: 'Zusätzlich als eigene Spur', fallback: 'Nur, wenn es keine normale Spur gibt' }) },
      { type: 'select', key: 'subtitleMode', label: 'Untertitel', options: labelled(['none', 'preferred', 'all'], { none: 'Keine', preferred: 'Bevorzugte Sprache', all: 'Alle' }) },
      { type: 'select', key: 'subtitleLanguage', label: 'Sprache der Untertitel', options: labelled(['deu', 'eng', 'fra', 'ita', 'spa', 'nld', 'pol', 'tur'], LANGUAGE_LABELS) },
      { type: 'select', key: 'subtitleDelivery', label: 'Ablage der Untertitel', options: labelled(['embedded', 'external'], { embedded: 'In die Datei einbetten', external: 'Als .srt-Datei daneben' }), hint: 'Gebärdensprache wird nie geladen.' },
    ],
  },
  control: {
    title: 'Mediatheken: Downloads – Steuerung',
    desc: 'Wie viele Downloads gleichzeitig laufen, was nach dem Laden passiert und wie Serien-Abos neue Folgen laden.',
    fields: [
      { type: 'number', key: 'maxParallel', label: 'Parallele Downloads', min: 1, max: 5, unit: '', hint: 'Von 1 bis 5. Läuft eine Aufnahme, hat sie Vorrang und es läuft nur ein Download.' },
      { type: 'number', key: 'bandwidthKBps', label: 'Bandbreitenlimit', min: 0, max: 1000000, unit: 'kB/s', hint: '0 bedeutet unbegrenzt. 1 000 kB/s sind etwa 8 Mbit/s.' },
      { type: 'info', label: 'Reserve-Platz', text: 'Die Reserve für freien Speicherplatz gilt gemeinsam mit den Aufnahmen und steht unter Einstellungen ▸ LiveTV ▸ Aufnahmen.' },
      { type: 'toggle', key: 'notifyOnDone', label: 'Benachrichtigung bei Fertigstellung', hint: 'Eine Meldung, wenn die Warteschlange abgearbeitet ist, und eine gebündelte Meldung, wenn ein Abo neue Folgen findet.' },
      { type: 'toggle', key: 'autoDownloadEnabled', label: 'Neue Folgen von Serien-Abos automatisch laden', hint: 'Gilt für alle Abos (Downloads ▸ Abos). Geprüft wird kurz nach dem Start der App und danach im eingestellten Abstand, nur solange die App läuft.' },
      { type: 'number', key: 'autoCheckIntervalHours', label: 'Abos prüfen alle', min: 1, max: 24, unit: 'Stunden', hint: 'Von 1 bis 24 Stunden. Die Prüfung nacheinander und mit Pausen schont die Server der Mediatheken.' },
      { type: 'number', key: 'maxPerCheck', label: 'Höchstens je Prüfung und Abo', min: 1, max: 100, unit: 'Folgen', hint: 'Schutz vor Massen-Downloads: Was darüber hinausgeht, folgt bei der nächsten Prüfung.' },
      { type: 'number', key: 'cleanupWatchedDays', label: 'Gesehene Downloads aufräumen nach', min: 0, max: 3650, unit: 'Tagen', hint: '0 bedeutet aus. Gelöscht werden nur Folgen, die du bis zum Ende angesehen hast.' },
      { type: 'toggle', key: 'skipOptionsDialog', label: 'Dialog „Download-Optionen“ überspringen', hint: 'Ein Klick auf „Herunterladen“ startet sofort mit den Einstellungen dieser Seiten.' },
    ],
  },
  notes: {
    title: 'Mediatheken: Downloads – Hinweise',
    desc: 'Rechtliches und Sichtbarkeit der Download-Funktion.',
    fields: [
      { type: 'notice', title: NOTICE_TITLE, paragraphs: NOTICE_TEXT },
      { type: 'toggle', key: 'showDownloads', label: 'Download-Funktion anzeigen', hint: 'Schaltet den Bereich „Downloads“ und alle Download-Knöpfe in den Mediatheken ein oder aus. Bereits geladene Folgen bleiben erhalten.' },
    ],
  },
};

const SLOT_COUNT = 3;

/** Sprachliste -> drei Auswahlfelder (leer = ''). */
function languageSlots(languages) {
  const list = Array.isArray(languages) ? languages : [];
  return Array.from({ length: SLOT_COUNT }, (_, index) => list[index] || '');
}

/** Drei Auswahlfelder -> Sprachliste ohne leere Felder und Dubletten (mindestens Deutsch). */
function languagesFromSlots(slots) {
  const result = [];
  for (const code of slots) if (code && !result.includes(code)) result.push(code);
  return result.length ? result : ['deu'];
}

function languageOptions(optional) {
  const codes = Object.keys(LANGUAGE_LABELS);
  const list = codes.map(code => ({ value: code, label: LANGUAGE_LABELS[code] }));
  return optional ? [{ value: '', label: '–' }, ...list] : list;
}

/** Zahl aus einem Eingabefeld; null bei leerem oder ungültigem Text. */
function parseNumber(text) {
  const cleaned = String(text === undefined || text === null ? '' : text).replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Hinweise zu Werten, die der Main begrenzt hat: { key: text }. */
function clampMessages(response) {
  const clamped = (response && response.clamped) || {};
  const messages = {};
  if (clamped.maxParallel) messages.maxParallel = `Auf ${response.maxParallel} begrenzt (erlaubt: 1 bis 5).`;
  if (clamped.bandwidthKBps) messages.bandwidthKBps = response.bandwidthKBps === 0 ? 'Ungültiger Wert, das Limit ist aus.' : `Auf ${response.bandwidthKBps} kB/s begrenzt.`;
  if (clamped.cleanupWatchedDays) messages.cleanupWatchedDays = response.cleanupWatchedDays === 0 ? 'Ungültiger Wert, das Aufräumen ist aus.' : `Auf ${response.cleanupWatchedDays} Tage begrenzt (höchstens 3650).`;
  if (clamped.autoCheckIntervalHours) messages.autoCheckIntervalHours = `Auf ${response.autoCheckIntervalHours} ${response.autoCheckIntervalHours === 1 ? 'Stunde' : 'Stunden'} begrenzt (erlaubt: 1 bis 24).`;
  if (clamped.maxPerCheck) messages.maxPerCheck = `Auf ${response.maxPerCheck} begrenzt (erlaubt: 1 bis 100).`;
  return messages;
}

/** Beispiel-Dateiname für das Schema (ohne Endung). */
function schemePreview(scheme) {
  const sample = { title: 'Der Fall Berlin', series: 'Beispielserie', season: '1', season2: '01', episode: '2', episode2: '02', date: '2026-10-20', year: '2026' };
  return String(scheme).replace(/\{([a-z0-9]+)\}/g, (match, key) => (sample[key] !== undefined ? sample[key] : match));
}

/** Text zur Prüfung des Speicherorts (Antwort von downloads:validate-root). */
function rootCheckText(result) {
  if (!result || !result.ok) return { ok: false, text: (result && result.error) || 'Der Ordner ist nicht nutzbar.' };
  const free = typeof result.freeBytes === 'number' ? `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(result.freeBytes / 1e9)} GB frei` : 'Platz unbekannt';
  return { ok: true, text: result.network ? `Netzwerkordner, ${free}. Downloads können langsamer sein und brechen bei Verbindungsverlust ab.` : `Ordner nutzbar, ${free}.` };
}

module.exports = { PAGES, NOTICE_TEXT, SLOT_COUNT, languageSlots, languagesFromSlots, languageOptions, parseNumber, clampMessages, schemePreview, rootCheckText };
