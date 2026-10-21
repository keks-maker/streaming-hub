'use strict';

// Anzeige-Texte und -Werte der Mediathek-Oberfläche (rein, ohne DOM; Port von MediathekText aus dem Apple-Core).

const { badge } = require('./lib/mediathek/sources.js');

const SOURCE_COLORS = { ard: '#3a8dde', zdf: '#f08a3c', arte: '#e8602c' };
const SOURCE_LABELS = { ard: 'ARD', zdf: 'ZDF', arte: 'arte' };

const sourceBadge = sourceId => badge(sourceId);

/** Bezeichnung einer Genre-/Rubrik-Seite: arte nennt sie Genre, ARD und ZDF Rubrik. */
const genreNoun = sourceId => (sourceId === 'arte' ? 'Genre' : 'Rubrik');
const sourceLabel = sourceId => SOURCE_LABELS[sourceId] || String(sourceId || '').toUpperCase();
const sourceColor = sourceId => SOURCE_COLORS[sourceId] || '#6c5ce7';

/** "44 Min." für Sekunden > 0, sonst null. */
function minutesText(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return `${Math.max(1, Math.round(seconds / 60))} Min.`;
}

/** "FSK 12" für eine Altersfreigabe (0/6/12/16/18); null ohne Angabe. */
function fskText(fsk) {
  return typeof fsk === 'number' && Number.isInteger(fsk) && fsk >= 0 && fsk <= 18 ? `FSK ${fsk}` : null;
}

/** Höchste Altersfreigabe der Folgen einer Serie (Staffeln wie groupBySeason); null, wenn keine Folge eine nennt. */
function seriesFsk(seasons) {
  let top = null;
  for (const season of Array.isArray(seasons) ? seasons : []) {
    for (const entry of Array.isArray(season.entries) ? season.entries : []) {
      if (typeof entry.fsk === 'number' && (top === null || entry.fsk > top)) top = entry.fsk;
    }
  }
  return top;
}

/** "Staffel 2 · Folge 3 · Untertitel" bzw. nur der Untertitel; null ohne Angaben. */
function subtitleText(entry) {
  const parts = [];
  if (entry && entry.season !== null && entry.season !== undefined) parts.push(`Staffel ${entry.season}`);
  if (entry && entry.episode !== null && entry.episode !== undefined) parts.push(`Folge ${entry.episode}`);
  if (entry && typeof entry.subtitle === 'string' && entry.subtitle) parts.push(entry.subtitle);
  return parts.length ? parts.join(' · ') : null;
}

/** TT.MM.JJJJ (Europe/Berlin) aus einem ISO-Zeitpunkt; null bei ungültigem Wert. */
function germanDate(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(time));
}

/** "Verfügbar bis 27.11.2026" oder null. */
function availableUntilText(entry) {
  const date = germanDate(entry && entry.availableUntil);
  return date ? `Verfügbar bis ${date}` : null;
}

/** Bildadresse: nur https; "{width}" wird ersetzt (CSP erlaubt nur https-Bilder). */
function imageSrc(url, width = 640) {
  if (typeof url !== 'string' || !url) return null;
  const resolved = url.replace('{width}', String(width));
  return /^https:\/\//i.test(resolved) ? resolved : null;
}

/** Ein bis zwei Anfangsbuchstaben für den Bildplatzhalter. */
function initials(title) {
  const words = String(title || '')
    .split(/[\s|:–-]+/)
    .filter(word => /[\p{L}\p{N}]/u.test(word));
  return words
    .slice(0, 2)
    .map(word => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '')
    .join('')
    .toUpperCase();
}

/** Stabiler Farbton (0..359) je Titel für den Platzhalter. */
function placeholderHue(title) {
  let hash = 0;
  for (const char of String(title || '')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

/** "12:05" bzw. "1:02:05" für Sekunden (Player-Anzeige). */
function clockText(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = value => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

module.exports = { sourceBadge, genreNoun, sourceLabel, sourceColor, minutesText, subtitleText, fskText, seriesFsk, germanDate, availableUntilText, imageSrc, initials, placeholderHue, clockText };
