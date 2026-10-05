'use strict';

// Tests: Senderauswahl des Programmführers (Etappe 3.5, EPG-E3/P14) — Favoriten · Alle · Quelle · Gruppe,
// „Sender ohne EPG ausblenden“, Zusammenspiel mit dem Ansichtszustand und dem Raster.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const sel = require('../epg-selection-model.js');
const model = require('../epg-view-model.js');
const gridModel = require('../epg-grid-model.js');

const ch = (id, group, sourceId, extra = {}) => ({ id, name: `Sender ${id}`, group, sourceId, tvgId: `${id}.de`, ...extra });
const CHANNELS = [
  ch('a', 'Nachrichten', 's1'),
  ch('b', 'Nachrichten', 's2'),
  ch('c', 'Sport', 's1'),
  ch('d', 'Sport', 's2'),
  ch('e', 'Kinder', 's1', { tvgId: '' }), // kein EPG-Schlüssel
  ch('f', 'Kinder', 's2', { tvgId: 'a.de' }), // gleicher Schlüssel wie a (andere Quelle)
];
const favs = new Set(['a', 'c', 'e']);
const isFavorite = c => favs.has(c.id);
const keysOf = list => list.map(e => e.channel.id);

function pick(selection) {
  return model.selectChannels({ channels: CHANNELS, include: sel.selectionPredicate(selection, isFavorite) });
}

test('Standard ist Favoriten; Eingaben werden normalisiert (unbekannte Art, fehlender/zu langer Wert → Favoriten)', () => {
  assert.deepEqual(sel.normalizeSelection(undefined), { kind: 'favorites', value: '' });
  for (const bad of [null, 'all', 5, [], {}, { kind: 'x' }, { kind: 'group' }, { kind: 'group', value: '' }, { kind: 'source', value: 5 }, { kind: 'group', value: 'x'.repeat(201) }]) {
    assert.deepEqual(sel.normalizeSelection(bad), { kind: 'favorites', value: '' }, JSON.stringify(bad));
  }
  assert.deepEqual(sel.normalizeSelection({ kind: 'all', value: 'egal' }), { kind: 'all', value: '' });
  assert.deepEqual(sel.normalizeSelection({ kind: 'group', value: 'Sport' }), { kind: 'group', value: 'Sport' });
  assert.ok(sel.sameSelection(undefined, { kind: 'favorites' }));
  assert.ok(!sel.sameSelection({ kind: 'group', value: 'Sport' }, { kind: 'group', value: 'Kinder' }));
});

test('Filter: Favoriten, Alle, Quelle, Gruppe — nur Sender mit EPG-Schlüssel, je Schlüssel einer (EPG-E3)', () => {
  assert.deepEqual(keysOf(pick({ kind: 'favorites' })), ['a', 'c'], 'e hat keinen Schlüssel');
  assert.deepEqual(keysOf(pick({ kind: 'all' })), ['a', 'b', 'c', 'd'], 'e ohne Schlüssel, f doppelt zu a');
  assert.deepEqual(keysOf(pick({ kind: 'source', value: 's1' })), ['a', 'c']);
  // f teilt den Schlüssel mit a: innerhalb von Quelle s2 ist f die erste Fundstelle, in „Alle“ gewinnt a
  assert.deepEqual(keysOf(pick({ kind: 'source', value: 's2' })), ['b', 'd', 'f']);
  assert.deepEqual(keysOf(pick({ kind: 'group', value: 'Nachrichten' })), ['a', 'b']);
  assert.deepEqual(keysOf(pick({ kind: 'group', value: 'Sport' })), ['c', 'd']);
  assert.deepEqual(keysOf(pick({ kind: 'group', value: 'Gibt-es-nicht' })), []);
  assert.deepEqual(keysOf(pick(null)), ['a', 'c'], 'ungültige Auswahl = Favoriten');
});

test('Favoriten leer: Auswahl ist leer (P14 zeigt Hinweis), „Alle“ und Gruppen liefern weiter Sender', () => {
  const none = () => false;
  const list = model.selectChannels({ channels: CHANNELS, include: sel.selectionPredicate({ kind: 'favorites' }, none) });
  assert.deepEqual(list, []);
  assert.equal(model.selectChannels({ channels: CHANNELS, include: sel.selectionPredicate({ kind: 'all' }, none) }).length, 4);
  // ohne isFavorite-Funktion: keine Favoriten, kein Fehler
  assert.deepEqual(model.selectChannels({ channels: CHANNELS, include: sel.selectionPredicate({ kind: 'favorites' }) }), []);
  const state = model.deriveViewState({ status: { sources: [{ configured: true }] }, loadError: '', loading: false, channelCount: 0, hasFavorites: false, showAll: false, rowCount: 0, hasDays: true });
  assert.equal(state.kind, 'no-favorites');
  assert.equal(state.action, 'show-all');
});

test('Rückwärtskompatibel: selectChannels ohne include wie bisher (Favoriten bzw. showAll)', () => {
  assert.deepEqual(keysOf(model.selectChannels({ channels: CHANNELS, isFavorite, showAll: false })), ['a', 'c']);
  assert.deepEqual(keysOf(model.selectChannels({ channels: CHANNELS, isFavorite, showAll: true })), ['a', 'b', 'c', 'd']);
});

test('Gruppen und Quellen: Zähler, Sortierung, Namen aus den Einstellungen', () => {
  const withKey = CHANNELS.filter(c => model.epgChannelKey(c));
  assert.deepEqual(sel.listGroups(withKey), [{ name: 'Kinder', count: 1 }, { name: 'Nachrichten', count: 2 }, { name: 'Sport', count: 2 }]);
  assert.deepEqual(sel.listGroups([{ group: ' ' }, {}, null, { group: 'Ö-Sport' }, { group: 'Zoo' }]), [{ name: 'Ö-Sport', count: 1 }, { name: 'Zoo', count: 1 }]);
  assert.deepEqual(sel.listGroups(undefined), []);
  const sources = [{ id: 's2', name: 'Zweite' }, { id: 's1', name: ' Erste ' }, { id: 'leer', name: 'Ohne Sender' }];
  assert.deepEqual(sel.listSources(withKey, sources), [{ id: 's2', name: 'Zweite', count: 3 }, { id: 's1', name: 'Erste', count: 2 }]);
  assert.deepEqual(sel.listSources(withKey, undefined).map(s => s.id).sort(), ['s1', 's2']);
});

test('Beschriftung: Favoriten, Alle Sender, Quelle, Gruppe', () => {
  assert.equal(sel.selectionLabel(undefined), 'Favoriten');
  assert.equal(sel.selectionLabel({ kind: 'all' }), 'Alle Sender');
  assert.equal(sel.selectionLabel({ kind: 'group', value: 'Sport' }), 'Gruppe Sport');
  assert.equal(sel.selectionLabel({ kind: 'source', value: 's1' }, [{ id: 's1', name: 'Kabel' }]), 'Quelle Kabel');
  assert.equal(sel.selectionLabel({ kind: 'source', value: 's9' }, []), 'Quelle s9');
});

test('Ansichtszustand: Auswahl und „ohne EPG ausblenden“ sind Sitzungszustand und überstehen den Moduswechsel', () => {
  const state = model.createViewState();
  assert.deepEqual(state.selection, { kind: 'favorites', value: '' });
  assert.equal(state.showAll, false);
  assert.equal(state.hideNoEpg, true, 'Standard: Sender ohne EPG ausblenden');
  state.setSelection({ kind: 'group', value: 'Sport' });
  state.setHideNoEpg(false);
  state.setDay('2026-10-05');
  state.setAnchor(1234);
  for (const mode of ['grid', 'jng', 'list', 'jng']) {
    assert.equal(state.setMode(mode), true);
    assert.deepEqual(state.selection, { kind: 'group', value: 'Sport' });
    assert.equal(state.hideNoEpg, false);
    assert.equal(state.dayKey, '2026-10-05');
    assert.equal(state.anchorMs, 1234);
  }
  assert.equal(state.showAll, true, 'Gruppe ist nicht Favoriten');
  assert.equal(state.setMode('x'), false);
  assert.equal(state.mode, 'jng');
  state.setShowAll(true);
  assert.deepEqual(state.selection, { kind: 'all', value: '' });
  state.setShowAll(false);
  assert.deepEqual(state.selection, { kind: 'favorites', value: '' });
  state.setSelection('kaputt');
  assert.deepEqual(state.selection, { kind: 'favorites', value: '' });
  assert.deepEqual(model.createViewState({ showAll: true }).selection, { kind: 'all', value: '' });
});

test('Raster: „Sender ohne EPG ausblenden“ an → nur Sender mit EPG, aus → alle gewählten Sender', () => {
  const entries = pick({ kind: 'all' });
  const epgKeys = new Set(['a.de', 'c.de']);
  assert.deepEqual(gridModel.gridRowsFor(entries, epgKeys).map(e => e.channel.id), ['a', 'c']);
  assert.deepEqual(gridModel.gridRowsFor(entries, null).map(e => e.channel.id), ['a', 'b', 'c', 'd']);
  assert.notEqual(gridModel.gridRowsFor(entries, null), entries, 'Kopie, keine Mutation der Auswahl');
});
