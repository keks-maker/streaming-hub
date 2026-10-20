'use strict';

// Dateiablage der Downloads: <Root>/<Quelle>/<Serie>/<Schema>.<Endung>. Reine Funktionen (Dateisystemzugriff nur über das
// injizierbare exists): Zeichen und Länge bereinigen, Schema mit Platzhaltern auswerten, Kollision -> Zähler.

const path = require('node:path');
const { DEFAULT_SCHEME } = require('./download-settings.js');

const SOURCE_FOLDERS = { ard: 'ARD', zdf: 'ZDF', arte: 'arte' };
const NAME_MAX = 120; // Zeichen je Pfadteil; mit Endung/.part/Zähler weit unter den 255 Byte der Dateisysteme
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Bereinigt einen einzelnen Pfadteil (Datei- oder Ordnername): verbotene Zeichen, Steuerzeichen, Punkte/Leerzeichen am Rand, Länge. */
function sanitizeName(text, { max = NAME_MAX, fallback = 'Unbenannt' } = {}) {
  let name = String(text === undefined || text === null ? '' : text)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name.length > max) name = name.slice(0, max).replace(/[. ]+$/, '');
  if (!name || RESERVED.test(name)) return fallback;
  return name;
}

const pad2 = value => String(value).padStart(2, '0');

/** Titel ohne angehängte "(S01/E02)"-Kennung der ARD (steckt sonst doppelt im Dateinamen). */
function cleanTitle(title) {
  return String(title || '').replace(/\s*\(S\d+\/E\d+\)\s*$/, '').trim();
}

/** Platzhalter-Werte aus den Episodendaten. */
function placeholderValues({ title, seriesTitle, season, episode, date }) {
  const hasSeason = Number.isInteger(season) && season > 0;
  const hasEpisode = Number.isInteger(episode) && episode > 0;
  return {
    title: cleanTitle(title),
    series: seriesTitle || '',
    season: hasSeason ? String(season) : '',
    season2: hasSeason ? pad2(season) : '',
    episode: hasEpisode ? String(episode) : '',
    episode2: hasEpisode ? pad2(episode) : '',
    date: date || '',
    year: date ? String(date).slice(0, 4) : '',
    hasSeason,
    hasEpisode,
  };
}

/** Fallback-Name "Titel (Datum)". */
function fallbackName(values) {
  const base = values.title || values.series || 'Unbenannt';
  return values.date ? `${base} (${values.date})` : base;
}

/**
 * Dateiname (ohne Endung) aus Schema und Episodendaten. Fehlen Staffel/Folge für ein Schema, das sie verwendet, gilt der Fallback
 * "Titel (Datum)". Ergebnis ist bereinigt und nie leer.
 */
function renderFileName(scheme, data) {
  const values = placeholderValues(data);
  const text = String(scheme || DEFAULT_SCHEME);
  const needsSeason = /\{season2?\}/.test(text);
  const needsEpisode = /\{episode2?\}/.test(text);
  if ((needsSeason && !values.hasSeason) || (needsEpisode && !values.hasEpisode)) {
    // Folge ohne Staffel (Magazin, arte-Einzelfilm): "E05 - Titel" bliebe sinnvoll, ein Schema mit beiden braucht beide
    return sanitizeName(fallbackName(values));
  }
  const rendered = text.replace(/\{([a-z0-9]+)\}/g, (_, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''));
  return sanitizeName(rendered.replace(/\s*-\s*$/, '').replace(/^\s*-\s*/, ''), { fallback: sanitizeName(fallbackName(values)) });
}

/** Ordnername der Quelle. */
function sourceFolder(sourceId) {
  return SOURCE_FOLDERS[sourceId] || sanitizeName(sourceId);
}

/**
 * Zielpfad eines Downloads: { dir, base, ext, file, partFile }. exists(pfad) prüft Kollisionen (fertige Datei, .part oder bereits
 * vergebener Pfad eines anderen Jobs); bei Kollision hängt " (2)", " (3)" ... an. Ist ownedBase gesetzt (Wiederaufnahme), bleibt
 * dieser Name unverändert.
 */
function buildTarget({ root, sourceId, seriesTitle, data, scheme, seriesFolders = true, ext, exists = () => false }) {
  const parts = [path.resolve(root), sourceFolder(sourceId)];
  if (seriesFolders && seriesTitle) parts.push(sanitizeName(seriesTitle));
  const dir = path.join(...parts);
  const stem = renderFileName(scheme, { ...data, seriesTitle });
  const free = base => !exists(path.join(dir, `${base}.${ext}`)) && !exists(path.join(dir, `${base}.${ext}.part`));
  let base = stem;
  for (let counter = 2; !free(base) && counter < 1000; counter += 1) base = `${stem} (${counter})`;
  const file = path.join(dir, `${base}.${ext}`);
  return { dir, base, ext, file, partFile: `${file}.part` };
}

module.exports = { SOURCE_FOLDERS, NAME_MAX, sanitizeName, cleanTitle, renderFileName, sourceFolder, buildTarget };
