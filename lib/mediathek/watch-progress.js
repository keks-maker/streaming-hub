'use strict';

// Anbindung an den bestehenden Verlauf (history.json, Format unverändert: { title, serviceKey, serviceName, timestamp },
// höchstens 20 Einträge, Dubletten über title + serviceKey). Mediathek-Einträge verwenden serviceKey "mediathek:<quelle>" und
// tragen zusätzlich die optionalen Felder der Apple-HistoryEntry (imageUrl, url, positionSeconds, durationSeconds, series), damit
// beide Plattformen später dieselben Daten lesen können. Ältere Einträge ohne diese Felder bleiben gültig.

const { storedPosition, resumeStart, isResumable, WATCHED_FRACTION } = require('./resume.js');
const { BUILTIN_SOURCES } = require('./sources.js');

const MAX_HISTORY = 20; // wie save-history-entry in main.js
const KEY_PREFIX = 'mediathek:';

const serviceKeyOf = sourceId => `${KEY_PREFIX}${sourceId}`;
const sourceName = sourceId => (BUILTIN_SOURCES.find(source => source.id === sourceId) || { name: sourceId }).name;

/**
 * load() liefert den Verlauf (Array), save(history) schreibt ihn; beides sind die Funktionen aus main.js.
 * Rückgabe: { record, updateProgress, progress, lastUnfinishedEpisode, entries }.
 */
function createWatchProgress({ load, save, now = () => new Date() }) {
  const read = () => {
    const history = load();
    return Array.isArray(history) ? history : [];
  };
  const findIndex = (history, sourceId, title) => history.findIndex(item => item && item.title === title && item.serviceKey === serviceKeyOf(sourceId));

  return {
    /** Mediathek-Einträge des Verlaufs, neueste zuerst. */
    entries: () => read().filter(item => item && typeof item.serviceKey === 'string' && item.serviceKey.startsWith(KEY_PREFIX)),

    /** Beginnt/aktualisiert einen Verlaufseintrag (Wiedergabestart): neuester Eintrag steht vorn, Position bleibt erhalten. */
    record({ entry, series = null, url = null }) {
      let history = read();
      const index = findIndex(history, entry.sourceId, entry.title);
      const previous = index >= 0 ? history[index] : null;
      const record = {
        ...(previous || {}),
        title: entry.title,
        serviceKey: serviceKeyOf(entry.sourceId),
        serviceName: sourceName(entry.sourceId),
        timestamp: now().toISOString(),
        imageUrl: entry.imageUrl || (previous && previous.imageUrl) || null,
        url: url || (previous && previous.url) || null,
        series: series || (previous && previous.series) || null,
        fsk: Number.isInteger(entry.fsk) ? entry.fsk : (previous && Number.isInteger(previous.fsk) ? previous.fsk : null),
      };
      history = [record, ...history.filter((_, position) => position !== index)].slice(0, MAX_HISTORY);
      save(history);
      return record;
    },

    /** Position/Dauer eines laufenden Beitrags speichern; kaum begonnen oder fast fertig = Position zurücksetzen. Ohne Eintrag: nichts. */
    updateProgress({ sourceId, title, position, duration }) {
      const history = read();
      const index = findIndex(history, sourceId, title);
      if (index < 0) return false;
      const stored = storedPosition(position, duration);
      // bis zum Ende angesehen: Marke "watched" (für das Aufräumen gesehener Downloads), die Position selbst wird zurückgesetzt
      const finished = Number.isFinite(duration) && duration > 0 && position / duration >= WATCHED_FRACTION;
      history[index] = { ...history[index], positionSeconds: stored, durationSeconds: stored === null ? null : duration, ...(finished ? { watched: true } : {}) };
      save(history);
      return true;
    },

    /** Gespeicherter Fortschritt { position, duration, start } (start: Startposition mit Rücksprung oder null) oder null. */
    progress(sourceId, title) {
      const item = read()[findIndex(read(), sourceId, title)];
      if (!item || typeof item.positionSeconds !== 'number') return null;
      return { position: item.positionSeconds, duration: item.durationSeconds ?? null, start: resumeStart(item.positionSeconds, item.durationSeconds) };
    },

    /** Wurde der Beitrag (laut Verlauf) bis zum Ende angesehen? */
    isWatched(sourceId, title) {
      const history = read();
      const item = history[findIndex(history, sourceId, title)];
      return Boolean(item && item.watched === true);
    },

    /** Zuletzt begonnene, nicht beendete Folge einer Serie (neuester Eintrag zuerst) oder null. */
    lastUnfinishedEpisode(series) {
      return this.entries().find(item => item.series && item.series.id === series.id && item.series.sourceId === series.sourceId && isResumable(item)) || null;
    },
  };
}

module.exports = { createWatchProgress, serviceKeyOf, KEY_PREFIX, MAX_HISTORY };
