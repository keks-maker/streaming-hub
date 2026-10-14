'use strict';

// Tests: Radio-Einstellungsseiten R3 (Ansichten) mit Fake-DOM und einer Attrappe für window.radio, die die echte
// Quellenlogik nutzt: Suche, Sterne, Reihenfolge (▲▼, Drop), Vorhören, Anpassen, eigene Sender (Prüfen, Fehler),
// Wiedergabe-Schalter. Kein Browser, kein Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../lib/radio/radio-sources-logic.js');
const { createRadioStationsView } = require('../settings-radio-stations.js');
const { createRadioCustomView } = require('../settings-radio-custom.js');
const { createRadioPlaybackView } = require('../settings-radio-playback.js');
const { makeDoc } = require('./helpers/fake-dom.js');

const tick = () => new Promise(resolve => setImmediate(resolve));

function initialSources() {
  return logic.ensureCustomSource([
    {
      id: 'de',
      name: 'Deutsche Radiosender',
      type: 'bundled',
      stations: [
        { id: 'one', name: 'Eins <b>', streamUrl: 'http://one.test/s', genre: 'Pop', region: 'NRW' },
        { id: 'two', name: 'Zwei', streamUrl: 'http://two.test/s', genre: 'Rock', region: 'Bayern' },
        { id: 'three', name: 'Drei', streamUrl: 'http://three.test/s', genre: 'Pop', region: 'Bayern' },
        { id: 'gone', name: 'Weg', streamUrl: 'http://gone.test/s', genre: 'Pop', region: 'NRW', removed: true },
      ],
      favorites: ['one', 'two', 'gone'],
      favoriteRank: { one: 0, two: 1, gone: 2 },
    },
  ]);
}

/** window.radio-Attrappe über der echten Quellenlogik; protokolliert Aufrufe. */
function makeRadio({ probe, sources = initialSources(), settings } = {}) {
  const calls = [];
  const listeners = { sources: new Set(), state: new Set() };
  const radio = {
    calls,
    sources,
    state: { status: 'idle', station: null, volume: 0.6 },
    settings: { volume: 0.6, resumeOnStart: false, pauseOnTv: true, keepPlayingWhenClosed: true, lastStation: null, ...settings },
    getSources: async () => radio.sources,
    getState: async () => radio.state,
    getSettings: async () => radio.settings,
    setSettings: async patch => {
      calls.push(['setSettings', patch]);
      if (radio.failSettings) throw new Error("Error invoking remote method 'radio:set-settings': Error: kaputt");
      radio.settings = { ...radio.settings, ...patch };
      return radio.settings;
    },
    setVolume: async value => calls.push(['setVolume', value]),
    commit(next) {
      radio.sources = next;
      listeners.sources.forEach(cb => cb(next));
      return next;
    },
    setFavorite: async (key, flag) => {
      calls.push(['setFavorite', key, flag]);
      return radio.commit(logic.setStationFavorite(radio.sources, key.sourceId, key.stationId, flag));
    },
    setFavoriteOrder: async list => {
      calls.push(['setFavoriteOrder', list]);
      return radio.commit(logic.setFavoriteOrder(radio.sources, list));
    },
    setOverride: async (key, patch) => {
      calls.push(['setOverride', key, patch]);
      return radio.commit(logic.setStationOverride(radio.sources, key.sourceId, key.stationId, patch));
    },
    clearOverride: async key => {
      calls.push(['clearOverride', key]);
      return radio.commit(logic.clearStationOverride(radio.sources, key.sourceId, key.stationId));
    },
    addCustom: async input => {
      calls.push(['addCustom', input]);
      const result = logic.addCustomStation(radio.sources, input);
      radio.commit(result.sources);
      return result;
    },
    updateCustom: async (id, patch) => {
      calls.push(['updateCustom', id, patch]);
      return radio.commit(logic.updateCustomStation(radio.sources, id, patch));
    },
    removeCustom: async id => {
      calls.push(['removeCustom', id]);
      return radio.commit(logic.removeCustomStation(radio.sources, id));
    },
    probe: async url => {
      calls.push(['probe', url]);
      return probe ? probe(url) : { ok: true, kind: 'direct', contentType: 'audio/mpeg' };
    },
    play: async key => calls.push(['play', key]),
    stop: async () => calls.push(['stop']),
    onSourcesChanged: cb => {
      listeners.sources.add(cb);
      return () => listeners.sources.delete(cb);
    },
    onState: cb => {
      listeners.state.add(cb);
      return () => listeners.state.delete(cb);
    },
    emitState: next => {
      radio.state = next;
      listeners.state.forEach(cb => cb(next));
    },
    listenerCount: () => listeners.sources.size + listeners.state.size,
  };
  return radio;
}

function mount(create, options) {
  const doc = makeDoc();
  const root = doc.createElement('div');
  root.ownerDocument = doc;
  const radio = options.radio || makeRadio();
  const view = create(root, { ...options, radio });
  return { root, view, radio, doc };
}

const byId = (root, id) => root.byId(id);
const rows = root => root.byId('settingsRadioList').children.filter(r => r.dataset.key);
const rowNames = root => rows(root).map(r => r.byClass('settings-chan-name')[0].textContent);
const action = (node, name) => node.find(n => n.dataset && n.dataset.action === name)[0];
const field = (node, name) => node.find(n => n.dataset && n.dataset.field === name)[0];
const type = (input, value) => {
  input.value = value;
  input.dispatch('input');
};
const submit = root => root.find(n => n.tagName === 'form')[0].dispatch('submit', { preventDefault() {} });

// ───────── Sender ─────────

test('Sender: Liste mit Namen als Text, Zähler, Favoritenmarkierung und „nicht mehr in der Liste“', async () => {
  const { root, view } = mount(createRadioStationsView, {});
  await view.refresh();
  assert.deepEqual(rowNames(root), ['Eins <b>', 'Zwei', 'Drei', 'Weg']);
  assert.equal(byId(root, 'settingsRadioCount').textContent, '4 Sender');
  assert.equal(rows(root)[0].byClass('settings-chan-name')[0].children.length, 0, 'Name nur als Text, keine Kindelemente');
  assert.ok(rows(root)[3].textContent.includes('nicht mehr in der Liste'));
  assert.ok(!rows(root)[2].textContent.includes('nicht mehr in der Liste'));
  assert.equal(action(rows(root)[0], 'fav').getAttribute('aria-pressed'), 'true');
  assert.equal(action(rows(root)[2], 'fav').getAttribute('aria-pressed'), 'false');
  assert.match(action(rows(root)[0], 'fav').getAttribute('aria-label'), /Eins <b>: aus Favoriten entfernen/);
});

test('Sender: Suche (Name, Genre, Region), Filter und Zähler „n von m“', async () => {
  const { root, view } = mount(createRadioStationsView, {});
  await view.refresh();
  type(byId(root, 'settingsRadioSearch'), 'rock');
  assert.deepEqual(rowNames(root), ['Zwei']);
  assert.equal(byId(root, 'settingsRadioCount').textContent, '1 von 4 Sendern');
  type(byId(root, 'settingsRadioSearch'), '');
  const region = byId(root, 'settingsRadioFilter-region');
  region.value = 'Bayern';
  region.dispatch('change');
  assert.deepEqual(rowNames(root), ['Zwei', 'Drei']);
  const genre = byId(root, 'settingsRadioFilter-genre');
  genre.value = 'Pop';
  genre.dispatch('change');
  assert.deepEqual(rowNames(root), ['Drei']);
  assert.ok(byId(root, 'settingsRadioFilter-genre').children.some(o => o.textContent === 'Rock'), 'Filterwerte kommen aus allen Sendern');
  type(byId(root, 'settingsRadioSearch'), 'nichts');
  assert.deepEqual(rowNames(root), []);
  assert.match(byId(root, 'settingsRadioList').textContent, /Keine Sender gefunden/);
});

test('Sender: Stern ruft setFavorite mit Schlüssel; die Liste folgt dem Ergebnis', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  action(rows(root)[2], 'fav').click();
  await tick();
  assert.deepEqual(radio.calls[0], ['setFavorite', { sourceId: 'de', stationId: 'three' }, true]);
  assert.equal(action(rows(root)[2], 'fav').getAttribute('aria-pressed'), 'true');
  action(rows(root)[0], 'fav').click();
  await tick();
  assert.deepEqual(radio.calls[1], ['setFavorite', { sourceId: 'de', stationId: 'one' }, false]);
});

test('Sender: Favoriten-Tab mit „Reihenfolge bearbeiten“; ▲▼ speichern die globale Reihenfolge', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  assert.equal(byId(root, 'settingsRadioReorder').hidden, true, 'nur im Favoriten-Tab');
  byId(root, 'settingsRadioViewFav').click();
  assert.deepEqual(rowNames(root), ['Eins <b>', 'Zwei', 'Weg']);
  assert.equal(byId(root, 'settingsRadioCount').textContent, '3 Sender');
  assert.equal(action(rows(root)[0], 'up'), undefined, 'ohne Bearbeitungsmodus keine Pfeile');
  assert.equal(byId(root, 'settingsRadioReorder').hidden, false);
  byId(root, 'settingsRadioReorder').click();
  assert.equal(byId(root, 'settingsRadioReorder').getAttribute('aria-pressed'), 'true');
  assert.equal(action(rows(root)[0], 'up').disabled, true);
  action(rows(root)[0], 'down').click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['setFavoriteOrder', [{ sourceId: 'de', id: 'two' }, { sourceId: 'de', id: 'one' }, { sourceId: 'de', id: 'gone' }]]);
  assert.deepEqual(rowNames(root), ['Zwei', 'Eins <b>', 'Weg']);
  // Der Geist-Favorit am Ende lässt sich nicht an einem sichtbaren Sender vorbeischieben
  assert.equal(action(rows(root)[1], 'down').disabled, true);
});

test('Sender: Umsortieren per Drag&Drop (Drop auf Zielzeile) und bei aktiver Suche abgeschaltet', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  byId(root, 'settingsRadioViewFav').click();
  byId(root, 'settingsRadioReorder').click();
  const target = rows(root)[0];
  const data = { 'text/plain': 'de\u0000two' };
  target.dispatch('drop', { preventDefault() {}, dataTransfer: { getData: type => data[type] } });
  await tick();
  assert.deepEqual(radio.calls.at(-1)[1].map(e => e.id), ['two', 'one', 'gone']);
  type(byId(root, 'settingsRadioSearch'), 'zwei');
  assert.equal(byId(root, 'settingsRadioReorder').disabled, true);
  assert.equal(action(rows(root)[0], 'down'), undefined);
});

test('Sender: Vorhören startet per play und stoppt per stop; Zustand färbt den Button', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  const preview = () => action(rows(root)[1], 'preview');
  assert.equal(preview().getAttribute('aria-pressed'), 'false');
  preview().click();
  await tick();
  assert.deepEqual(radio.calls[0], ['play', { sourceId: 'de', stationId: 'two' }]);
  radio.emitState({ status: 'playing', station: { sourceId: 'de', id: 'two', name: 'Zwei' }, volume: 0.6 });
  assert.equal(preview().getAttribute('aria-pressed'), 'true');
  assert.match(preview().getAttribute('aria-label'), /Vorhören beenden/);
  preview().click();
  await tick();
  assert.deepEqual(radio.calls[1], ['stop']);
  radio.emitState({ status: 'idle', station: null, volume: 0.6 });
  assert.equal(preview().getAttribute('aria-pressed'), 'false');
});

test('Sender: Anpassen speichert nur Abweichungen als Override; Zurücksetzen löscht sie', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  action(rows(root)[1], 'edit').click();
  assert.equal(field(root, 'name').value, 'Zwei');
  assert.equal(field(root, 'streamUrl').value, 'http://two.test/s');
  assert.equal(action(root, 'reset').disabled, true, 'noch keine Anpassung');
  type(field(root, 'name'), 'Zwei neu');
  type(field(root, 'logo'), 'https://logo.test/z.png');
  submit(root);
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['setOverride', { sourceId: 'de', stationId: 'two' }, { name: 'Zwei neu', logo: 'https://logo.test/z.png', streamUrl: null }]);
  assert.deepEqual(rowNames(root), ['Eins <b>', 'Zwei neu', 'Drei', 'Weg']);
  assert.ok(rows(root)[1].textContent.includes('angepasst'));
  assert.match(byId(root, 'settingsRadioStatus').textContent, /Sender gespeichert/);
  action(rows(root)[1], 'edit').click();
  assert.equal(action(root, 'reset').disabled, false);
  action(root, 'reset').click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['clearOverride', { sourceId: 'de', stationId: 'two' }]);
  assert.deepEqual(rowNames(root), ['Eins <b>', 'Zwei', 'Drei', 'Weg']);
});

test('Sender: ungültige URL im Anpassen-Formular wird markiert und nicht gesendet', async () => {
  const { root, view, radio } = mount(createRadioStationsView, {});
  await view.refresh();
  action(rows(root)[0], 'edit').click();
  type(field(root, 'streamUrl'), 'ftp://x.test/s');
  submit(root);
  await tick();
  assert.equal(radio.calls.length, 0);
  assert.equal(field(root, 'streamUrl').getAttribute('aria-invalid'), 'true');
  assert.match(root.byClass('settings-chan-error')[0].textContent, /http:\/\/ oder https:\/\//);
  assert.equal(byId(root, 'settingsRadioStatus').classList.contains('error'), true);
  assert.equal(byId(root, 'settingsRadioStatus').getAttribute('role'), 'status');
});

test('Sender: Bearbeiten eines eigenen Senders springt zu „Eigene Sender“', async () => {
  const added = logic.addCustomStation(initialSources(), { name: 'Mein', streamUrl: 'http://m.test/s' });
  const jumps = [];
  const { root, view } = mount(createRadioStationsView, { radio: makeRadio({ sources: added.sources }), onEditCustom: id => jumps.push(id) });
  await view.refresh();
  const mine = rows(root).find(r => r.textContent.includes('Mein'));
  action(mine, 'edit').click();
  assert.deepEqual(jumps, [added.station.id]);
});

test('Sender: dispose meldet alle Listener ab', async () => {
  const { view, radio } = mount(createRadioStationsView, {});
  assert.equal(radio.listenerCount(), 2);
  view.dispose();
  assert.equal(radio.listenerCount(), 0);
});

// ───────── Eigene Sender ─────────

const customList = root => byId(root, 'settingsRadioCustomList').children.filter(r => r.dataset.key);

test('Eigene Sender: Leerzustand, Hinzufügen mit Prüfen, Genre-Vorschläge', async () => {
  const { root, view, radio } = mount(createRadioCustomView, {});
  await view.refresh();
  assert.match(byId(root, 'settingsRadioCustomList').textContent, /Noch keine eigenen Sender/);
  byId(root, 'settingsRadioCustomAdd').click();
  assert.equal(byId(root, 'settingsRadioCustomAdd').hidden, true);
  assert.ok(byId(root, 'settingsRadioGenres').children.some(o => o.value === 'Jazz'));
  type(field(root, 'name'), 'Testradio');
  type(field(root, 'streamUrl'), 'http://localhost:9000/live.mp3');
  type(field(root, 'genre'), 'Rock');
  action(root, 'probe').click();
  await tick();
  assert.deepEqual(radio.calls[0], ['probe', 'http://localhost:9000/live.mp3']);
  const result = byId(root, 'settingsRadioProbeResult');
  assert.equal(result.textContent, 'Erreichbar · Format: MP3');
  assert.equal(result.getAttribute('aria-live'), 'polite');
  assert.equal(result.classList.contains('ok'), true);
  submit(root);
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['addCustom', { name: 'Testradio', streamUrl: 'http://localhost:9000/live.mp3', genre: 'Rock' }]);
  assert.deepEqual(customList(root).map(r => r.byClass('settings-chan-name')[0].textContent), ['Testradio']);
  assert.match(byId(root, 'settingsRadioCustomStatus').textContent, /hinzugefügt/);
  assert.equal(byId(root, 'settingsRadioCustomAdd').hidden, false);
});

test('Eigene Sender: Pflichtfelder und ungültige URL werden angezeigt, nichts wird gesendet', async () => {
  const { root, view, radio } = mount(createRadioCustomView, {});
  await view.refresh();
  byId(root, 'settingsRadioCustomAdd').click();
  submit(root);
  await tick();
  const errors = root.byClass('settings-chan-error').map(n => n.textContent);
  assert.deepEqual(errors, ['Bitte einen Namen eingeben', 'Bitte eine Stream-URL eingeben']);
  assert.equal(field(root, 'name').getAttribute('aria-invalid'), 'true');
  type(field(root, 'name'), 'X');
  type(field(root, 'streamUrl'), 'javascript:alert(1)');
  submit(root);
  assert.match(root.byClass('settings-chan-error')[0].textContent, /http:\/\/ oder https:\/\//);
  assert.equal(radio.calls.length, 0);
});

test('Eigene Sender: Prüfen ohne gültige URL fragt den Main nicht; Fehlschlag zeigt Klartext', async () => {
  const { root, view, radio } = mount(createRadioCustomView, { radio: makeRadio({ probe: () => ({ ok: false, error: 'Server antwortet mit HTTP 404' }) }) });
  await view.refresh();
  byId(root, 'settingsRadioCustomAdd').click();
  action(root, 'probe').click();
  await tick();
  assert.equal(radio.calls.length, 0);
  assert.match(root.byClass('settings-chan-error')[0].textContent, /Stream-URL/);
  type(field(root, 'name'), 'N');
  type(field(root, 'streamUrl'), 'http://x.test/s');
  action(root, 'probe').click();
  await tick();
  const result = byId(root, 'settingsRadioProbeResult');
  assert.equal(result.textContent, 'Nicht erreichbar: Server antwortet mit HTTP 404');
  assert.equal(result.classList.contains('error'), true);
  // Ändert sich die URL, gilt das Ergebnis nicht mehr
  type(field(root, 'streamUrl'), 'http://y.test/s');
  assert.equal(byId(root, 'settingsRadioProbeResult').textContent, '');
});

test('Eigene Sender: Fehlermeldung des Main erscheint am Formular, Eingaben bleiben erhalten', async () => {
  const radio = makeRadio();
  radio.addCustom = async () => {
    throw new Error("Error invoking remote method 'radio:add-custom': Error: Stream-URL darf keine Zugangsdaten enthalten");
  };
  const { root, view } = mount(createRadioCustomView, { radio });
  await view.refresh();
  byId(root, 'settingsRadioCustomAdd').click();
  type(field(root, 'name'), 'Neu');
  type(field(root, 'streamUrl'), 'http://x.test/s');
  submit(root);
  await tick();
  const alert = root.find(n => n.getAttribute && n.getAttribute('role') === 'alert' && /Zugangsdaten/.test(n.textContent));
  assert.equal(alert.length, 1);
  assert.equal(alert[0].textContent, 'Stream-URL darf keine Zugangsdaten enthalten');
  assert.equal(field(root, 'name').value, 'Neu');
});

test('Eigene Sender: Bearbeiten sendet nur Änderungen, Löschen verlangt Bestätigung', async () => {
  const seeded = logic.addCustomStation(initialSources(), { name: 'Alt', streamUrl: 'http://alt.test/s', genre: 'Pop' });
  const { root, view, radio } = mount(createRadioCustomView, { radio: makeRadio({ sources: seeded.sources }) });
  await view.refresh();
  action(customList(root)[0], 'edit').click();
  assert.equal(field(root, 'name').value, 'Alt');
  type(field(root, 'name'), 'Neu');
  type(field(root, 'genre'), '');
  submit(root);
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['updateCustom', seeded.station.id, { name: 'Neu', genre: '' }]);
  action(customList(root)[0], 'remove').click();
  assert.equal(radio.calls.filter(c => c[0] === 'removeCustom').length, 0, 'erst nach Bestätigung');
  action(customList(root)[0], 'confirm-remove').click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['removeCustom', seeded.station.id]);
  assert.equal(customList(root).length, 0);
});

test('Eigene Sender: Namen und URLs nur als Text (kein HTML)', async () => {
  const seeded = logic.addCustomStation(initialSources(), { name: '<img src=x onerror=alert(1)>', streamUrl: 'http://x.test/s' });
  const { root, view } = mount(createRadioCustomView, { radio: makeRadio({ sources: seeded.sources }) });
  await view.refresh();
  const name = customList(root)[0].byClass('settings-chan-name')[0];
  assert.equal(name.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(name.children.length, 0);
});

test('Eigene Sender: edit(id) öffnet das Formular vorbefüllt', async () => {
  const seeded = logic.addCustomStation(initialSources(), { name: 'Sprung', streamUrl: 'http://s.test/s' });
  const { root, view } = mount(createRadioCustomView, { radio: makeRadio({ sources: seeded.sources }) });
  await view.refresh();
  view.edit(seeded.station.id);
  assert.equal(field(root, 'name').value, 'Sprung');
});

// ───────── Wiedergabe ─────────

test('Wiedergabe: Schalter laden und speichern über setSettings; Lautstärke über setVolume', async () => {
  const { root, view, radio } = mount(createRadioPlaybackView, { radio: makeRadio({ settings: { resumeOnStart: true } }) });
  await view.refresh();
  assert.equal(byId(root, 'settingsRadio-resumeOnStart').checked, true);
  assert.equal(byId(root, 'settingsRadio-pauseOnTv').checked, true);
  assert.equal(byId(root, 'settingsRadio-keepPlayingWhenClosed').checked, true);
  assert.equal(byId(root, 'settingsRadioVolume').value, '60');
  assert.equal(byId(root, 'settingsRadioVolumeValue').textContent, '60 %');
  const pause = byId(root, 'settingsRadio-pauseOnTv');
  pause.checked = false;
  pause.dispatch('change');
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['setSettings', { pauseOnTv: false }]);
  assert.match(byId(root, 'settingsRadioPlaybackStatus').textContent, /Gespeichert/);
  const slider = byId(root, 'settingsRadioVolume');
  slider.value = '25';
  slider.dispatch('input');
  assert.equal(byId(root, 'settingsRadioVolumeValue').textContent, '25 %');
  slider.dispatch('change');
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['setVolume', 0.25]);
  // Hinweis zum Tray ist mit der Option verknüpft
  assert.match(byId(root, 'settingsRadio-keepPlayingWhenClosed-hint').textContent, /Tray/);
  assert.equal(byId(root, 'settingsRadio-keepPlayingWhenClosed').getAttribute('aria-describedby'), 'settingsRadio-keepPlayingWhenClosed-hint');
});

test('Wiedergabe: Speicherfehler setzt den Schalter zurück und zeigt Klartext', async () => {
  const radio = makeRadio();
  radio.failSettings = true;
  const { root, view } = mount(createRadioPlaybackView, { radio });
  await view.refresh();
  const box = byId(root, 'settingsRadio-resumeOnStart');
  box.checked = true;
  box.dispatch('change');
  await tick();
  assert.equal(box.checked, false);
  assert.equal(byId(root, 'settingsRadioPlaybackStatus').textContent, 'kaputt');
  assert.equal(byId(root, 'settingsRadioPlaybackStatus').classList.contains('error'), true);
});

test('Wiedergabe: Lautstärke folgt dem Radio-Zustand (z. B. Mini-Player)', async () => {
  const { root, view, radio } = mount(createRadioPlaybackView, {});
  await view.refresh();
  radio.emitState({ status: 'playing', station: null, volume: 0.9 });
  assert.equal(byId(root, 'settingsRadioVolume').value, '90');
});

test('Eigene Sender: Fehlermeldung verschwindet, sobald das Feld geändert wird', async () => {
  const { root, view } = mount(createRadioCustomView, {});
  await view.refresh();
  byId(root, 'settingsRadioCustomAdd').click();
  submit(root);
  assert.equal(root.byClass('settings-chan-error').length, 2);
  type(field(root, 'name'), 'Neu');
  assert.deepEqual(root.byClass('settings-chan-error').map(n => n.textContent), ['Bitte eine Stream-URL eingeben']);
  assert.equal(byId(root, 'settingsRadioCustomStatus').textContent, '');
});

test('Eigene Sender: korrigiertes Feld bekommt den Fehler auch nach erneutem Rendern nicht zurück', async () => {
  const { root, view } = mount(createRadioCustomView, {});
  await view.refresh();
  byId(root, 'settingsRadioCustomAdd').click();
  submit(root);
  type(field(root, 'name'), 'Neu');
  assert.equal(field(root, 'name').getAttribute('aria-invalid'), undefined);
  // Prüfen ohne URL rendert das Formular neu und behält nur noch gültige Fehlerzustände
  root.byClass('settings-action-btn').find(n => n.textContent === 'Stream prüfen').click();
  await tick();
  assert.equal(field(root, 'name').getAttribute('aria-invalid'), undefined);
  assert.equal(field(root, 'streamUrl').getAttribute('aria-invalid'), 'true');
  assert.equal(root.byClass('settings-chan-error').length, 1);
});
