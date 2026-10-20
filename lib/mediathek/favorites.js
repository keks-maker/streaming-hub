'use strict';

// "Meine Serien": lokal gemerkte Mediatheken-Serien (Port von MediathekFavoritesService.swift). Datenformat wie auf tvOS/iPad:
// ein Array von Serien { id, title, imageUrl, description, sourceId, groupingURL } in Reihenfolge des Hinzufügens
// (neueste zuletzt). Persistenz über read()/write() (user-storage 'mediathekFavorites'), damit der Dienst ohne Dateisystem testbar bleibt.

const { isObject, nonEmpty, makeSeries } = require('./util.js');
const { SOURCE_IDS } = require('./sources.js');

const MAX_FAVORITES = 500;

/** Gültige Serie aus unsicherem Wert (Datei, Renderer) oder null. */
function normalizeSeries(value) {
  if (!isObject(value)) return null;
  const id = nonEmpty(value.id);
  const title = nonEmpty(value.title);
  const groupingURL = nonEmpty(value.groupingURL);
  if (!id || !title || !groupingURL || !SOURCE_IDS.includes(value.sourceId)) return null;
  return makeSeries({ id, title, imageUrl: nonEmpty(value.imageUrl), description: nonEmpty(value.description), sourceId: value.sourceId, groupingURL });
}

function createMediathekFavorites({ read, write, logger = null }) {
  let list = [];
  try {
    const stored = read();
    if (Array.isArray(stored)) list = stored.map(normalizeSeries).filter(Boolean).slice(0, MAX_FAVORITES);
  } catch (error) {
    if (logger) logger.warn('Meine Serien konnten nicht geladen werden:', error.message);
  }

  const save = () => write(list);
  const sameKey = (a, b) => a.id === b.id && a.sourceId === b.sourceId;

  return {
    /** Gemerkte Serien (Kopie). */
    list: () => list.map(series => ({ ...series })),
    isFavorite: (seriesId, sourceId) => list.some(series => series.id === seriesId && (sourceId === undefined || series.sourceId === sourceId)),
    /** Fügt die Serie hinzu bzw. entfernt sie; Ergebnis { favorite: true|false, series: [...] } (favorite: danach Favorit). */
    toggle(value) {
      const series = normalizeSeries(value);
      if (!series) throw new Error('Serie ist ungültig');
      const index = list.findIndex(item => sameKey(item, series));
      if (index >= 0) {
        list = list.filter((_, position) => position !== index);
        save();
        return { favorite: false, series: this.list() };
      }
      if (list.length >= MAX_FAVORITES) throw new Error('Zu viele gemerkte Serien');
      list = [...list, series];
      save();
      return { favorite: true, series: this.list() };
    },
  };
}

module.exports = { createMediathekFavorites, normalizeSeries, MAX_FAVORITES };
