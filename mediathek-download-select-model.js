'use strict';

// Serien-Download (rein, ohne DOM): Menü „Laden ▾“, Auswahlliste mit Häkchen (alle vorgewählt, bereits geladene ausgegraut),
// geschätzte Gesamtgröße gegen freien Platz und die Liste der Folgen-IDs für downloads:enqueue-many.

const { formatBytes } = require('./mediathek-downloads-model.js');

/** Grobe Datenrate je Auflösungsgrenze in kbit/s (Bild + Ton) für die Größenschätzung vor dem Auflösen der Quelle. */
const BITRATE_KBPS = { best: 5200, 1080: 5200, 720: 3000, 540: 1800, 360: 1000 };
const MAX_SELECTION = 500;

/** Geschätzte Größe einer Folge in Byte; 0, wenn die Dauer unbekannt ist. */
function estimateBytes(entry, maxHeight = '1080') {
  const seconds = entry && typeof entry.duration === 'number' && entry.duration > 0 ? entry.duration : 0;
  const kbps = BITRATE_KBPS[maxHeight] || BITRATE_KBPS['1080'];
  return Math.round((seconds * kbps * 1000) / 8);
}

/** Einträge der Menüs im Serienkopf. */
function menuItems(seasonNumbers) {
  const items = [{ id: 'all', label: 'Alle Folgen' }];
  if (seasonNumbers.length > 1) for (const number of seasonNumbers) items.push({ id: `season:${number}`, label: `Staffel ${number}` });
  items.push({ id: 'select', label: 'Auswahl …' }, { id: 'new', label: 'Nur neue' });
  return items;
}

const downloadable = state => state === 'none' || state === 'failed';

/**
 * Auswahl für den Dialog. seasons: [{ number, entries }] (Reihenfolge wie angezeigt), stateOf(entry) -> { state }.
 * Bereits geladene, wartende oder laufende Folgen sind nicht wählbar (ausgegraut).
 */
function createSelection({ seasons, stateOf, maxHeight = '1080' }) {
  const rows = [];
  for (const season of seasons) {
    for (const entry of season.entries) {
      const state = stateOf(entry).state;
      rows.push({ entry, season: season.number, state, selectable: downloadable(state), selected: false });
    }
  }
  const byId = new Map(rows.map(row => [row.entry.id, row]));
  const selectable = () => rows.filter(row => row.selectable);

  /** Nur neue: wählbare Folgen, die nach der zuletzt vorhandenen (geladenen/eingereihten) Folge ausgestrahlt wurden. */
  function newRows() {
    const have = rows.filter(row => !row.selectable && row.entry.airedAt).map(row => Date.parse(row.entry.airedAt));
    const newest = have.length ? Math.max(...have) : null;
    const anyHave = rows.some(row => !row.selectable);
    return selectable().filter(row => {
      if (!anyHave) return true;
      const aired = row.entry.airedAt ? Date.parse(row.entry.airedAt) : NaN;
      return newest !== null && Number.isFinite(aired) && aired > newest;
    });
  }

  const api = {
    rows,
    toggle(id) {
      const row = byId.get(id);
      if (row && row.selectable) row.selected = !row.selected;
    },
    selectAll() {
      selectable().forEach(row => {
        row.selected = true;
      });
    },
    clear() {
      rows.forEach(row => {
        row.selected = false;
      });
    },
    selectSeason(number) {
      api.clear();
      selectable().filter(row => row.season === number).forEach(row => {
        row.selected = true;
      });
    },
    selectNew() {
      api.clear();
      newRows().forEach(row => {
        row.selected = true;
      });
    },
    /** Vorauswahl nach Menüeintrag: all | season:N | select | new. */
    preselect(mode) {
      if (mode === 'new') api.selectNew();
      else if (mode && mode.startsWith('season:')) api.selectSeason(Number(mode.slice(7)));
      else api.selectAll();
    },
    selectedRows: () => rows.filter(row => row.selected),
    ids: () => rows.filter(row => row.selected).map(row => row.entry.id).slice(0, MAX_SELECTION),
    /** Staffel-Kopfzeile: alle wählbaren Folgen gewählt? */
    seasonState(number) {
      const own = selectable().filter(row => row.season === number);
      if (!own.length) return 'none';
      const chosen = own.filter(row => row.selected).length;
      return chosen === 0 ? 'off' : chosen === own.length ? 'on' : 'some';
    },
    toggleSeason(number) {
      const state = api.seasonState(number);
      selectable().filter(row => row.season === number).forEach(row => {
        row.selected = state !== 'on';
      });
    },
    setMaxHeight(value) {
      maxHeight = value; // eslint-disable-line no-param-reassign
    },
    /** Zahl, geschätzte Gesamtgröße und Reichweite des freien Platzes. */
    totals(freeBytes) {
      const chosen = api.selectedRows();
      const bytes = chosen.reduce((sum, row) => sum + estimateBytes(row.entry, maxHeight), 0);
      const unknown = chosen.filter(row => !(row.entry.duration > 0)).length;
      return { count: chosen.length, bytes, unknownSize: unknown, enoughSpace: typeof freeBytes === 'number' ? bytes <= freeBytes : null };
    },
    selectableCount: () => selectable().length,
  };
  return api;
}

/** Zeile unter der Liste: "12 Folgen · ca. 8,3 GB · Frei: 120 GB" bzw. Warnung bei zu wenig Platz. */
function totalsText(totals, freeBytes) {
  const size = formatBytes(totals.bytes);
  const parts = [`${totals.count} ${totals.count === 1 ? 'Folge' : 'Folgen'}`];
  if (size && totals.bytes > 0) parts.push(`ca. ${size}`);
  const free = formatBytes(freeBytes);
  if (free) parts.push(`Frei: ${free}`);
  return parts.join(' · ');
}

/** Knopfbeschriftung: "12 Folgen laden". */
function submitLabel(count) {
  return count === 1 ? '1 Folge laden' : `${count} Folgen laden`;
}

/** Ergebnis von downloads:enqueue-many als Meldung. */
function resultText(result) {
  if (!result || result.ok === false) return (result && result.message) || 'Die Folgen konnten nicht eingereiht werden.';
  const failed = (result.results || []).filter(item => !item.ok && item.code !== 'duplicate').length;
  const base = `${result.added} ${result.added === 1 ? 'Folge' : 'Folgen'} zur Warteschlange hinzugefügt.`;
  return failed ? `${base} ${failed === 1 ? '1 Folge konnte' : `${failed} Folgen konnten`} nicht eingereiht werden.` : base;
}

module.exports = { BITRATE_KBPS, MAX_SELECTION, estimateBytes, menuItems, createSelection, totalsText, submitLabel, resultText };
