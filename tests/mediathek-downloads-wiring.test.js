'use strict';

// Tests: Verdrahtung der Download-Oberfläche (index.html, settings-view.js, main.js, preload.js, renderer.js) und der https-Prüfung der Weblinks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isValidPage } = require('../settings-view.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Einstellungen ▸ Mediatheken ▸ Downloads: fünf Unterseiten in Navigation und HTML', () => {
  const html = read('index.html');
  for (const key of ['storage', 'quality', 'audio', 'control', 'notes']) {
    assert.ok(isValidPage(`mediathek-dl-${key}`), key);
    assert.match(html, new RegExp(`data-settings-page="mediathek-dl-${key}"`));
    assert.match(html, new RegExp(`id="settingsMediathekDl-${key}Root"`));
  }
});

test('CSP erlaubt das dl://-Protokoll für Medien, das Protokoll ist privilegiert registriert und im Main verdrahtet', () => {
  const html = read('index.html');
  assert.match(html, /media-src [^;]*\bdl:/);
  const main = read('main.js');
  assert.match(main, /scheme: DL_SCHEME/);
  assert.match(main, /protocol\.handle\(DL_SCHEME, createDownloadProtocolHandler/);
  assert.equal((main.match(/registerSchemesAsPrivileged/g) || []).length, 1, 'beide Schemas in einem Aufruf');
});

test('Preload und Renderer: Ordnerdialog, Ereignis, Navbar-Indikator, Einstellungen-Aktualisierung', () => {
  assert.match(read('preload.js'), /pickFolder: \(\) => ipcRenderer\.invoke\('downloads:pick-folder'\)/);
  const renderer = read('renderer.js');
  assert.match(renderer, /window\.downloads\.onChanged\(payload => downloadsStore\.applyEvent\(payload\)\)/);
  assert.match(renderer, /nav-dl-ring/);
  assert.match(renderer, /refreshDownloadSettings/);
  assert.match(read('index.html'), /styles-downloads\.css/);
});

test('Weblink gesperrter Beiträge: nur https geht an den Renderer', async () => {
  const src = read('lib/mediathek/ipc.js');
  assert.match(src, /webUrl: httpsOnly\(webUrl\(entry\)\)/);
});
