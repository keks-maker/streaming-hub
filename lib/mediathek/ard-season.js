'use strict';

// ARD-Staffel/Folge (Spike-Bericht §5): Teaser und Item nennen die Staffel nicht als Feld. Die Staffeln einer Serie stehen in
// widgets[].show.availableSeasons der Grouping-Seite, die Folgen einer Staffel liefert widgets/ard/asset/<groupingId>?seasoned=true&
// seasonNumber=N. Daraus ergeben sich Staffel und (Position nach Sendedatum) Folgennummer, damit "S01E02" stimmt; der Titel-Regex
// "(S05/E08)" bleibt der erste Weg und diese Ermittlung der Rückfall.

const { dicts, isObject } = require('./util.js');
const { ardTeaser } = require('./parser-ard.js');

const MAX_SEASONS = 40;
const PAGE_SIZE = 48;
const MAX_PAGES = 4;

/** Staffelnummern aus widgets[].show.availableSeasons (Strings oder Zahlen), aufsteigend, ohne Dubletten. */
function availableSeasons(root) {
  const seasons = new Set();
  for (const widget of dicts(root && root.widgets)) {
    const show = isObject(widget.show) ? widget.show : null;
    if (!show || !Array.isArray(show.availableSeasons)) continue;
    for (const item of show.availableSeasons) {
      const number = Number.parseInt(item, 10);
      if (Number.isInteger(number) && number > 0 && number < 1900) seasons.add(number);
    }
  }
  return [...seasons].sort((a, b) => a - b).slice(0, MAX_SEASONS);
}

/** Adresse einer Staffelseite des Grouping-Widgets (groupingId = Serien-ID). */
function seasonAssetUrl(groupingId, season, page = 0) {
  const query = `pageNumber=${page}&pageSize=${PAGE_SIZE}&embedded=true&seasoned=true&seasonNumber=${season}&withAudiodescription=false&withOriginalWithSubtitle=false&withOriginalversion=false&single=false`;
  return `https://api.ardmediathek.de/page-gateway/widgets/ard/asset/${encodeURIComponent(groupingId)}?${query}`;
}

/** Folgen einer Staffelseite in Sendereihenfolge (Extras entfallen): [{ id, airedAt }]. */
function seasonEntries(root) {
  const teasers = [...dicts(root && root.teasers)];
  for (const widget of dicts(root && root.widgets)) teasers.push(...dicts(widget.teasers));
  const result = [];
  for (const teaser of teasers) {
    if (typeof teaser.coreAssetType === 'string' && teaser.coreAssetType.startsWith('EXTRA_')) continue;
    const item = ardTeaser(teaser);
    if (item && item.entry) result.push({ id: item.entry.id, airedAt: item.entry.airedAt || '', title: item.entry.title });
  }
  return result;
}

/** Weitere Seite nötig? Nur wenn pagination.totalElements mehr nennt, als die bisherigen Seiten fassen (und unter der Seitengrenze). */
function hasMorePages(root, page) {
  const pagination = isObject(root && root.pagination) ? root.pagination : null;
  const total = pagination && Number.isFinite(pagination.totalElements) ? pagination.totalElements : 0;
  return page + 1 < MAX_PAGES && total > (page + 1) * PAGE_SIZE;
}

/** Position (1-basiert) der Folge in der nach Sendedatum geordneten Staffelliste; null, wenn nicht enthalten. */
function episodePosition(entries, entryId) {
  const ordered = entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => (a.airedAt < b.airedAt ? -1 : a.airedAt > b.airedAt ? 1 : a.index - b.index));
  const index = ordered.findIndex(entry => entry.id === entryId);
  return index < 0 ? null : index + 1;
}

module.exports = { availableSeasons, seasonAssetUrl, seasonEntries, hasMorePages, episodePosition };
