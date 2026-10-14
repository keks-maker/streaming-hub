'use strict';

// Tests: Radio-Dashboard-Modell (R2) — Favoriten in globaler Reihenfolge, Kachelzustände, Klickaktionen,
// Leerzustand, Standardfavoriten — und die Ansicht (Fake-DOM): Klick = Play, erneut = Pause, textContent statt innerHTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../radio-dashboard-model.js');
const { createRadioDashboard } = require('../radio-dashboard-view.js');
const { makeDoc, makeFakeRadio } = require('./helpers/fake-dom.js');

const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'radiosources.json'), 'utf8'));

const SOURCES = [
  {
    id: 'a',
    name: 'Quelle A',
    type: 'bundled',
    stations: [
      { id: 'one', name: 'Eins', streamUrl: 'http://x.test/1', genre: 'Pop', logo: 'https://x.test/1.png' },
      { id: 'two', name: 'Zwei', streamUrl: 'http://x.test/2' },
    ],
    favorites: ['one', 'two'],
    favoriteRank: { one: 1, two: 2 },
  },
  {
    id: 'eigene-radiosender',
    name: 'Eigene Sender',
    type: 'user',
    stations: [{ id: 'mine', name: 'Mein Sender', streamUrl: 'http://lan.test/s', genre: 'Rock' }],
    favorites: ['mine'],
    favoriteRank: { mine: 0 },
  },
];
const IDLE = { status: 'idle', station: null, volume: 0.8, nowPlaying: null, error: null, reconnecting: false };
const stateFor = (id, status, extra = {}) => ({ ...IDLE, status, station: { sourceId: 'a', id, name: id }, ...extra });

test('Favoriten erscheinen in globaler Reihenfolge (favoriteRank über Quellen hinweg)', () => {
  const m = model.radioDashboardModel({ sources: SOURCES, state: IDLE });
  assert.deepEqual(m.tiles.map(t => t.id), ['mine', 'one', 'two']);
  assert.equal(m.count, 3);
  assert.equal(m.countText, '3 Favoriten');
  assert.equal(m.empty, false);
  assert.equal(m.popular, 0);
});

test('Statuszeile: Singular und Null', () => {
  assert.equal(model.favoriteCountText(1), '1 Favorit');
  assert.equal(model.favoriteCountText(0), '0 Favoriten');
  assert.equal(model.favoriteCountText(undefined), '0 Favoriten');
});

test('Kachel: Logo nur http(s) ohne Zugangsdaten, sonst Platzhalter mit Anfangsbuchstabe', () => {
  assert.equal(model.safeLogoUrl('https://x.test/1.png'), 'https://x.test/1.png');
  assert.equal(model.safeLogoUrl('javascript:alert(1)'), null);
  assert.equal(model.safeLogoUrl('https://u:p@x.test/a.png'), null);
  assert.equal(model.safeLogoUrl(''), null);
  const tiles = model.radioDashboardModel({ sources: SOURCES, state: IDLE }).tiles;
  const mine = tiles.find(t => t.id === 'mine');
  assert.equal(mine.logo, null);
  assert.equal(mine.initial, 'M');
  assert.equal(mine.meta, 'Rock');
  assert.equal(tiles.find(t => t.id === 'two').meta, 'Radio');
});

test('Kachelzustand und Klickaktion: Play → Pause → Fortsetzen, Verbinden abbrechen, Fehler = erneut versuchen', () => {
  const pick = state => model.radioDashboardModel({ sources: SOURCES, state }).tiles.find(t => t.id === 'one');
  assert.deepEqual([pick(IDLE).state, pick(IDLE).action], ['idle', 'play']);
  assert.deepEqual([pick(stateFor('one', 'loading')).state, pick(stateFor('one', 'loading')).action], ['loading', 'stop']);
  assert.deepEqual([pick(stateFor('one', 'playing')).state, pick(stateFor('one', 'playing')).action], ['playing', 'pause']);
  assert.deepEqual([pick(stateFor('one', 'paused')).state, pick(stateFor('one', 'paused')).action], ['paused', 'resume']);
  const err = pick(stateFor('one', 'error', { error: 'Zeitüberschreitung' }));
  assert.deepEqual([err.state, err.action, err.active], ['error', 'play', true]);
  assert.equal(err.meta, 'Fehler: Zeitüberschreitung');
  // andere Sender bleiben idle
  const other = model.radioDashboardModel({ sources: SOURCES, state: stateFor('one', 'playing') }).tiles.find(t => t.id === 'two');
  assert.deepEqual([other.state, other.active, other.action], ['idle', false, 'play']);
});

test('aktive Kachel zeigt laufenden Titel (Interpret – Titel), sonst Genre; pausiert = „Pausiert“', () => {
  const tile = state => model.radioDashboardModel({ sources: SOURCES, state }).tiles.find(t => t.id === 'one');
  assert.equal(tile(stateFor('one', 'playing', { nowPlaying: { artist: 'A', title: 'T' } })).meta, 'A – T');
  assert.equal(tile(stateFor('one', 'playing', { nowPlaying: { artist: '', title: 'Nur Titel' } })).meta, 'Nur Titel');
  assert.equal(tile(stateFor('one', 'playing')).meta, 'Pop');
  assert.equal(tile(stateFor('one', 'paused')).meta, 'Pausiert');
  assert.equal(tile(stateFor('one', 'loading', { reconnecting: true })).meta, 'Verbindung wird neu aufgebaut …');
  assert.equal(tile(stateFor('one', 'playing')).ariaLabel, 'Eins, Pop – pausieren');
  assert.equal(tile({ ...IDLE }).ariaLabel, 'Eins – abspielen');
});

test('Leerzustand: Standardfavoriten 5–8 aus den vorhandenen Sendern, nur wenn keine Favoriten existieren', () => {
  const empty = bundled.map(s => ({ ...s, favorites: [], favoriteRank: {} }));
  const m = model.radioDashboardModel({ sources: empty, state: IDLE });
  assert.equal(m.empty, true);
  assert.ok(m.popular >= 5 && m.popular <= 8, `popular=${m.popular}`);
  const keys = model.popularFavoriteKeys(empty);
  assert.equal(new Set(keys.map(k => k.stationId)).size, keys.length);
  assert.ok(keys.every(k => k.sourceId === 'deutsche-radiosender'));
  assert.match(m.emptyHint, /Senderverwaltung/);
});

test('Standardfavoriten: fehlende Vorschlagssender werden aufgefüllt; unter 5 Treffern keine Liste', () => {
  const trimmed = [{ id: 'deutsche-radiosender', name: 'D', stations: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map(id => ({ id, name: id, streamUrl: 'http://x.test/' + id })) }];
  assert.equal(model.popularFavoriteKeys(trimmed).length, 5);
  assert.deepEqual(model.popularFavoriteKeys([{ id: 'deutsche-radiosender', stations: [{ id: '1live', name: 'a', streamUrl: 'http://x.test/' }] }]), []);
  assert.deepEqual(model.popularFavoriteKeys(undefined), []);
  assert.equal(model.radioDashboardModel({ sources: [], state: IDLE }).popular, 0);
});

test('favoriteCountOf zählt Favoriten; ungültige Eingabe ergibt 0', () => {
  assert.equal(model.favoriteCountOf(SOURCES), 3);
  assert.equal(model.favoriteCountOf(null), 0);
});

// ───────── Ansicht (Fake-DOM) ─────────

function setup({ sources = SOURCES, state = IDLE, onOpenManagement = () => {} } = {}) {
  const doc = makeDoc();
  const root = doc.createElement('div');
  const radio = makeFakeRadio({ sources, state });
  const notes = [];
  const view = createRadioDashboard(root, { radio, onOpenManagement, notify: m => notes.push(m), logger: { warn: () => {} } });
  return { root, radio, view, notes };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Ansicht: Kacheln in Reihenfolge mit Name/Genre per textContent, Statuszeile, Zustand per data-state', async () => {
  const { root, view } = setup();
  await view.refresh();
  const tiles = root.byClass('radio-tile');
  assert.deepEqual(tiles.map(t => t.dataset.stationId), ['mine', 'one', 'two']);
  assert.equal(root.byId('radioStatus').textContent, '3 Favoriten');
  assert.equal(root.byId('radioEmpty').hidden, true);
  assert.equal(root.byId('radioGrid').hidden, false);
  assert.equal(tiles[1].byClass('dashboard-tile-name')[0].textContent, 'Eins');
  assert.equal(tiles[1].byClass('dashboard-tile-meta')[0].textContent, 'Pop');
  assert.ok(tiles.every(t => t.dataset.state === 'idle'));
});

test('Ansicht: Klick = Play, bei Wiedergabe erneut = Pause, bei Pause = Fortsetzen', async () => {
  const { root, radio, view } = setup();
  await view.refresh();
  root.byClass('radio-tile')[1].click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['play', { sourceId: 'a', stationId: 'one' }]);
  radio.emitState(stateFor('one', 'playing'));
  const active = root.byClass('radio-tile')[1];
  assert.equal(active.dataset.state, 'playing');
  assert.ok(active.classList.contains('is-active'));
  active.click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['pause']);
  radio.emitState(stateFor('one', 'paused'));
  root.byClass('radio-tile')[1].click();
  await tick();
  assert.deepEqual(radio.calls.at(-1), ['play', undefined]);
  radio.emitState(stateFor('one', 'error', { error: 'kaputt' }));
  assert.equal(root.byClass('radio-tile')[1].dataset.state, 'error');
  assert.ok(root.byClass('radio-tile')[1].classList.contains('is-error'));
});

test('Ansicht: Zustandswechsel baut das Raster nicht neu auf (Fokus bleibt), Quellenänderung schon', async () => {
  const { root, radio, view } = setup();
  await view.refresh();
  const before = root.byClass('radio-tile')[0];
  radio.emitState(stateFor('one', 'loading'));
  assert.equal(root.byClass('radio-tile')[0], before);
  radio.emitSources([SOURCES[0]]);
  assert.deepEqual(root.byClass('radio-tile').map(t => t.dataset.stationId), ['one', 'two']);
  assert.equal(root.byId('radioStatus').textContent, '2 Favoriten');
});

test('Ansicht: Logo-Ladefehler entfernt das Bild und zeigt den Platzhalter; Nutzerdaten nie als innerHTML', async () => {
  const evil = [{ id: 'eigene-radiosender', name: 'E', stations: [{ id: 'x', name: '<img src=x onerror=alert(1)>', streamUrl: 'http://a.test/s', logo: 'https://l.test/a.png' }], favorites: ['x'], favoriteRank: { x: 0 } }];
  const { root, view } = setup({ sources: evil });
  await view.refresh();
  const tile = root.byClass('radio-tile')[0];
  assert.equal(tile.byClass('dashboard-tile-name')[0].textContent, '<img src=x onerror=alert(1)>');
  const icon = tile.byClass('dashboard-tile-icon')[0];
  const image = icon.find(n => n.tagName === 'img')[0];
  assert.equal(image.src, 'https://l.test/a.png');
  image.dispatch('error');
  assert.ok(icon.classList.contains('has-error'));
  assert.equal(icon.find(n => n.tagName === 'img').length, 0);
  assert.ok(root.find(n => n.innerHTML && n.innerHTML.includes('onerror')).length === 0);
});

test('Ansicht Leerzustand: Hinweis, Button „Beliebte Sender hinzufügen“ setzt Favoriten erst auf Klick', async () => {
  const empty = bundled.map(s => ({ ...s, favorites: [], favoriteRank: {} }));
  const { root, radio, view } = setup({ sources: empty });
  await view.refresh();
  assert.equal(root.byId('radioEmpty').hidden, false);
  assert.equal(root.byId('radioGrid').hidden, true);
  assert.equal(root.byId('radioStatus').textContent, '0 Favoriten');
  assert.match(root.byId('radioEmpty').textContent, /Senderverwaltung/);
  assert.equal(radio.calls.length, 0, 'ohne Klick keine Favoriten');
  const button = root.byId('radioAddPopular');
  assert.equal(button.hidden, false);
  button.click();
  await tick();
  await tick();
  const set = radio.calls.filter(c => c[0] === 'setFavorite');
  assert.ok(set.length >= 5 && set.length <= 8);
  assert.ok(set.every(c => c[2] === true));
  assert.equal(button.disabled, false);
});

test('Ansicht: Senderverwaltung ruft das konfigurierbare Ziel; Fehler der Steuerung erscheinen als Hinweis', async () => {
  let opened = 0;
  const { root, radio, view, notes } = setup({ onOpenManagement: () => (opened += 1) });
  await view.refresh();
  root.byId('radioManage').click();
  assert.equal(opened, 1);
  assert.equal(root.byId('radioManage').byClass('dashboard-hub-tool-label')[0].textContent, 'Senderverwaltung');
  radio.play = async () => {
    throw new Error('Sender nicht gefunden');
  };
  root.byClass('radio-tile')[0].click();
  await tick();
  assert.deepEqual(notes, ['Radio: Sender nicht gefunden']);
});

test('Ansicht: dispose löst alle Listener', () => {
  const { radio, view } = setup();
  assert.equal(radio.listenerCount(), 2);
  view.dispose();
  assert.equal(radio.listenerCount(), 0);
});
