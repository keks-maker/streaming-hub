'use strict';

// Kodi-/Jellyfin-/Plex-Metadaten zu einem Download: <episodedetails>-NFO neben der Videodatei und das Cover (poster.jpg bzw.
// "<Name>-poster.jpg"). Reine Textaufbereitung; Schreiben und Laden des Covers übernimmt der Service.

const { cleanTitle } = require('./filenames.js');

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    // eslint-disable-next-line no-control-regex -- für XML 1.0 ungültige Steuerzeichen entfernen
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name, value) {
  if (value === undefined || value === null || value === '') return null;
  return `  <${name}>${escapeXml(value)}</${name}>`;
}

/**
 * episodedetails-NFO. record: { title, seriesTitle, season, episode, broadcastDate, description, durationSec, sourceId }.
 * Folgen ohne Staffel/Folgennummer erhalten season 0 / keine episode-Zeile nicht: Kodi liest sie als Einzelbeitrag.
 */
function buildEpisodeNfo(record) {
  const minutes = Number.isFinite(record.durationSec) && record.durationSec > 0 ? Math.max(1, Math.round(record.durationSec / 60)) : null;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<episodedetails>',
    tag('title', cleanTitle(record.title)),
    tag('showtitle', record.seriesTitle),
    Number.isInteger(record.season) && record.season > 0 ? tag('season', record.season) : null,
    Number.isInteger(record.episode) && record.episode > 0 ? tag('episode', record.episode) : null,
    tag('plot', record.description),
    tag('aired', record.broadcastDate),
    tag('premiered', record.broadcastDate),
    tag('runtime', minutes),
    tag('studio', { ard: 'ARD', zdf: 'ZDF', arte: 'arte' }[record.sourceId] || record.sourceId),
    '</episodedetails>',
  ];
  return `${lines.filter(Boolean).join('\n')}\n`;
}

module.exports = { buildEpisodeNfo, escapeXml };
