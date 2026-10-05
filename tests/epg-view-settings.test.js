'use strict';

// Tests: Startansicht des Programmführers (Etappe 3.5, P20) — Werte, Migration, Validierung,
// Auto-Schwelle 899/900, IPC hinter requireMainRenderer, Persistenz, Verdrahtung (Preload, Main, Settings-Seite).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../lib/epg-view-settings.js');
const { validateEpgViewSettingsPatch } = require('../lib/ipc-validation.js');
const { registerEpgViewSettingsIpc } = require('../lib/epg-view-settings-ipc.js');
const { createUserStorage } = require('../lib/user-storage.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Werte: Automatisch / Liste / Raster / Jetzt & Gleich, Standard Automatisch', () => {
  assert.deepEqual([...settings.START_VIEWS], ['auto', 'list', 'grid', 'jng']);
  assert.equal(settings.DEFAULT_START_VIEW, 'auto');
  assert.deepEqual(settings.START_VIEW_LABELS, { auto: 'Automatisch', list: 'Liste', grid: 'Raster', jng: 'Jetzt & Gleich' });
  // die Auswahl in den Einstellungen bietet genau diese Werte an
  const html = read('index.html');
  const select = html.slice(html.indexOf('id="settingsEpgStartView"'), html.indexOf('</select>', html.indexOf('id="settingsEpgStartView"')));
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(m => m[1]), settings.START_VIEWS);
});

test('Migration: Altdaten ohne Feld, kaputte und manipulierte Werte laden mit Standard "auto"', () => {
  for (const raw of [undefined, null, {}, [], 'x', 5, { startView: undefined }, { startView: null }, { startView: 'x' }, { startView: '' }, { startView: 'LIST' }, { startView: 3 }, { startView: {} }, { startView: ['list'] }, { startView: 'list ' }]) {
    assert.deepEqual(settings.normalizeEpgViewSettings(raw), { startView: 'auto' }, JSON.stringify(raw));
  }
  for (const value of settings.START_VIEWS) assert.deepEqual(settings.normalizeEpgViewSettings({ startView: value, extra: 1 }), { startView: value });
});

test('Auto-Schwelle: 900 px und mehr → Liste, 899 px → Jetzt & Gleich; feste Werte ignorieren die Breite', () => {
  assert.equal(settings.AUTO_LIST_MIN_WIDTH, 900);
  assert.equal(settings.resolveStartMode('auto', 900), 'list');
  assert.equal(settings.resolveStartMode('auto', 899), 'jng');
  assert.equal(settings.resolveStartMode('auto', 1280), 'list');
  assert.equal(settings.resolveStartMode('auto', 320), 'jng');
  assert.equal(settings.resolveStartMode('auto', 899.9), 'jng');
  for (const width of [320, 899, 900, 2000]) {
    assert.equal(settings.resolveStartMode('list', width), 'list');
    assert.equal(settings.resolveStartMode('grid', width), 'grid');
    assert.equal(settings.resolveStartMode('jng', width), 'jng');
  }
  // ungültige Einstellung/Breite → wie Automatisch, breiter Standard
  assert.equal(settings.resolveStartMode('x', 500), 'jng');
  assert.equal(settings.resolveStartMode(undefined, undefined), 'list');
  assert.equal(settings.resolveStartMode('auto', NaN), 'list');
});

test('Validierung: nur Objekt mit startView aus der festen Menge; alles andere wird abgelehnt', () => {
  for (const value of settings.START_VIEWS) assert.deepEqual(validateEpgViewSettingsPatch({ startView: value }), { startView: value });
  const bad = [undefined, null, 'x', 'list', 5, true, [], [{ startView: 'list' }], {}, { startView: 'x' }, { startView: null }, { startView: {} }, { startView: ['list'] }, { startView: 1 }, { startView: 'AUTO' }, { startView: 'list', other: 1 }, { other: 'list' }, { __proto__: { startView: 'list' } }];
  for (const patch of bad) assert.throws(() => validateEpgViewSettingsPatch(patch), /Ungültige/, JSON.stringify(patch));
  // das Ergebnis enthält nur startView (keine durchgereichten Zusatzfelder)
  assert.deepEqual(Object.keys(validateEpgViewSettingsPatch({ startView: 'grid' })), ['startView']);
});

function makeIpc({ authorized = true, initial } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-view-settings-'));
  const storage = createUserStorage({ userDataPath: dir, bundlePath: path.join(dir, 'bundle') });
  if (initial !== undefined) fs.writeFileSync(path.join(dir, 'epg-view-settings.json'), initial);
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const checked = [];
  registerEpgViewSettingsIpc({
    ipcMain,
    storage,
    requireMainRenderer: event => {
      checked.push(event);
      if (!authorized) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
  });
  return { handlers, checked, dir, storage, file: path.join(dir, 'epg-view-settings.json') };
}

test('IPC: lesen liefert den Standard, speichern persistiert, Neustart (neue Storage-Instanz) liest den Wert', async () => {
  const ipc = makeIpc();
  assert.deepEqual([...ipc.handlers.keys()].sort(), ['epg-view:get-settings', 'epg-view:set-settings']);
  const event = { sender: 'main' };
  assert.deepEqual(await ipc.handlers.get('epg-view:get-settings')(event), { startView: 'auto' });
  assert.deepEqual(await ipc.handlers.get('epg-view:set-settings')(event, { startView: 'jng' }), { startView: 'jng' });
  assert.deepEqual(JSON.parse(fs.readFileSync(ipc.file, 'utf8')), { startView: 'jng' });
  const again = createUserStorage({ userDataPath: ipc.dir, bundlePath: path.join(ipc.dir, 'bundle') });
  assert.deepEqual(again.readJson('epgViewSettings', null), { startView: 'jng' });
  assert.deepEqual(await ipc.handlers.get('epg-view:get-settings')(event), { startView: 'jng' });
  assert.equal(ipc.checked.length, 3, 'jeder Aufruf prüft requireMainRenderer');
});

test('IPC: manipulierte Werte werden nie gespeichert (Datei bleibt unverändert)', async () => {
  const ipc = makeIpc({ initial: JSON.stringify({ startView: 'grid' }) });
  const set = ipc.handlers.get('epg-view:set-settings');
  for (const patch of ['x', { startView: 'x' }, { startView: { a: 1 } }, null, undefined, [], { startView: 'list', evil: true }, {}]) {
    await assert.rejects(async () => set({ sender: 'main' }, patch), /Ungültige/, JSON.stringify(patch));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(ipc.file, 'utf8')), { startView: 'grid' });
});

test('IPC: fremder Renderer wird abgelehnt; unlesbare/manipulierte Datei lädt mit Standard', async () => {
  const denied = makeIpc({ authorized: false });
  await assert.rejects(async () => denied.handlers.get('epg-view:get-settings')({ sender: 'webview' }), /nicht autorisiert/);
  await assert.rejects(async () => denied.handlers.get('epg-view:set-settings')({ sender: 'webview' }, { startView: 'list' }), /nicht autorisiert/);
  assert.equal(fs.existsSync(denied.file), false, 'nichts gespeichert');
  for (const initial of ['{kaputt', '"x"', '{"startView":"x"}', '[]', '{}']) {
    const ipc = makeIpc({ initial });
    assert.deepEqual(await ipc.handlers.get('epg-view:get-settings')({ sender: 'main' }), { startView: 'auto' }, initial);
  }
  assert.throws(() => registerEpgViewSettingsIpc({ ipcMain: {}, storage: {}, requireMainRenderer: null }), /benötigt/);
});

test('Verdrahtung: Preload-Whitelist, Main registriert unabhängig vom EPG-Dienst, eigener Storage-Eintrag, Renderer nutzt nur die Preload-API', () => {
  const preload = read('preload.js');
  assert.match(preload, /getEpgViewSettings: \(\) => ipcRenderer\.invoke\('epg-view:get-settings'\)/);
  assert.match(preload, /setEpgViewSettings: patch => ipcRenderer\.invoke\('epg-view:set-settings', patch\)/);
  assert.equal((preload.match(/epg-view:/g) || []).length, 2, 'genau die zwei Kanäle');
  const main = read('main.js');
  assert.match(main, /registerEpgViewSettingsIpc\(\{ ipcMain, storage: userStorage, requireMainRenderer \}\)/);
  const registerAt = main.indexOf('registerEpgViewSettingsIpc({');
  const tryEnd = main.indexOf("logger.error('EPG-Dienst konnte nicht eingerichtet werden:'");
  assert.ok(registerAt > tryEnd, 'außerhalb des try-Blocks des EPG-Dienstes');
  const lib = read('lib/epg-view-settings-ipc.js');
  assert.equal((lib.match(/requireMainRenderer\(event\)/g) || []).length, 2, 'beide Handler prüfen den Absender');
  assert.match(lib, /validateEpgViewSettingsPatch\(patch\)/);
  assert.match(read('lib/user-storage.js'), /epgViewSettings: 'epg-view-settings\.json'/);
  const renderer = read('renderer.js');
  assert.match(renderer, /getStartView: \(\) => window\.electronAPI\.getEpgViewSettings\(\)/);
  assert.match(renderer, /setEpgViewSettings\(\{ startView: settingsEpgStartView\.value \}\)/);
  assert.match(renderer, /loadEpgStartViewUi\(\);/);
  const html = read('index.html');
  const page = html.slice(html.indexOf('data-settings-page="livetv-epg"'), html.indexOf('data-settings-page="livetv-playback"'));
  assert.match(page, /Startansicht des Programmführers/);
  assert.match(page, /id="settingsEpgStartView"/);
});

test('Startansicht: der Segment-Umschalter wird nie persistiert, das Öffnen setzt den Startmodus', () => {
  const view = read('epg-view.js');
  assert.ok(!/setEpgViewSettings/.test(view), 'epg-view.js schreibt keine Einstellung');
  assert.match(view, /resolveStartMode\(\)\.then\(mode => \{[\s\S]*viewState\.setMode\(mode\);[\s\S]*loadAll\(\{ initial: true \}\);/);
  assert.match(view, /viewSettings\.resolveStartMode\(startView, window\.innerWidth\)/);
  // ohne lesbare Einstellung gilt Automatisch
  assert.match(view, /let startView = viewSettings\.DEFAULT_START_VIEW;/);
});
