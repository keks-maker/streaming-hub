'use strict';

// Tests: externe Links und Kontextmenü der Content-Webviews (reine Funktionen und Verdrahtung mit Attrappen).

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWindowOpen, classifyNavigation } = require('../lib/webview-links.js');
const { buildContextMenuTemplate } = require('../lib/webview-context-menu.js');
const { attachWebviewGuest } = require('../lib/webview-guest.js');

const YT = 'https://www.youtube.com/watch?v=abc';

test('window.open von YouTube: externe http(s)-Ziele öffnen im Browser, nie andere Schemata', () => {
  assert.deepEqual(classifyWindowOpen({ url: 'https://example.org/x', pageUrl: YT }), { action: 'external', url: 'https://example.org/x' });
  assert.deepEqual(classifyWindowOpen({ url: 'http://example.org/', pageUrl: YT }).action, 'external');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', 'data:text/html,x', 'vscode://x', '', 'kaputt', null]) {
    assert.equal(classifyWindowOpen({ url, pageUrl: YT }).action, 'deny', String(url));
  }
});

test('window.open von YouTube: YouTube-Ziele bleiben in der Webview, Weiterleitung führt zum Ziel', () => {
  assert.deepEqual(classifyWindowOpen({ url: 'https://www.youtube.com/channel/x', pageUrl: YT }), { action: 'internal', url: 'https://www.youtube.com/channel/x' });
  for (const url of ['https://m.youtube.com/watch?v=1', 'https://youtu.be/abc', 'https://www.youtube-nocookie.com/embed/x', 'https://youtube.com/']) {
    assert.equal(classifyWindowOpen({ url, pageUrl: YT }).action, 'internal', url);
  }
  const r = classifyWindowOpen({ url: 'https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1&v=abc', pageUrl: YT });
  assert.deepEqual(r, { action: 'external', url: 'https://example.org/a?b=1' });
  assert.equal(classifyWindowOpen({ url: 'https://www.youtube.com/redirect?q=javascript%3Aalert(1)', pageUrl: YT }).action, 'internal');
  for (const url of ['https://evil-youtube.com.example.org/', 'https://youtu.be.example.org/', 'https://notyoutube.com/']) {
    assert.equal(classifyWindowOpen({ url, pageUrl: YT }).action, 'external', url);
  }
});

test('window.open von Nicht-YouTube-Seiten wird verworfen', () => {
  for (const pageUrl of ['https://www.netflix.com/watch/1', 'https://example.org/', 'https://youtu.be/abc', 'https://evil-youtube.com/', 'about:blank', '', undefined]) {
    for (const url of ['https://example.org/', 'https://www.youtube.com/watch?v=1']) {
      assert.equal(classifyWindowOpen({ url, pageUrl }).action, 'deny', `${pageUrl} -> ${url}`);
    }
  }
});

test('Navigation: nur YouTube-Weiterleitungen gehen nach außen', () => {
  assert.deepEqual(classifyNavigation({ url: 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.org%2F' }), { action: 'external', url: 'https://example.org/' });
  assert.equal(classifyNavigation({ url: 'https://www.youtube.com/watch?v=2' }).action, 'allow');
  assert.equal(classifyNavigation({ url: 'https://accounts.google.com/signin' }).action, 'allow');
  assert.equal(classifyNavigation({ url: 'https://example.org/redirect?q=https%3A%2F%2Fx.y' }).action, 'allow');
  assert.equal(classifyNavigation({ url: 'https://www.youtube.com/redirect?q=file%3A%2F%2F%2Fx' }).action, 'allow');
});

test('Kontextmenü: Auswahl, Eingabefeld, Link, nichts', () => {
  const labels = t => t.map(i => i.label || '---');
  assert.deepEqual(labels(buildContextMenuTemplate({ selectionText: 'Hallo' })), ['Kopieren']);
  assert.deepEqual(buildContextMenuTemplate({ selectionText: '   ' }), []);
  assert.deepEqual(buildContextMenuTemplate({}), []);
  const edit = buildContextMenuTemplate({ isEditable: true, selectionText: '', editFlags: { canPaste: true } });
  assert.deepEqual(labels(edit), ['Ausschneiden', 'Kopieren', 'Einfügen', 'Alles auswählen']);
  assert.equal(edit[0].enabled, false);
  assert.equal(edit[2].enabled, true);
  const sel = buildContextMenuTemplate({ isEditable: true, selectionText: 'x', editFlags: { canCut: true, canCopy: true } });
  assert.equal(sel[0].enabled, true);
  const calls = [];
  const link = buildContextMenuTemplate({ linkURL: 'https://example.org/', selectionText: 'a' }, { openLink: u => calls.push(['open', u]), copyLink: u => calls.push(['copy', u]) });
  assert.deepEqual(labels(link), ['Link im Browser öffnen', 'Link kopieren', '---', 'Kopieren']);
  link[0].click();
  link[1].click();
  assert.deepEqual(calls, [['open', 'https://example.org/'], ['copy', 'https://example.org/']]);
  assert.deepEqual(buildContextMenuTemplate({ linkURL: 'javascript:alert(1)' }), []);
});

function fakeContents({ type = 'webview', session, url = YT } = {}) {
  const handlers = {};
  const c = {
    session,
    loaded: [],
    getType: () => type,
    getURL: () => url,
    setWindowOpenHandler: f => (c.open = f),
    on: (name, f) => (handlers[name] = f),
    loadURL: u => (c.loaded.push(u), Promise.resolve()),
    emit: (name, ...args) => handlers[name](...args),
  };
  return c;
}

test('Verdrahtung: nur Webviews der Streaming-Partition', () => {
  const streaming = {};
  const opened = [];
  const popups = [];
  const copied = [];
  const deps = {
    streamingSession: streaming,
    shell: { openExternal: u => (opened.push(u), Promise.resolve()) },
    Menu: { buildFromTemplate: t => ({ popup: () => popups.push(t) }) },
    clipboard: { writeText: t => copied.push(t) },
  };
  assert.equal(attachWebviewGuest(fakeContents({ session: {} }), deps), false); // persist:tv
  assert.equal(attachWebviewGuest(fakeContents({ type: 'window', session: streaming }), deps), false);
  const clock = 10000;
  deps.now = () => clock;
  const c = fakeContents({ session: streaming });
  assert.equal(attachWebviewGuest(c, deps), true);
  assert.deepEqual(c.open({ url: 'https://example.org/' }), { action: 'deny' });
  c.open({ url: 'https://www.youtube.com/@kanal' });
  c.open({ url: 'file:///etc/passwd' });
  assert.deepEqual(opened, ['https://example.org/']);
  assert.deepEqual(c.loaded, ['https://www.youtube.com/@kanal']);
  let prevented = 0;
  c.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://www.youtube.com/redirect?q=https%3A%2F%2Fa.example%2F');
  c.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://www.youtube.com/watch?v=9');
  assert.equal(prevented, 1);
  assert.deepEqual(opened, ['https://example.org/', 'https://a.example/']);
  c.emit('context-menu', {}, { selectionText: 'x' });
  c.emit('context-menu', {}, {});
  assert.equal(popups.length, 1);
});

test('Popups: immer deny, Drosselung auf ein Öffnen pro Sekunde, Fremdseiten ohne Wirkung', () => {
  const streaming = {};
  const opened = [];
  let clock = 5000;
  const deps = {
    streamingSession: streaming,
    shell: { openExternal: u => (opened.push(u), Promise.resolve()) },
    Menu: {},
    clipboard: {},
    now: () => clock,
  };
  const c = fakeContents({ session: streaming });
  attachWebviewGuest(c, deps);
  for (let i = 0; i < 5; i++) assert.deepEqual(c.open({ url: `https://example.org/${i}` }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.org/0']);
  clock += 999;
  c.open({ url: 'https://example.org/x' });
  assert.equal(opened.length, 1);
  clock += 1;
  c.open({ url: 'https://example.org/y' });
  assert.deepEqual(opened, ['https://example.org/0', 'https://example.org/y']);
  const other = fakeContents({ session: streaming, url: 'https://www.netflix.com/' });
  attachWebviewGuest(other, deps);
  assert.deepEqual(other.open({ url: 'https://example.org/n' }), { action: 'deny' });
  assert.equal(opened.length, 2);
  assert.deepEqual(other.loaded, []);
});
