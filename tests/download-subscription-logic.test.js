'use strict';

// Tests: Prüflogik der Serien-Abos (check-logic.js): Baseline, neue Folgen, Varianten (OV/AD), Duplikate im Download-Index,
// Region, Obergrenze je Prüfung und Reihenfolge nach Ablaufdatum.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planCheck, baselineIds, idsOfEntry, uniqueEpisodes } = require('../lib/download/subscriptions/check-logic.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');

const entry = (id, over = {}) => ({ id, title: id, sourceId: 'ard', season: 1, episode: Number(id.replace(/\D/g, '')) || 1, airedAt: null, availableUntil: null, regionRestricted: false, originalVersionId: null, audioDescriptionId: null, ...over });

test('baselineIds: alle Folgen und ihre OV-/AD-Varianten gelten als bekannt', () => {
  const ids = baselineIds([entry('E1'), entry('E2', { originalVersionId: 'E2ov', audioDescriptionId: 'E2ad' }), entry('E1')]);
  assert.deepEqual(ids.sort(), ['E1', 'E2', 'E2ad', 'E2ov']);
  assert.deepEqual(baselineIds(null), []);
});

test('idsOfEntry/uniqueEpisodes: Varianten und Dubletten', () => {
  assert.deepEqual(idsOfEntry(entry('E1', { originalVersionId: 'O' })), ['E1', 'O']);
  assert.deepEqual(uniqueEpisodes([entry('E1'), entry('E1'), null, { id: '' }, entry('E2')]).map(e => e.id), ['E1', 'E2']);
});

test('Neue Folgen = nicht bekannt; Bekanntes (auch über die Variante) bleibt außen vor', () => {
  const plan = planCheck({ episodes: [entry('E1'), entry('E2'), entry('E3', { originalVersionId: 'E1' }), entry('E4')], known: ['E1', 'E2'], nowMs: NOW });
  assert.deepEqual(plan.take.map(e => e.id), ['E4']);
  assert.equal(plan.deferred, 0);
});

test('Folgen im Download-Index sind keine neuen Folgen, gelten aber ab sofort als bekannt', () => {
  const plan = planCheck({ episodes: [entry('E1'), entry('E2', { audioDescriptionId: 'E2ad' })], known: [], isDuplicate: e => e.id === 'E2', nowMs: NOW });
  assert.deepEqual(plan.take.map(e => e.id), ['E1']);
  assert.deepEqual(plan.settled.sort(), ['E2', 'E2ad']);
});

test('Region gesperrte Folgen werden nicht eingereiht, gezählt und als bekannt vermerkt (nicht endlos wiederholt)', () => {
  const plan = planCheck({ episodes: [entry('E1', { regionRestricted: true }), entry('E2')], known: [], nowMs: NOW });
  assert.deepEqual(plan.take.map(e => e.id), ['E2']);
  assert.equal(plan.geo, 1);
  assert.deepEqual(plan.settled, ['E1']);
});

test('Obergrenze je Prüfung: nur maxPerCheck, der Rest bleibt unbekannt und wird gezählt', () => {
  const episodes = Array.from({ length: 25 }, (_, i) => entry(`E${i + 1}`));
  const plan = planCheck({ episodes, known: [], nowMs: NOW, maxPerCheck: 10 });
  assert.equal(plan.take.length, 10);
  assert.equal(plan.deferred, 15);
  assert.deepEqual(plan.settled, []);
  // nächste Prüfung: die ersten zehn gelten als bekannt, die nächsten zehn folgen
  const next = planCheck({ episodes, known: plan.take.map(e => e.id), nowMs: NOW, maxPerCheck: 10 });
  assert.deepEqual(next.take.map(e => e.id), ['E11', 'E12', 'E13', 'E14', 'E15', 'E16', 'E17', 'E18', 'E19', 'E20']);
  assert.equal(next.deferred, 5);
});

test('Priorität nach Ablaufdatum: bald ablaufende zuerst, auch bei knapper Obergrenze', () => {
  const soon = new Date(NOW + 2 * 24 * 3600 * 1000).toISOString();
  const later = new Date(NOW + 5 * 24 * 3600 * 1000).toISOString();
  const plan = planCheck({ episodes: [entry('E1'), entry('E2', { availableUntil: later }), entry('E3', { availableUntil: soon })], known: [], nowMs: NOW, maxPerCheck: 2 });
  assert.deepEqual(plan.take.map(e => e.id), ['E3', 'E2']);
  assert.equal(plan.deferred, 1);
});

test('Ohne Folgen oder ohne neue Folgen: leerer Plan', () => {
  assert.deepEqual(planCheck({ episodes: [], known: [], nowMs: NOW }).take, []);
  assert.deepEqual(planCheck({ episodes: [entry('E1')], known: ['E1'], nowMs: NOW }).take, []);
});
