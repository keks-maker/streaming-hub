'use strict';

// Tests: Kachel von „Jetzt & Gleich“ (epg-jng-tile-dom.js) mit Fake-DOM — Danach-Zeile (Endzeit, Vorschau-Platzhalter),
// Tab-Reihenfolge der laufenden Sendung, Zustands-Reset, Kürzel der Logo-Platte.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDoc } = require('./helpers/fake-dom.js');

const doc = makeDoc();
global.document = doc;
const FakeNode = doc.createElement('x').constructor;
// Das Fake kennt nur find(); querySelector für „.klasse“ und „:scope > .klasse“ ergänzen
FakeNode.prototype.querySelector = function querySelector(selector) {
  const direct = selector.startsWith(':scope > ');
  const cls = selector.replace(':scope > ', '').replace(/^\./, '');
  const list = direct ? this.children : this.find(n => n !== this && n.classList && n.classList.contains(cls));
  return list.find(n => n.classList && n.classList.contains(cls)) || null;
};
FakeNode.prototype.style = { setProperty: () => {} };

const { createTile, fillTile } = require('../epg-jng-tile-dom.js');

const MIN = 60000;
const NOW = new Date(2026, 10, 17, 20, 0, 0).getTime();
const clock = ms => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const row = (id, start, stop, title) => ({ id, start, stop, title, genre: '', channel: { name: 'Kabel Eins' }, channelKey: 'K1' });

function fakeKit() {
  return {
    createMedia(ch, opts) {
      const media = doc.createElement('span');
      media.className = 'tv-tile-media';
      const logo = doc.createElement('button');
      logo.className = 'tv-tile-logo';
      logo.vars = {};
      logo.style = { setProperty: (k, v) => { logo.vars[k] = v; } };
      logo.fallbackText = opts.fallbackText;
      media.appendChild(logo);
      return media;
    },
    attachPreview() {},
    setImage() {},
    createProgress() {
      const bar = doc.createElement('span');
      bar.firstChild = doc.createElement('span');
      return bar;
    },
  };
}

const channel = { key: 'K1', channel: { name: 'Kabel Eins' }, rows: [], hasEpg: true };

function build(assignment) {
  const kit = fakeKit();
  const tile = createTile(channel, kit);
  fillTile(tile, channel, assignment, { filtered: false, kit });
  return { tile, kit };
}

test('Danach-Zeile: „Danach HH:MM–HH:MM · Titel“, aria-label mit Zeitspanne, Vorschau-Platzhalter 64×36', () => {
  const next = row('n', NOW + 30 * MIN, NOW + 75 * MIN, 'Kommende Sendung');
  const { tile } = build({ current: null, next, after: null });
  const line = tile.info.byClass('epg-jnext')[0];
  const open = line.byClass('epg-jnext-open')[0];
  assert.equal(open.textContent, `Danach ${clock(next.start)}–${clock(next.stop)} · Kommende Sendung`);
  assert.equal(open.getAttribute('aria-label'), `Danach ${clock(next.start)}–${clock(next.stop)}: Kommende Sendung`);
  assert.equal(line.byClass('epg-jnext-title')[0].textContent, 'Kommende Sendung');
  const thumb = line.byClass('epg-thumb')[0];
  assert.ok(thumb, 'Vorschau-Platzhalter vorhanden');
  assert.equal(thumb.textContent, 'K');
  assert.equal(tile.cells[1].refs.thumb, thumb, 'setCellThumb findet den Platzhalter über refs.thumb');
});

test('laufende Sendung: Tab-Reihenfolge Titel vor Aufnehmen', () => {
  const current = row('c', NOW - 10 * MIN, NOW + 20 * MIN, 'Laufende Sendung');
  const { tile } = build({ current, next: null, after: null });
  const order = tile.info.children.map(n => n.className.split(' ')[0]);
  assert.ok(order.indexOf('epg-row-open') < order.indexOf('epg-toggle'), order.join(','));
  assert.equal(tile.media.byClass('epg-jrec').length, 0, 'Knopf nicht mehr in der Medienfläche');
});

test('fillTile setzt is-now, is-selected und Phase zurück, wenn die laufende Sendung ersatzlos entfällt', () => {
  const current = row('c', NOW - 10 * MIN, NOW + 20 * MIN, 'Laufende Sendung');
  const { tile, kit } = build({ current, next: null, after: null });
  tile.el.classList.add('is-now', 'is-selected', 'is-past');
  tile.el.dataset.phase = 'now';
  fillTile(tile, channel, { current: null, next: null, after: null }, { filtered: false, kit });
  for (const name of ['is-now', 'is-selected', 'is-past', 'has-current']) assert.equal(tile.el.classList.contains(name), false, name);
  assert.equal(tile.el.dataset.phase, undefined);
  assert.equal(tile.cells[0], null);
});

test('leerer Zustand: Hinweistext trägt title (bei schmaler Kachel abgeschnitten lesbar)', () => {
  const { tile } = build({ current: null, next: null, after: null });
  const empty = tile.info.byClass('is-empty')[0];
  assert.equal(empty.title, '');
  assert.equal(empty.getAttribute('title'), empty.textContent);
});

test('Logo-Platte ohne Logo: volles Senderkürzel (bis 3 Zeichen) und Farbton je Sender', () => {
  const { tile } = build({ current: null, next: null, after: null });
  assert.equal(tile.chan.fallbackText, 'KE');
  assert.equal(tile.chan.vars['--h'], String(require('../epg-grid-model.js').channelBadge('Kabel Eins').hue));
  const kit = fakeKit();
  const zdf = createTile({ key: 'Z', channel: { name: 'ZDF' }, rows: [], hasEpg: true }, kit);
  assert.equal(zdf.chan.fallbackText, 'ZDF');
});

test('Danach-Zeile ohne Titel: Platzhalter „·“ statt „(“', () => {
  const { tile } = build({ current: null, next: row('n', NOW + 30 * MIN, NOW + 75 * MIN, ''), after: null });
  assert.equal(tile.info.byClass('epg-thumb')[0].textContent, '·');
});
