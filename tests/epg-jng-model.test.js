'use strict';

// Tests: „Jetzt & Gleich“ (Etappe 3.5, M7) — Zuordnung laufend/nächste/übernächste, Fortschritt, Randfälle
// (keine laufende Sendung, Lücken, kein EPG), Fortschreiben ohne Neuabruf, Zeilenhöhen, schmales Layout;
// Verdrahtung: eine Aufnehmen-Logik, Update ohne Neuaufbau, Virtualisierung.
process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jng = require('../epg-jng-model.js');
const rowModel = require('../epg-view-model.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const NOW = local(2026, 10, 5, 20, 32);

const ard = { id: 'ard', name: 'Das Erste', tvgId: 'ARD.de' };
const zdf = { id: 'zdf', name: 'ZDF', tvgId: 'ZDF.de' };
const rtl = { id: 'rtl', name: 'RTL', tvgId: 'RTL.de' };
const entries = [
  { key: 'ARD.de', channel: ard },
  { key: 'ZDF.de', channel: zdf },
  { key: 'RTL.de', channel: rtl },
];
const slot = (startMin, stopMin, title) => ({ start: NOW + startMin * MIN, stop: NOW + stopMin * MIN, title });

test('Zuordnung: laufende, nächste und übernächste Sendung je Sender', () => {
  const channels = jng.buildChannels({
    entries,
    results: [{ channelKey: 'ARD.de', slots: [slot(-12, 73, 'Tatort'), slot(73, 103, 'Tagesthemen'), slot(103, 160, 'Maischberger'), slot(160, 200, 'Später')] }],
    hideNoEpg: false,
  });
  const a = jng.assign(channels[0], NOW);
  assert.equal(a.current.title, 'Tatort');
  assert.equal(a.next.title, 'Tagesthemen');
  assert.equal(a.after.title, 'Maischberger');
  // Zeilenform wie in Liste und Kanalansicht (id, Sender, TV-Tag, Nacht)
  assert.equal(a.current.id, `ARD.de|${NOW - 12 * MIN}`);
  assert.equal(a.current.channel, ard);
  assert.equal(a.current.dayKey, '2026-10-05');
});

test('Fortschritt der laufenden Sendung aus derselben Zeilenlogik wie Liste und Raster', () => {
  const channels = jng.buildChannels({ entries, results: [{ channelKey: 'ARD.de', slots: [slot(-30, 30, 'Halbzeit')] }], hideNoEpg: true });
  const { current } = jng.assign(channels[0], NOW);
  const phase = rowModel.rowPhase(current, NOW);
  assert.equal(phase.phase, 'now');
  assert.equal(phase.progress, 0.5);
  assert.equal(phase.minutesLeft, 30);
});

test('Randfälle: keine laufende Sendung (Lücke) — kommende rücken nach; letzte Sendung läuft — keine nächste', () => {
  const [gap] = jng.buildChannels({
    entries: [entries[0]],
    results: [{ channelKey: 'ARD.de', slots: [slot(-90, -30, 'Vorbei'), slot(15, 60, 'Bald'), slot(60, 90, 'Danach')] }],
  });
  assert.deepEqual(Object.values(jng.assign(gap, NOW)).map(r => r && r.title), [null, 'Bald', 'Danach']);
  const [last] = jng.buildChannels({ entries: [entries[0]], results: [{ channelKey: 'ARD.de', slots: [slot(-10, 20, 'Letzte')] }] });
  const lastAssign = jng.assign(last, NOW);
  assert.equal(lastAssign.current.title, 'Letzte');
  assert.equal(lastAssign.next, null);
  assert.equal(lastAssign.after, null);
  // genau am Wechsel: Ende exklusiv, Start inklusiv
  const [edge] = jng.buildChannels({ entries: [entries[0]], results: [{ channelKey: 'ARD.de', slots: [slot(-30, 0, 'Eben vorbei'), slot(0, 30, 'Beginnt jetzt')] }] });
  assert.equal(jng.assign(edge, NOW).current.title, 'Beginnt jetzt');
  assert.equal(jng.assign(edge, NOW - 1).current.title, 'Eben vorbei');
  // nur Vergangenes: weder laufend noch kommend
  const [past] = jng.buildChannels({ entries: [entries[0]], results: [{ channelKey: 'ARD.de', slots: [slot(-90, -30, 'Alt')] }] });
  assert.deepEqual(Object.values(jng.assign(past, NOW)), [null, null, null]);
  // überlappende Daten: die zuletzt begonnene Sendung gilt als laufend; doppelte Starts entfallen
  const [overlap] = jng.buildChannels({ entries: [entries[0]], results: [{ channelKey: 'ARD.de', slots: [slot(-60, 30, 'Lang'), slot(-10, 20, 'Kurz'), slot(-10, 25, 'Doppelt')] }] });
  assert.equal(jng.assign(overlap, NOW).current.title, 'Kurz');
  assert.equal(overlap.rows.length, 2);
});

test('Kaputte Slots werden ignoriert; Sender ohne Antwort haben keine Zeilen', () => {
  const channels = jng.buildChannels({
    entries,
    results: [
      { channelKey: 'ARD.de', slots: [null, { start: 'x', stop: 1 }, { start: NOW, stop: NaN }, slot(-5, 25, 'Gültig')] },
      { channelKey: 'unbekannt.de', slots: [slot(0, 10, 'Fremd')] },
      null,
      { channelKey: 'ZDF.de', slots: 'kaputt' },
    ],
    hideNoEpg: false,
  });
  assert.deepEqual(channels.map(c => [c.key, c.rows.length, c.hasEpg]), [['ARD.de', 1, true], ['ZDF.de', 0, false], ['RTL.de', 0, false]]);
  assert.deepEqual(jng.buildChannels({ entries: undefined, results: undefined }), []);
});

test('„Sender ohne EPG ausblenden“: an → nur Sender mit Sendungen (oder bekanntem EPG), aus → alle, Reihenfolge bleibt', () => {
  const results = [{ channelKey: 'ARD.de', slots: [slot(-5, 25, 'A')] }, { channelKey: 'RTL.de', slots: [slot(-5, 25, 'R')] }];
  assert.deepEqual(jng.buildChannels({ entries, results, hideNoEpg: true }).map(c => c.key), ['ARD.de', 'RTL.de']);
  assert.deepEqual(jng.buildChannels({ entries, results, hideNoEpg: false }).map(c => c.key), ['ARD.de', 'ZDF.de', 'RTL.de']);
  // Standard ist „ausblenden“
  assert.deepEqual(jng.buildChannels({ entries, results }).map(c => c.key), ['ARD.de', 'RTL.de']);
  // Sender mit EPG im Cache, aber nichts in den nächsten Stunden: bleibt sichtbar (Zeile „Kein Programm …“)
  const known = jng.buildChannels({ entries, results, epgKeys: new Set(['ZDF.de']), hideNoEpg: true });
  assert.deepEqual(known.map(c => [c.key, c.hasEpg]), [['ARD.de', true], ['ZDF.de', true], ['RTL.de', true]]);
});

test('Fortschreiben ohne Neuabruf: nach dem Wechsel rücken die Sendungen nach, die Signatur ändert sich nur dann', () => {
  const [channel] = jng.buildChannels({
    entries: [entries[0]],
    results: [{ channelKey: 'ARD.de', slots: [slot(-12, 28, 'A'), slot(28, 60, 'B'), slot(60, 90, 'C'), slot(90, 120, 'D')] }],
  });
  const t0 = jng.assign(channel, NOW);
  const tLater = jng.assign(channel, NOW + 20 * MIN); // innerhalb von A
  assert.equal(jng.assignmentSig(t0), jng.assignmentSig(tLater), 'Fortschritt ändert die Zuordnung nicht');
  const t1 = jng.assign(channel, NOW + 29 * MIN);
  assert.notEqual(jng.assignmentSig(t0), jng.assignmentSig(t1));
  assert.deepEqual([t1.current.title, t1.next.title, t1.after.title], ['B', 'C', 'D']);
  assert.equal(jng.assignmentSig({ current: null, next: null, after: null }), '->->-');
});

test('Abruffenster und Neuabruf: jetzt … +12 h, nach einer Stunde (oder Uhrensprung rückwärts) neu laden', () => {
  assert.deepEqual(jng.windowFor(NOW), { fromMs: NOW, toMs: NOW + 12 * HOUR });
  assert.equal(jng.needsReload(NOW, NOW + 59 * MIN), false);
  assert.equal(jng.needsReload(NOW, NOW + 60 * MIN), true);
  assert.equal(jng.needsReload(NOW, NOW - 1), true);
  assert.equal(jng.needsReload(null, NOW), true);
  assert.equal(jng.needsReload(NaN, NOW), true);
});

test('Layout: schmal unter 900 px Fensterbreite (899 schmal, 900 breit), feste Zeilenhöhe je Layout', () => {
  assert.equal(jng.isNarrow(899), true);
  assert.equal(jng.isNarrow(900), false);
  assert.equal(jng.isNarrow(320), true);
  assert.equal(jng.isNarrow(undefined), false);
  assert.equal(jng.rowHeight(false), jng.ROW_HEIGHT_WIDE);
  assert.equal(jng.rowHeight(true), jng.ROW_HEIGHT_NARROW);
  assert.ok(jng.ROW_HEIGHT_NARROW > jng.ROW_HEIGHT_WIDE);
});

test('Marker/Toggle: Zellen nutzen dieselbe Slot-Form und Toggle-Logik wie Liste, Raster und Kanalansicht', () => {
  const [channel] = jng.buildChannels({ entries: [entries[0]], results: [{ channelKey: 'ARD.de', slots: [slot(-5, 25, 'Läuft'), slot(30, 60, 'Kommt'), slot(10 * 24 * 60, 10 * 24 * 60 + 30, 'Weit weg')] }] });
  const { current, next } = jng.assign(channel, NOW);
  assert.deepEqual(rowModel.markerSlot(current), { start: current.start, stop: current.stop, channelKey: 'ARD.de', channelId: 'ard', tvgId: 'ARD.de' });
  assert.equal(rowModel.toggleState({ row: current, marker: null, nowMs: NOW }).kind, 'record');
  assert.equal(rowModel.toggleState({ row: next, marker: { state: 'scheduled', ids: ['sch_1'] }, nowMs: NOW }).kind, 'cancel');
  assert.equal(rowModel.toggleState({ row: current, marker: { state: 'recording', ids: ['rec_1'] }, nowMs: NOW }).kind, 'stop');
});

test('Verdrahtung: eine Aufnehmen-Logik (runToggle), Update ohne Neuaufbau, Virtualisierung, Nutzung des Kanalansicht-Einstiegs', () => {
  const view = read('epg-view.js');
  assert.match(view, /createJngView\(\{[\s\S]*onToggle: \(row, element\) => runToggle\(row, element\),[\s\S]*onChannelClick: channel => enterChannel\(channel, \{ returnTo: \{ type: 'jng-channel'/);
  assert.match(view, /onOpen: row => openDetail\(row\),\s*onToggle/);
  assert.equal((view.match(/async function runToggle\(/g) || []).length, 1);
  const jngView = read('epg-jng-view.js');
  assert.ok(!/recordProgramme|stopRecording|removeSchedule|askConfirm|toggleState/.test(jngView), 'J&G-View enthält keine Aufnehmen-Logik');
  assert.match(jngView, /require\('\.\/epg-row-dom\.js'\)/);
  assert.match(read('epg-row-dom.js'), /variant: 'jng'|variant === 'jng'/);
  // 30-s-Takt: tick() aktualisiert nur (Zuordnung/Fortschritt), Neuaufbau nur über setChannels
  const tick = jngView.slice(jngView.indexOf('function tick()'), jngView.indexOf('function setVisible'));
  assert.match(tick, /recompute\(\);\s*render\(\);/);
  assert.ok(!/setChannels|clearNodes|spacer\.textContent/.test(tick), 'tick baut nichts neu');
  assert.match(jngView, /if \(entry\.sig !== sig\) \{\s*entry\.sig = sig;\s*fillCells/, 'Zellen nur bei geänderter Zuordnung neu');
  assert.match(jngView, /OVERSCAN_PX/);
  const viewTick = view.slice(view.indexOf('function tick()'), view.indexOf('// ── Zeilen- und Toggle-Aktionen'));
  assert.match(viewTick, /viewState\.mode === 'jng'[\s\S]*jngView\.tick\(\)[\s\S]*jngModel\.needsReload\(jngLoadedAt, nowMs\)/);
  // epg:changed lädt auch J&G neu (über loadAll), das Segment hat den dritten Modus
  assert.match(view, /jngDirty = true;\s*if \(viewState\.mode === 'jng'\) loadJng\(\);/);
  assert.match(view, /id: 'epgModeJng'/);
  assert.match(view, /text: 'Jetzt & Gleich'/);
});

test('Senderauswahl wirkt in allen Modi: Liste, Raster, Jetzt & Gleich und Suche lesen dieselbe Senderliste (channelEntries)', () => {
  const view = read('epg-view.js');
  assert.equal((view.match(/channelEntries = model\.selectChannels\(/g) || []).length, 1, 'eine Stelle bildet die Auswahl');
  assert.match(view, /include: selectionModel\.selectionPredicate\(viewState\.selection, deps\.isFavorite\)/);
  assert.match(view, /const keys = model\.chunkKeys\(channelEntries\.map\(c => c\.key\)\);\s*const results = \[\];\s*for \(let i = 0; i < keys\.length; i \+= FETCH_PARALLEL\) \{\s*const batch = await Promise\.all\(keys\.slice\(i, i \+ FETCH_PARALLEL\)\.map\(chunk => api\.getEpgRangeMany\(chunk, window_/);
  assert.match(view, /entries: gridModel\.gridRowsFor\(channelEntries, viewState\.hideNoEpg \? channelsWithEpg : null\)/);
  assert.match(view, /keys: channelEntries\.map\(c => c\.key\)/, 'Suche über die Auswahl');
  assert.match(view, /jngModel\.buildChannels\(\{ entries: channelEntries,/);
  // Auswahl ändern lädt alle Modi neu, behält aber Modus/Tag/Anker (keine Zustandsrücksetzung)
  assert.match(view, /function applySelection\(selection\) \{[\s\S]*viewState\.setSelection\(selection\);[\s\S]*loadAll\(\{ initial: layout === null \}\);/);
  // P14-Button geht über dieselbe Auswahl
  assert.match(view, /viewState\.setSelection\(\{ kind: 'all' \}\);\s*updateMenuLabels\(\);\s*loadAll\(\{ initial: true \}\)/);
  assert.ok(!/viewState\.setShowAll/.test(view));
  // kein neues Setting: die Auswahl wird nirgends gespeichert
  assert.ok(!/localStorage|setEpgViewSettings|writeJson/.test(view));
});
