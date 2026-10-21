'use strict';

// Inhalt des Detail-Fensters einer Folge (rein, ohne DOM): Kopfzeile, Meta, Verfügbarkeit, Beschreibung und die
// Hinweise zu Region (Geoblock) und Altersfreigabe (FSK). `blocked` sind Folgen, deren Wiedergabe in dieser Sitzung
// als gesperrt gemeldet wurde: { reason: 'geoBlocked'|'ageRestricted'|'unavailable', message }.

const { sourceBadge, subtitleText, minutesText, availableUntilText, fskText } = require('./mediathek-format.js');

function detailInfo(entry, { blocked = null, series = null } = {}) {
  const hints = [];
  if (entry.regionRestricted) hints.push({ kind: 'geo', text: 'Nur in Deutschland abrufbar.' });
  if (blocked) {
    const kind = blocked.reason === 'ageRestricted' ? 'fsk' : blocked.reason === 'geoBlocked' ? 'geo' : 'unavailable';
    const text = blocked.message || 'Nicht abrufbar.';
    if (!hints.some(hint => hint.text === text)) hints.push({ kind, text });
  }
  const kicker = `${sourceBadge(entry.sourceId)}${entry.regionRestricted ? ' · NUR IN DEUTSCHLAND' : ''}`;
  const meta = [subtitleText(entry), minutesText(entry.duration) ? `Dauer ${minutesText(entry.duration)}` : null].filter(Boolean);
  return {
    kicker,
    title: entry.title,
    meta,
    fsk: fskText(entry.fsk),
    availability: availableUntilText(entry),
    description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : null,
    hints,
    canPlay: !blocked,
    canFavorite: Boolean(series),
  };
}

/** Meldung aus dem Ergebnis von mediathek:resolve-playback; null, wenn abspielbar. */
function blockedFromResolution(result) {
  if (!result || !result.ok) return { reason: 'unavailable', message: (result && result.error) || 'Wiedergabe nicht möglich.' };
  const kind = result.resolution && result.resolution.kind;
  if (kind === 'playable') return null;
  return { reason: kind === 'geoBlocked' || kind === 'ageRestricted' ? kind : 'unavailable', message: result.message || 'Stream nicht verfügbar.' };
}

module.exports = { detailInfo, blockedFromResolution };
