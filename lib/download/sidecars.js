'use strict';

// Begleitdateien eines fertigen Downloads (Einstellung "NFO/Cover schreiben"): NFO im Kodi-Format neben dem Video und das Cover als
// poster.jpg im Serienordner (einmal je Serie) bzw. "<Name>-poster.jpg" ohne Serienordner. Fehler sind nie fatal.

const fs = require('node:fs');
const path = require('node:path');
const { buildEpisodeNfo } = require('./nfo.js');

/** Schreibt NFO und Cover; Rückgabe: Pfade der Dateien, die zur Folge gehören (beim Löschen mit entfernt). */
async function writeSidecars({ record, file, coverFetcher, seriesFolders, log = () => {} }) {
  const written = [];
  const base = file.slice(0, -path.extname(file).length);
  try {
    const nfo = `${base}.nfo`;
    fs.writeFileSync(nfo, buildEpisodeNfo({ title: record.title, seriesTitle: record.seriesTitle, season: record.season, episode: record.episode, broadcastDate: record.broadcastDate, description: record.entry.description, durationSec: record.durationSec, sourceId: record.entry.sourceId }), 'utf8');
    written.push(nfo);
  } catch (error) {
    log('warn', `NFO nicht geschrieben: ${error.code || error.message}`);
  }
  if (!coverFetcher || !record.entry.imageUrl) return written;
  try {
    const cover = await coverFetcher(record.entry.imageUrl, record.entry.sourceId);
    if (!cover) return written;
    const inSeriesFolder = Boolean(record.seriesTitle) && seriesFolders;
    const target = inSeriesFolder ? path.join(path.dirname(file), `poster.${cover.ext}`) : `${base}-poster.${cover.ext}`;
    if (inSeriesFolder && fs.existsSync(target)) return written; // Serienposter nur einmal; es gehört der Serie, nicht der Folge
    fs.writeFileSync(target, cover.data);
    if (!inSeriesFolder) written.push(target);
  } catch (error) {
    log('warn', `Cover nicht gespeichert: ${error.code || error.message}`);
  }
  return written;
}

module.exports = { writeSidecars };
