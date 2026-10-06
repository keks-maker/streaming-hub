'use strict';

// Tests: EPG-IPC (Etappe 1; Konzept §3.8): Validierung, requireMainRenderer,
// preload-Whitelist, main.js-Verdrahtung — und Verdrahtungs-Checks für die
// stopAt-Umstellung/Settings (Quelltext-Verträge wie in den fixset-Tests).

// Volle Projektion von range()/find() seit Etappe 3.2
const FULL_KEYS = ['categories', 'credits', 'desc', 'episode', 'icon', 'rating', 'start', 'stop', 'subtitle', 'title', 'year'];
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EpgService } = require('../lib/epg/EpgService.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');
const {
  validateEpgChannelKey,
  validateEpgRange,
  validateEpgFind,
  EPG_MAX_RANGE_MS,
} = require('../lib/ipc-validation.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf-8');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR = 3600 * 1000;

test('Validierung: Kanal-Schlüssel', () => {
  assert.equal(validateEpgChannelKey('  DasErste.de@HD '), 'DasErste.de@HD');
  for (const bad of [undefined, null, 5, {}, [], '', '   ', 'a'.repeat(201), 'x\u0000y', 'x\ny']) {
    assert.throws(() => validateEpgChannelKey(bad), /Ungültiger EPG-Kanal/, String(bad));
  }
});

test('Validierung: Zeitraum (ganzzahlige ms, to > from, max. 14 Tage)', () => {
  assert.deepEqual(validateEpgRange('ZDF.de', NOW, NOW + HOUR), { channelKey: 'ZDF.de', fromMs: NOW, toMs: NOW + HOUR });
  assert.doesNotThrow(() => validateEpgRange('ZDF.de', NOW, NOW + EPG_MAX_RANGE_MS));
  assert.throws(() => validateEpgRange('ZDF.de', NOW, NOW + EPG_MAX_RANGE_MS + 1), /zu groß/);
  assert.throws(() => validateEpgRange('ZDF.de', NOW, NOW), /nach der Startzeit/);
  assert.throws(() => validateEpgRange('ZDF.de', NOW, NOW - 1), /nach der Startzeit/);
  for (const bad of ['1', null, undefined, NaN, Infinity, 1.5, -1, 5e15, {}, [1]]) {
    assert.throws(() => validateEpgRange('ZDF.de', bad, NOW), /ungültig/, `from ${String(bad)}`);
    assert.throws(() => validateEpgRange('ZDF.de', NOW, bad), /ungültig/, `to ${String(bad)}`);
  }
  assert.throws(() => validateEpgRange('', NOW, NOW + 1), /EPG-Kanal/);
});

test('Validierung: find', () => {
  assert.deepEqual(validateEpgFind('ZDF.de', NOW), { channelKey: 'ZDF.de', atMs: NOW });
  assert.throws(() => validateEpgFind('ZDF.de', 'jetzt'), /ungültig/);
  assert.throws(() => validateEpgFind(42, NOW), /EPG-Kanal/);
});

function xmltv() {
  const fmt = ms => {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
  };
  let out = '<tv>';
  for (let i = 0; i < 24 * 9; i += 1) {
    const s = NOW - HOUR + i * HOUR;
    out += `<programme start="${fmt(s)}" stop="${fmt(s + HOUR)}" channel="ZDF.de"><title>Show ${i}</title></programme>`;
  }
  return out + '</tv>';
}

async function makeIpc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-ipc-'));
  const epg = new EpgService({
    dir,
    getSources: () => [{ id: 'de', epgUrl: 'https://epg.example/de.xml' }],
    fetchImpl: async () => new Response(xmltv()),
    validateUrl: u => u,
    now: () => NOW,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await epg.refresh({ force: true });
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const mainSender = {};
  const requireMainRenderer = event => {
    if (event?.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
  };
  registerEpgIpc({ ipcMain, epg, requireMainRenderer });
  const main = { sender: mainSender };
  return { handlers, main, epg };
}

test('IPC: epg:range/find/status/refresh liefern Daten ohne Fenster (reiner Main-Dienst)', async () => {
  const { handlers, main } = await makeIpc();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['epg:channels', 'epg:find', 'epg:now-next', 'epg:refresh', 'epg:range', 'epg:range-many', 'epg:search', 'epg:status'].sort(),
  );

  const week = await handlers.get('epg:range')(main, 'ZDF.de@HD', NOW, NOW + 7 * 24 * HOUR);
  assert.ok(week.length >= 7 * 24, `Slots: ${week.length}`);
  assert.deepEqual(Object.keys(week[0]).sort(), FULL_KEYS);

  const now = await handlers.get('epg:find')(main, 'ZDF.de', NOW + 5 * 60 * 1000);
  assert.equal(now.start, NOW);
  assert.equal(await handlers.get('epg:find')(main, 'ZDF.de', NOW - 10 * 24 * HOUR), null);

  const status = await handlers.get('epg:status')(main);
  assert.ok(status.coverageDays >= 7);
  const refreshed = await handlers.get('epg:refresh')(main);
  assert.equal(refreshed.sources[0].lastError, null);
  assert.equal(refreshed.lastSuccessAt, NOW);
});

test('IPC: fremde Absender werden abgelehnt (requireMainRenderer), ungültige Eingaben ebenfalls', async () => {
  const { handlers, main } = await makeIpc();
  const stranger = { sender: {} };
  for (const [channel, args] of [
    ['epg:range', ['ZDF.de', NOW, NOW + HOUR]],
    ['epg:find', ['ZDF.de', NOW]],
    ['epg:range-many', [['ZDF.de'], NOW, NOW + HOUR]],
    ['epg:search', [['ZDF.de'], 'Show', NOW, NOW + HOUR]],
    ['epg:status', []],
    ['epg:refresh', []],
  ]) {
    await assert.rejects(async () => handlers.get(channel)(stranger, ...args), /nicht autorisiert/, channel);
    await assert.rejects(async () => handlers.get(channel)(undefined, ...args), /nicht autorisiert/, `${channel} ohne event`);
  }
  await assert.rejects(async () => handlers.get('epg:range')(main, 'ZDF.de', NOW, NOW + 30 * 24 * HOUR), /zu groß/);
  await assert.rejects(async () => handlers.get('epg:find')(main, '', NOW), /EPG-Kanal/);
  await assert.rejects(async () => handlers.get('epg:range')(main, 'ZDF.de', '0', 1), /ungültig/);
});

test('preload.js: EPG-Kanäle stehen in der Whitelist (feste Namen, keine generische Durchreichung)', () => {
  const preload = read('preload.js');
  for (const channel of ['epg:range', 'epg:find', 'epg:range-many', 'epg:search', 'epg:status', 'epg:refresh', 'epg:changed']) {
    assert.ok(preload.includes(`'${channel}'`), channel);
  }
  assert.match(preload, /getEpgRange: \(channelKey, fromMs, toMs\) => ipcRenderer\.invoke\('epg:range'/);
  assert.match(preload, /getEpgRangeMany: \(channelKeys, fromMs, toMs\) => ipcRenderer\.invoke\('epg:range-many'/);
  assert.match(preload, /searchEpg: \(channelKeys, query, fromMs, toMs, limit, options\)/);
  // onEpgChanged: wie onScheduleChanged mit Unsubscribe-Funktion
  assert.match(
    preload,
    /onEpgChanged: cb => \{\s*const handler = \(_e, data\) => cb\(data\);\s*ipcRenderer\.on\('epg:changed', handler\);\s*return \(\) => ipcRenderer\.removeListener\('epg:changed', handler\);/,
  );
  // Kein generischer Durchreich-Kanal für epg:* (nur invoke mit festem Kanalnamen)
  assert.ok(!/ipcRenderer\.invoke\(\s*[a-zA-Z_]+\s*[,)]/.test(preload), 'kein invoke mit variablem Kanalnamen');
});

test('main.js: EpgService wird unabhängig vom Fenster/ffmpeg-Health gestartet und IPC hinter requireMainRenderer registriert', () => {
  const main = read('main.js');
  assert.match(main, /new EpgService\(\{[\s\S]*?getSources: \(\) => loadTvSources\(\)/);
  assert.match(main, /registerEpgIpc\(\{ ipcMain, epg: epgService, requireMainRenderer \}\)/);
  assert.match(main, /epgService\.start\(\)/);
  // epg:changed geht nur ans Hauptfenster (mainWindow), Fehler beim Senden sind nicht fatal
  assert.match(main, /epgService\.onChanged\(payload => \{\s*try \{\s*mainWindow\?\.webContents\.send\('epg:changed', payload\)/);
  assert.match(main, /autoRefresh:\s*!process\.env\.STREAMING_HUB_USER_DATA/, 'E2E-Isolation: kein automatischer Netz-Download');
  // Test-Hook: lokale XMLTV-Fixture ersetzt den Download (nur mit STREAMING_HUB_USER_DATA, nie im Normalbetrieb)
  assert.match(main, /process\.env\.STREAMING_HUB_USER_DATA && process\.env\.STREAMING_HUB_EPG_FIXTURE/);
  // Start steht VOR dem ffmpeg-Health-Zweig (kein Zusammenhang mit der Aufnahme-Engine)
  assert.ok(main.indexOf('new EpgService(') < main.indexOf('const health = checkHealth(__dirname)'));
  // Der Renderer lädt/parst kein EPG mehr: kein fetch-epg-Handler, kein parseXMLTV im Main (Etappe 3.7)
  assert.ok(!/fetch-epg|fetchEpgResponse|parseXMLTV/.test(main), 'fetch-epg ist entfernt');
  assert.match(main, /epgService\.stop\(\)/, 'Dienst wird beim Beenden gestoppt');
  assert.ok(!/fetchEPG/.test(read('preload.js')), 'fetchEPG ist aus dem Preload entfernt');
});

test('Sicherheit: EPG-Module rendern nichts per innerHTML', () => {
  for (const file of ['lib/epg/EpgService.js', 'lib/epg/EpgStore.js', 'lib/epg/ipc.js', 'lib/epg/download.js', 'lib/epg/xmltv-stream-parser.js']) {
    assert.ok(!/innerHTML/.test(read(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), file);
  }
});

// ── Verdrahtung stopAt/Soft-Limit/Settings (Renderer/preload/index.html) ──

test('Renderer: „Bis zum Ende der Sendung“ nutzt stopAt im Main — keine Renderer-Timer mehr', () => {
  const renderer = read('renderer.js');
  assert.ok(!/recordingAutoStopTimers|armAutoStopFor|disarmAutoStopFor|syncAutoStopTimers/.test(renderer));
  assert.match(renderer, /request\.stopAt = Math\.floor\(epgStopMs\)/);
  assert.match(renderer, /result\?\.code === 'PARALLEL_LIMIT'/);
  assert.match(renderer, /startRecording\(\{ \.\.\.request, force: true \}\)/);
});

test('UI: Soft-Limit-Dialog hat genau die Aktionen „Trotzdem aufnehmen“ / „Verwerfen“; Reserve-Warntext ist verdrahtet', () => {
  const html = read('index.html');
  assert.match(html, /id="recLimitForce"[^>]*>Trotzdem aufnehmen</);
  assert.match(html, /id="recLimitDiscard"[^>]*>Verwerfen</);
  for (const id of ['recMaxParallelInput', 'recMaxDurationInput', 'recReserveInput', 'recReserveWarn', 'recLimitsSaveBtn']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const preload = read('preload.js');
  for (const api of ['getRecordingSettings', 'setRecordingSettings', 'onRecordingAutoStopped']) {
    assert.ok(preload.includes(api), api);
  }
  const mainSrc = read('main.js');
  assert.match(mainSrc, /ipcMain\.handle\('recording:set-settings'/);
  assert.match(mainSrc, /recordingSettingsResponse\(result\)/);
});

test('UI-Regeln 0.5.15/0.5.22: Start-Dialog bleibt bei genau drei Optionen, tv.html unverändert', () => {
  const tv = read('tv.html');
  const items = tv.match(/class="tv-rec-menu-item"/g) || [];
  assert.equal(items.length, 3, 'genau drei Start-Optionen im Aufnahme-Menü');
  for (const id of ['tvRecStartAtPosition', 'tvRecStartShow', 'tvRecStartUntilEnd']) {
    assert.ok(tv.includes(`id="${id}"`), id);
  }
  // Das Soft-Limit-Overlay ist ein eigener Dialog in index.html und fügt dem Player keinen Button hinzu
  assert.ok(!/recLimit/.test(tv));
});
