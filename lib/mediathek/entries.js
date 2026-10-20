'use strict';

// Listen-Logik für Mediathek-Einträge (Port aus MediathekParser.swift): "(Originalversion)"/"(Audiodeskription)"-Dubletten
// mit dem Original zusammenführen, Staffel/Folge aus dem Titel lesen, nach Staffeln gruppieren.

const { withFields } = require('./util.js');

const OV_SUFFIX = /\s*-?\s*\(Originalversion\)\s*$/;
const AD_SUFFIX = /\s*-?\s*\(Audiodeskription\)\s*$/;

/** Staffel/Folge aus "(S10/E08)"; null ohne Treffer. */
function seasonEpisodeInTitle(title) {
  const match = /\(S(\d+)\/E(\d+)\)/.exec(String(title || ''));
  return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
}

const normalize = title => String(title).replace(/\u00a0/g, ' ').trim();
const isVariant = title => OV_SUFFIX.test(title) || AD_SUFFIX.test(title);

/**
 * OV- und AD-Dubletten mit dem gleichnamigen Original zusammenfassen: die Variante entfällt aus der Liste, ihre ID steht im
 * Original als originalVersionId bzw. audioDescriptionId. Ohne Original bleibt die Variante erhalten.
 */
function mergeOriginalVersions(entries) {
  const baseTitles = new Set();
  for (const entry of entries) if (!isVariant(entry.title)) baseTitles.add(normalize(entry.title));
  const variantIds = suffix => {
    const map = new Map(); // Basistitel -> ID der Variante
    for (const entry of entries) {
      const match = suffix.exec(entry.title);
      if (!match) continue;
      const base = normalize(entry.title.slice(0, match.index));
      if (baseTitles.has(base) && !map.has(base)) map.set(base, entry.id);
    }
    return map;
  };
  const originals = variantIds(OV_SUFFIX);
  const descriptions = variantIds(AD_SUFFIX);
  const merged = new Set([...originals.values(), ...descriptions.values()]);
  return entries
    .filter(entry => !merged.has(entry.id))
    .map(entry => {
      const key = normalize(entry.title);
      const ov = originals.get(key);
      const ad = descriptions.get(key);
      if (ov === undefined && ad === undefined) return entry;
      return withFields(entry, { originalVersionId: ov ?? entry.originalVersionId, audioDescriptionId: ad ?? entry.audioDescriptionId });
    });
}

/** Vergleicht Folgennummern: aufsteigend, Folgen ohne Nummer danach; bei Gleichstand bleibt die Quellreihenfolge. */
function byEpisode(left, right) {
  const a = left.entry.episode;
  const b = right.entry.episode;
  if (a !== null && b !== null) return a === b ? left.index - right.index : a - b;
  if (a !== null) return -1;
  if (b !== null) return 1;
  return left.index - right.index;
}

/**
 * Folgen nach Staffel gruppieren: Staffeln aufsteigend (Folgen ohne Staffel zuletzt), je Staffel nach Folgennummer.
 * Ergebnis: [{ number: Zahl|null, entries }].
 */
function groupBySeason(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.season === undefined ? null : entry.season;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === null ? Infinity : a) - (b === null ? Infinity : b));
  return keys.map(number => ({
    number,
    entries: groups
      .get(number)
      .map((entry, index) => ({ entry, index }))
      .sort(byEpisode)
      .map(item => item.entry),
  }));
}

module.exports = { mergeOriginalVersions, seasonEpisodeInTitle, groupBySeason };
