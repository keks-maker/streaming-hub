'use strict';

// Tests: Serien-Abos – Datensatz-Normalisierung (records.js) und Persistenz (SubscriptionStore): atomares Schreiben, defekte Datei,
// Dubletten, unbekannte Felder, Obergrenze der bekannten Folgen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const records = require('../lib/download/subscriptions/records.js');
const { createSubscriptionStore } = require('../lib/download/subscriptions/SubscriptionStore.js');

const SERIES = { id: 'SER1', title: 'Testserie', imageUrl: 'https://img.ardmediathek.de/x.jpg', description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER1?embedded=true' };

function raw(over = {}) {
  return { id: 'sub_abcd1234', sourceId: 'ard', seriesId: SERIES.id, title: SERIES.title, imageUrl: SERIES.imageUrl, groupingURL: SERIES.groupingURL, createdAt: '2026-10-20T10:00:00.000Z', knownEntryIds: ['E1', 'E2'], enabled: true, ...over };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-')), 'subscriptions.json');

test('normalizeSubscription: gültiger Datensatz bleibt, Felder werden bereinigt', () => {
  const sub = records.normalizeSubscription(raw({ overrides: { maxHeight: '720', evil: 'x' }, lastResult: { at: '2026-10-20T11:00:00Z', status: 'ok', added: 2, message: 'm' }, unknown: 1 }));
  assert.equal(sub.id, 'sub_abcd1234');
  assert.equal(sub.seriesId, 'SER1');
  assert.deepEqual(sub.overrides, { maxHeight: '720' });
  assert.equal(sub.lastResult.status, 'ok');
  assert.equal(sub.lastResult.added, 2);
  assert.equal(sub.enabled, true);
  assert.equal(sub.unknown, undefined);
});

test('normalizeSubscription: ungültige ID, Quelle oder Serie ergibt null', () => {
  assert.equal(records.normalizeSubscription(null), null);
  assert.equal(records.normalizeSubscription(raw({ id: '../x' })), null);
  assert.equal(records.normalizeSubscription(raw({ sourceId: 'evil' })), null);
  assert.equal(records.normalizeSubscription(raw({ groupingURL: '' })), null);
  assert.equal(records.normalizeSubscription(raw({ title: '' })), null);
});

test('normalizeSubscription: lastResult mit unbekanntem Status entfällt, enabled false bleibt false', () => {
  const sub = records.normalizeSubscription(raw({ lastResult: { at: '2026-10-20T11:00:00Z', status: 'boom' }, enabled: false }));
  assert.equal(sub.lastResult, null);
  assert.equal(sub.enabled, false);
});

test('normalizeKnown: ohne Dubletten und Nicht-Texte, auf die Obergrenze gekürzt (neueste bleiben)', () => {
  assert.deepEqual(records.normalizeKnown(['a', 'a', 1, '', null, 'b']), ['a', 'b']);
  const many = Array.from({ length: records.MAX_KNOWN + 10 }, (_, i) => `E${i}`);
  const kept = records.normalizeKnown(many);
  assert.equal(kept.length, records.MAX_KNOWN);
  assert.equal(kept[kept.length - 1], `E${records.MAX_KNOWN + 9}`);
});

test('toView: ohne Liste der bekannten Folgen, mit Serie und Hinweis', () => {
  const view = records.toView(records.normalizeSubscription(raw()), { note: 'Hinweis' });
  assert.equal(view.knownCount, 2);
  assert.equal(view.knownEntryIds, undefined);
  assert.equal(view.series.groupingURL, SERIES.groupingURL);
  assert.equal(view.note, 'Hinweis');
});

test('Store: fehlende Datei ergibt leere Liste; save/load Rundlauf ohne Reste', () => {
  const file = tmpFile();
  const store = createSubscriptionStore({ file });
  assert.deepEqual(store.load(), []);
  const sub = records.normalizeSubscription(raw());
  assert.equal(store.save([sub]), true);
  assert.deepEqual(store.load(), [sub]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['subscriptions.json']);
});

test('Store: defekte Datei -> leere Liste und Sicherung als .bak', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{kaputt');
  const logs = [];
  const store = createSubscriptionStore({ file, logger: { warn: m => logs.push(m) } });
  assert.deepEqual(store.load(), []);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{kaputt');
  assert.equal(logs.length, 1);
});

test('Store: Dubletten (ID und Serie) und unbrauchbare Einträge werden beim Laden verworfen', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [raw(), raw(), raw({ id: 'sub_zzzz9999' }), { id: 'x' }, raw({ id: 'sub_other001', seriesId: 'SER2' })] }));
  const list = createSubscriptionStore({ file }).load();
  assert.deepEqual(list.map(sub => sub.id), ['sub_abcd1234', 'sub_other001']);
});

test('Store: Schreibfehler liefert false und hinterlässt keine temporäre Datei', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'datei');
  const logs = [];
  const store = createSubscriptionStore({ file: path.join(blocker, 'subscriptions.json'), logger: { error: m => logs.push(m) } });
  assert.equal(store.save([]), false);
  assert.equal(logs.length, 1);
});
