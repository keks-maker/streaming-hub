'use strict';

// Tests: Abgleich-Regel D10 (lib/sync-merge.js) gegen die gemeinsamen Vektoren (tests/fixtures/sync/*.json) und Randfälle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { merge } = require('../lib/sync-merge.js');

const dir = path.join(__dirname, 'fixtures', 'sync');
const vectors = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

test('Vektordateien vorhanden', () => assert.ok(vectors.length >= 26));

for (const file of vectors) {
  test(`Vektor ${file}`, () => {
    const v = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const result = merge(v.local, v.remote, v.now);
    assert.deepEqual(result.merged, v.merged);
    assert.deepEqual(result.toUpload, v.toUpload);
  });
}

const rec = (name, modified, extra = {}) => ({ name, kind: 'Progress', modified, fields: { id: name.slice(2), position: 5, duration: 100 }, ...extra });

test('Eingabe wird nicht verändert, Ausgabe nach name sortiert', () => {
  const local = [rec('p:bbbbbbbbbbb', 2), rec('p:aaaaaaaaaaa', 2)];
  const copy = JSON.parse(JSON.stringify(local));
  const { merged } = merge(local, [], 10);
  assert.deepEqual(local, copy);
  assert.deepEqual(merged.map(r => r.name), ['p:aaaaaaaaaaa', 'p:bbbbbbbbbbb']);
});

test('Abgelaufene Löschmarke: nie auf dem Server löschen (nur remote: kein Upload, entfällt lokal)', () => {
  const old = rec('p:aaaaaaaaaaa', 0, { deleted: true });
  assert.deepEqual(merge([], [old], 2592000), { merged: [], toUpload: [] });
  assert.equal(merge([], [old], 2591999).merged.length, 1);
});

test('Unbekannte Felder bleiben erhalten', () => {
  const r = rec('p:aaaaaaaaaaa', 5);
  r.fields.extra = { x: [1, 2] };
  assert.deepEqual(merge([r], [], 6).merged[0].fields.extra, { x: [1, 2] });
});
