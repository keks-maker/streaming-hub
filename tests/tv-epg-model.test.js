'use strict';

// Tests: EPG-Leiste im Live-TV-Player folgt der Wiedergabezeit (tv-epg-model.js) und der Aufnahmedialog
// derselben Sendung (lib/recorder/show-override.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../tv-epg-model.js');
const { resolveShowOverride } = require('../lib/recorder/show-override.js');

// 20:00-21:00 Nachrichten, 21:00-22:00 Film, danach (Lücke bis 22:30), 22:30-23:00 Magazin; UTC
const day = '20260910';
const E = (s, e, title) => ({ start: `${day}${s}00 +0000`, stop: `${day}${e}00 +0000`, title });
const ENTRIES = [E('2000', '2100', 'Nachrichten'), E('2100', '2200', 'Film'), E('2230', '2300', 'Magazin')];
const at = (hhmm) => Date.UTC(2026, 8, 10, +hhmm.slice(0, 2), +hhmm.slice(2));

test('findShowAt: aktuelle Sendung und Danach', () => {
  const r = model.findShowAt(ENTRIES, at('2030'));
  assert.equal(r.current.title, 'Nachrichten');
  assert.equal(r.next.title, 'Film');
  assert.equal(model.findShowAt(ENTRIES, at('2100')).current.title, 'Film', 'Ende exklusiv, Start inklusiv');
  assert.equal(model.findShowAt(ENTRIES, at('2100')).next.title, 'Magazin');
});

test('findShowAt: Lücke liefert kein current, aber das nächste Programm; unsortiert/kaputt wird toleriert', () => {
  const gap = model.findShowAt(ENTRIES, at('2215'));
  assert.equal(gap.current, null);
  assert.equal(gap.next.title, 'Magazin');
  const messy = [null, { start: 'x', stop: 'y', title: 'kaputt' }, E('2200', '2100', 'umgekehrt'), ENTRIES[2], ENTRIES[0]];
  assert.equal(model.findShowAt(messy, at('2030')).current.title, 'Nachrichten');
  assert.equal(model.findShowAt(messy, at('2030')).next.title, 'Magazin');
  assert.deepEqual(model.findShowAt([], at('2030')), { current: null, next: null });
  assert.deepEqual(model.findShowAt(undefined, at('2030')), { current: null, next: null });
  assert.equal(model.findShowAt(ENTRIES, at('2400')).next, null);
});

test('referenceTime: DVR + Anker + Einträge = Wiedergabezeit, sonst Uhrzeit (Fallbacks)', () => {
  const nowMs = at('2300');
  const anchor = { mediaSec: 1000, wallSec: at('2000') / 1000 };
  const base = { dvrEnabled: true, anchor, currentTime: 1000 + 1800, entryCount: 3, nowMs };
  assert.deepEqual(model.referenceTime(base), { ms: at('2030'), playback: true });
  // nahe der Kante gilt ebenfalls die Wiedergabezeit (keine Schwelle)
  assert.equal(model.referenceTime({ ...base, currentTime: 1000 + 10790 }).playback, true);
  // Fallbacks auf die Uhrzeit
  for (const broken of [
    { dvrEnabled: false },
    { anchor: null },
    { entryCount: 0 },
    { currentTime: NaN },
    { anchor: { mediaSec: NaN, wallSec: 1 } },
  ]) {
    assert.deepEqual(model.referenceTime({ ...base, ...broken }), { ms: nowMs, playback: false }, JSON.stringify(broken));
  }
});

test('referenceTime: Pause hält die Sendung (gleiche currentTime = gleiche Bezugszeit)', () => {
  const anchor = { mediaSec: 0, wallSec: at('2000') / 1000 };
  const a = model.referenceTime({ dvrEnabled: true, anchor, currentTime: 2000, entryCount: 1, nowMs: at('2100') });
  const b = model.referenceTime({ dvrEnabled: true, anchor, currentTime: 2000, entryCount: 1, nowMs: at('2200') });
  assert.equal(a.ms, b.ms);
});

test('formatBehindLive: auf 10 s gerundet, -m:ss bzw. -h:mm:ss, nahe der Kante null', () => {
  assert.equal(model.formatBehindLive(750), '-12:30');
  assert.equal(model.formatBehindLive(754), '-12:30');
  assert.equal(model.formatBehindLive(756), '-12:40');
  assert.equal(model.formatBehindLive(3730), '-1:02:10');
  assert.equal(model.formatBehindLive(30), '-0:30');
  assert.equal(model.formatBehindLive(5), null);
  assert.equal(model.formatBehindLive(0), null);
  assert.equal(model.formatBehindLive(-3), null);
  assert.equal(model.formatBehindLive(NaN), null);
});

test('describeBar: Sendung, Danach, Fortschritt; Label nur wenn nicht live', () => {
  const clock = ms => model.formatClock(ms);
  const shifted = model.describeBar({ entries: ENTRIES, refMs: at('2030'), behindSec: 1800, isLive: false });
  assert.equal(shifted.noInfo, false);
  assert.equal(shifted.title, 'Nachrichten');
  assert.equal(shifted.startText, clock(at('2000')));
  assert.equal(shifted.endText, clock(at('2100')));
  assert.equal(shifted.nextText, `Danach ${clock(at('2100'))} Film`);
  assert.equal(shifted.progress, 0.5);
  assert.equal(shifted.behindText, '-30:00');
  const live = model.describeBar({ entries: ENTRIES, refMs: at('2030'), behindSec: 20, isLive: true });
  assert.equal(live.behindText, null, 'isLive: kein Zeitversatz-Label');
});

test('describeBar: EPG-Lücke an der Wiedergabeposition = „Keine Programminformation“, Leiste bleibt', () => {
  const gap = model.describeBar({ entries: ENTRIES, refMs: at('2215'), behindSec: 900, isLive: false });
  assert.equal(gap.noInfo, true);
  assert.equal(gap.title, 'Keine Programminformation');
  assert.equal(gap.progress, null);
  assert.equal(gap.startText, '');
  assert.match(gap.nextText, /Magazin$/);
  assert.equal(gap.behindText, '-15:00');
});

test('showProgress: begrenzt auf 0..1', () => {
  const show = { startMs: 1000, stopMs: 3000 };
  assert.equal(model.showProgress(show, 0), 0);
  assert.equal(model.showProgress(show, 2000), 0.5);
  assert.equal(model.showProgress(show, 9000), 1);
  assert.equal(model.showProgress(null, 5), 0);
  assert.equal(model.showProgress({ startMs: 5, stopMs: 5 }, 5), 0);
});

test('hoverText: Uhrzeit und Sendungstitel an der Mausposition', () => {
  assert.equal(model.hoverText(ENTRIES, at('2145')), `${model.formatClock(at('2145'))} · Film`);
  assert.equal(model.hoverText(ENTRIES, at('2215')), `${model.formatClock(at('2215'))} · Keine Programminformation`);
  assert.equal(model.hoverText(ENTRIES, NaN), '');
});

test('tv.html bindet das Modell ein, die Host-Leiste behält den Rückfall (Verdrahtung)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tv.html'), 'utf8');
  assert.ok(html.indexOf('<script src="tv-epg-model.js"></script>') < html.indexOf('TvEpgModel.referenceTime'));
  assert.match(html, /function updateEpgBar[\s\S]*?if \(dvrEpgActive\(\)\) \{ renderDvrEpgBar\(\); return; \}[\s\S]*?renderHostEpgBar\(\)/);
  assert.match(html, /function trySeek[\s\S]*?renderDvrEpgBar\(\);\s*\}/, 'Drag/Seek zeichnet die Leiste sofort');
  assert.match(html, /function resetDvrState[\s\S]*?if \(epgBarDvrOwned\) renderHostEpgBar\(\)/, 'Reset lässt keine alte Sendung stehen');
});

// ── Aufnahme: Sendungsangaben aus tv.html ──

const NOW = at('2200');
const LIVE = { epgTitle: 'Live-Sendung', epgStopMs: at('2230') };

test('resolveShowOverride: laufende Sendung = Autostopp an ihrem Ende, Titel aus dem Request', () => {
  const r = resolveShowOverride(
    { untilEpgEnd: true, epgTitleOverride: ' Film ', epgStartMsOverride: at('2100'), epgEndMsOverride: at('2300') }, LIVE, NOW);
  assert.deepEqual(r, { epgTitle: 'Film', epgStopMs: at('2300'), rangeDurationSec: null });
});

test('resolveShowOverride: beendete Sendung = Dauer statt Uhr-Stopp', () => {
  const r = resolveShowOverride(
    { untilEpgEnd: true, epgTitleOverride: 'Nachrichten', epgStartMsOverride: at('2000'), epgEndMsOverride: at('2100') }, LIVE, NOW);
  assert.deepEqual(r, { epgTitle: 'Nachrichten', epgStopMs: null, rangeDurationSec: 3600 });
});

test('resolveShowOverride: ungültige Angaben fallen auf die Live-Werte zurück', () => {
  const bads = [
    { epgTitleOverride: '', epgEndMsOverride: NaN },
    { epgTitleOverride: 'x'.repeat(301), epgEndMsOverride: Infinity },
    { epgTitleOverride: 'A\nB', epgEndMsOverride: '1700' },
    { epgTitleOverride: 42, epgEndMsOverride: NOW + 30 * 3600 * 1000 },
    { epgTitleOverride: null, epgEndMsOverride: 0 },
  ];
  for (const p of bads) {
    assert.deepEqual(resolveShowOverride({ untilEpgEnd: true, ...p }, LIVE, NOW), { epgTitle: 'Live-Sendung', epgStopMs: at('2230'), rangeDurationSec: null }, JSON.stringify(p));
  }
  assert.deepEqual(resolveShowOverride(null, LIVE, NOW), { epgTitle: 'Live-Sendung', epgStopMs: at('2230'), rangeDurationSec: null });
});

test('resolveShowOverride: beendete Sendung ohne gültigen Start oder mit unplausibler Dauer = Live-Werte', () => {
  const end = at('2100');
  for (const start of [undefined, NaN, end, end + 1000, end - 13 * 3600 * 1000]) {
    const r = resolveShowOverride({ untilEpgEnd: true, epgEndMsOverride: end, epgStartMsOverride: start }, LIVE, NOW);
    assert.equal(r.rangeDurationSec, null);
    assert.equal(r.epgStopMs, at('2230'));
  }
});

test('resolveShowOverride: ohne untilEpgEnd (Ab Bildposition) nur der Titel, kein Stopp', () => {
  const r = resolveShowOverride({ epgTitleOverride: 'Nachrichten', epgEndMsOverride: at('2300') }, LIVE, NOW);
  assert.equal(r.epgTitle, 'Nachrichten');
  assert.equal(r.rangeDurationSec, null);
  assert.equal(r.epgStopMs, at('2230'), 'unverändert (wird ohne untilEpgEnd ohnehin nicht genutzt)');
});
