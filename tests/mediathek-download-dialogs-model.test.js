'use strict';

// Tests: Optionen-Dialog-Modell, Serien-Auswahl/Summen und Einstellungs-Modell der Downloads.

const test = require('node:test');
const assert = require('node:assert/strict');
const options = require('../mediathek-download-options-model.js');
const select = require('../mediathek-download-select-model.js');
const settings = require('../settings-mediathek-downloads-model.js');

// ── Optionen-Dialog ──

test('Vorbelegung: Höchstauflösung 1080 statt „best“, übrige Werte aus den Einstellungen', () => {
  const initial = options.initialOverrides({ maxHeight: 'best', container: 'mkv', audioMode: 'all', audioLanguages: ['deu', 'eng'], audioDescription: 'never', subtitleMode: 'preferred', subtitleLanguage: 'deu', subtitleDelivery: 'external', maxParallel: 3 });
  assert.equal(initial.maxHeight, '1080');
  assert.equal(initial.container, 'mkv');
  assert.deepEqual(initial.audioLanguages, ['deu', 'eng']);
  assert.equal(initial.maxParallel, undefined, 'nur überschreibbare Felder');
  assert.equal(options.initialOverrides({ maxHeight: '720' }).maxHeight, '720');
  assert.equal(options.initialOverrides(null).maxHeight, '1080');
});

test('Dialog überspringen nur mit der Einstellung', () => {
  assert.equal(options.shouldSkipDialog({ skipOptionsDialog: true }), true);
  assert.equal(options.shouldSkipDialog({ skipOptionsDialog: false }), false);
  assert.equal(options.shouldSkipDialog(null), false);
});

test('Auflösungsauswahl: „Beste“ plus Stufen, die die Quelle erreicht', () => {
  assert.deepEqual(options.heightChoices({ heights: [720, 540] }, '720').map(choice => choice.value), ['best', '720', '540', '360']);
  assert.deepEqual(options.heightChoices(null, '1080').map(choice => choice.value), ['best', '1080', '720', '540', '360']);
  assert.ok(options.heightChoices({ heights: [540] }, '1080').some(choice => choice.value === '1080'), 'aktueller Wert bleibt wählbar');
  const lists = options.choices(null, {});
  assert.deepEqual(lists.container.map(choice => choice.value), ['mp4', 'mkv']);
  assert.deepEqual(lists.subtitleDelivery.map(choice => choice.value), ['embedded', 'external']);
});

test('Vorschau: Größe, freier Platz, Warnungen, zu wenig Platz', () => {
  const ready = options.previewOf({ ok: true, restricted: false, freeBytes: 50e9, enoughSpace: true, plan: { video: { height: 1080, codec: 'h264', label: '1080p' }, audio: [{ language: 'deu', label: 'Deutsch' }], subtitles: [], estimatedBytes: 1.4e9, warnings: ['Kein Untertitel verfügbar.'] } });
  assert.equal(ready.canDownload, true);
  assert.deepEqual(ready.rows.map(row => row.label), ['Bild', 'Ton', 'Untertitel', 'Geschätzte Größe', 'Freier Platz']);
  assert.equal(ready.rows.find(row => row.label === 'Geschätzte Größe').value, 'ca. 1,4 GB');
  assert.equal(ready.rows.find(row => row.label === 'Untertitel').value, 'Keine');
  assert.deepEqual(ready.warnings, ['Kein Untertitel verfügbar.']);
  const full = options.previewOf({ ok: true, freeBytes: 1e9, enoughSpace: false, plan: { video: {}, audio: [], subtitles: [], estimatedBytes: 4e9, warnings: [] } });
  assert.match(full.warnings[0], /freie Platz reicht/);
  assert.equal(full.canDownload, true, 'Warnung, kein Sperrgrund (der Main prüft beim Start erneut)');
});

test('Vorschau: Duplikat, Altersfreigabe (zurückgestellt), Fehler', () => {
  const duplicate = options.previewOf({ ok: true, duplicate: { id: 'dl_x', status: 'done' } });
  assert.equal(duplicate.canDownload, false);
  assert.equal(duplicate.blocking, 'Diese Folge ist bereits heruntergeladen.');
  assert.equal(options.previewOf({ ok: true, duplicate: { id: 'dl_x', status: 'queued' } }).blocking, 'Diese Folge ist bereits in der Warteschlange.');
  const age = options.previewOf({ ok: true, restricted: true, restriction: { code: 'age', message: 'Nur ab 22 Uhr.', retryAt: '2026-10-20T20:00:00Z' }, freeBytes: 5e9 });
  assert.equal(age.kind, 'restricted');
  assert.equal(age.canDownload, true);
  assert.match(age.rows[0].value, /Der Download startet automatisch ab 20\.10\.2026, 22:00 Uhr/);
  const geo = options.previewOf({ ok: false, code: 'geo', message: 'Nur in Deutschland abrufbar.' });
  assert.equal(geo.canDownload, false);
  assert.equal(geo.blocking, 'Nur in Deutschland abrufbar.');
  assert.equal(options.previewOf(null).canDownload, false);
});

test('Überschreibungen für die Anfrage: leere Werte und leere Sprachlisten entfallen', () => {
  assert.deepEqual(options.overridesForRequest({ maxHeight: '720', container: '', audioLanguages: [], subtitleMode: 'none', audioMode: undefined }), { maxHeight: '720', subtitleMode: 'none' });
});

// ── Serien-Auswahl ──

const ep = (id, season, episode, extra = {}) => ({ id, season, episode, title: `Folge ${episode}`, duration: 1800, airedAt: `2026-0${season}-0${episode}T20:00:00Z`, sourceId: 'ard', ...extra });
const seasons = [
  { number: 1, entries: [ep('a', 1, 1), ep('b', 1, 2), ep('c', 1, 3)] },
  { number: 2, entries: [ep('d', 2, 1), ep('e', 2, 2)] },
];
const states = { a: 'done', b: 'queued', c: 'none', d: 'none', e: 'failed' };
const stateOf = entry => ({ state: states[entry.id] || 'none', percent: null });

test('Auswahl: alle wählbaren vorgewählt, geladene/wartende ausgegraut', () => {
  const selection = select.createSelection({ seasons, stateOf });
  selection.preselect('all');
  assert.deepEqual(selection.ids(), ['c', 'd', 'e']);
  assert.deepEqual(selection.rows.filter(row => !row.selectable).map(row => row.entry.id), ['a', 'b']);
  selection.toggle('a');
  assert.deepEqual(selection.ids(), ['c', 'd', 'e'], 'ausgegraute Folgen lassen sich nicht wählen');
  selection.toggle('c');
  assert.deepEqual(selection.ids(), ['d', 'e']);
  selection.clear();
  assert.deepEqual(selection.ids(), []);
  assert.equal(selection.selectableCount(), 3);
});

test('Auswahl: Staffel, Staffel-Kopfzeile (an/teils/aus), nur neue', () => {
  const selection = select.createSelection({ seasons, stateOf });
  selection.preselect('season:2');
  assert.deepEqual(selection.ids(), ['d', 'e']);
  assert.equal(selection.seasonState(2), 'on');
  assert.equal(selection.seasonState(1), 'off');
  selection.toggle('d');
  assert.equal(selection.seasonState(2), 'some');
  selection.toggleSeason(2);
  assert.equal(selection.seasonState(2), 'on');
  selection.toggleSeason(2);
  assert.equal(selection.seasonState(2), 'off');
  // neu = nach der zuletzt vorhandenen (geladenen/eingereihten) Folge b (Staffel 1, Folge 2) ausgestrahlt
  selection.preselect('new');
  assert.deepEqual(selection.ids(), ['c', 'd', 'e']);
  const fresh = select.createSelection({ seasons, stateOf: () => ({ state: 'none' }) });
  fresh.preselect('new');
  assert.equal(fresh.ids().length, 5, 'ohne vorhandene Folgen sind alle neu');
  assert.equal(select.createSelection({ seasons: [{ number: null, entries: [ep('x', 1, 1, { airedAt: null })] }], stateOf }).selectableCount(), 1);
});

test('Summen: Anzahl, geschätzte Größe je Auflösung, freier Platz, unbekannte Dauer', () => {
  const selection = select.createSelection({ seasons, stateOf, maxHeight: '1080' });
  selection.preselect('all');
  const totals = selection.totals(100e9);
  assert.equal(totals.count, 3);
  assert.equal(totals.bytes, 3 * select.estimateBytes({ duration: 1800 }, '1080'));
  assert.equal(totals.enoughSpace, true);
  selection.setMaxHeight('360');
  assert.ok(selection.totals(100e9).bytes < totals.bytes);
  assert.equal(selection.totals(1e6).enoughSpace, false);
  assert.equal(selection.totals(null).enoughSpace, null);
  assert.equal(select.estimateBytes({ duration: null }), 0);
  const noDuration = select.createSelection({ seasons: [{ number: 1, entries: [ep('z', 1, 1, { duration: null })] }], stateOf });
  noDuration.selectAll();
  assert.equal(noDuration.totals(1e9).unknownSize, 1);
});

test('Texte: Menü, Summenzeile, Knopf, Ergebnis von enqueue-many', () => {
  assert.deepEqual(select.menuItems([1, 2]).map(item => item.id), ['all', 'season:1', 'season:2', 'select', 'new']);
  assert.deepEqual(select.menuItems([1]).map(item => item.id), ['all', 'select', 'new'], 'eine Staffel: kein eigener Eintrag');
  assert.equal(select.submitLabel(1), '1 Folge laden');
  assert.equal(select.submitLabel(12), '12 Folgen laden');
  assert.equal(select.totalsText({ count: 12, bytes: 8.3e9 }, 120e9), '12 Folgen · ca. 8,3 GB · Frei: 120 GB');
  assert.equal(select.totalsText({ count: 0, bytes: 0 }, null), '0 Folgen');
  assert.equal(select.resultText({ ok: true, added: 2, results: [{ ok: true }, { ok: true }] }), '2 Folgen zur Warteschlange hinzugefügt.');
  assert.equal(select.resultText({ ok: true, added: 1, results: [{ ok: true }, { ok: false, code: 'unknown-entry' }, { ok: false, code: 'duplicate' }] }), '1 Folge zur Warteschlange hinzugefügt. 1 Folge konnte nicht eingereiht werden.');
  assert.equal(select.resultText({ ok: false, message: 'Speicherort nicht nutzbar' }), 'Speicherort nicht nutzbar');
});

// ── Einstellungen ──

test('Einstellungs-Seiten: fünf Unterseiten mit den Feldern aus dem Konzept', () => {
  assert.deepEqual(Object.keys(settings.PAGES), ['storage', 'quality', 'audio', 'control', 'notes']);
  const keys = page => settings.PAGES[page].fields.map(field => field.key).filter(Boolean);
  assert.deepEqual(keys('storage'), ['storageRoot', 'fileNameScheme', 'seriesFolders', 'writeNfoCover']);
  assert.deepEqual(keys('quality'), ['maxHeight', 'container']);
  assert.deepEqual(keys('audio'), ['audioMode', 'audioLanguages', 'audioDescription', 'subtitleMode', 'subtitleLanguage', 'subtitleDelivery']);
  assert.deepEqual(keys('control'), ['maxParallel', 'bandwidthKBps', 'notifyOnDone', 'cleanupWatchedDays', 'skipOptionsDialog']);
  assert.deepEqual(keys('notes'), ['showDownloads']);
  assert.ok(settings.PAGES.notes.fields.some(field => field.type === 'notice'));
  assert.match(settings.NOTICE_TEXT.join(' '), /privaten Gebrauch/);
  assert.match(settings.NOTICE_TEXT.join(' '), /Streaming/);
});

test('Sprachfolge: drei Felder <-> Liste ohne Leere und Dubletten, mindestens Deutsch', () => {
  assert.deepEqual(settings.languageSlots(['deu', 'eng']), ['deu', 'eng', '']);
  assert.deepEqual(settings.languagesFromSlots(['eng', '', 'eng']), ['eng']);
  assert.deepEqual(settings.languagesFromSlots(['', '', '']), ['deu']);
  assert.equal(settings.languageOptions(true)[0].value, '');
  assert.notEqual(settings.languageOptions(false)[0].value, '');
});

test('Zahleneingabe, Begrenzungs-Hinweise des Main, Schema-Vorschau, Prüfung des Speicherorts', () => {
  assert.equal(settings.parseNumber(' 1 000 '), 1000);
  assert.equal(settings.parseNumber('2,5'), 2.5);
  assert.equal(settings.parseNumber('abc'), null);
  assert.equal(settings.parseNumber(''), null);
  assert.deepEqual(settings.clampMessages({ clamped: { maxParallel: true }, maxParallel: 5 }), { maxParallel: 'Auf 5 begrenzt (erlaubt: 1 bis 5).' });
  assert.deepEqual(settings.clampMessages({ clamped: { bandwidthKBps: true }, bandwidthKBps: 0 }), { bandwidthKBps: 'Ungültiger Wert, das Limit ist aus.' });
  assert.match(settings.clampMessages({ clamped: { cleanupWatchedDays: true }, cleanupWatchedDays: 3650 }).cleanupWatchedDays, /3650/);
  assert.deepEqual(settings.clampMessages({ clamped: {} }), {});
  assert.deepEqual(settings.clampMessages(null), {});
  assert.equal(settings.schemePreview('S{season2}E{episode2} - {title}'), 'S01E02 - Der Fall Berlin');
  assert.equal(settings.schemePreview('{unbekannt}'), '{unbekannt}');
  assert.deepEqual(settings.rootCheckText({ ok: true, freeBytes: 120e9, network: false }), { ok: true, text: 'Ordner nutzbar, 120 GB frei.' });
  assert.match(settings.rootCheckText({ ok: true, freeBytes: 5e9, network: true }).text, /Netzwerkordner/);
  assert.deepEqual(settings.rootCheckText({ ok: false, error: 'nicht beschreibbar' }), { ok: false, text: 'nicht beschreibbar' });
});
