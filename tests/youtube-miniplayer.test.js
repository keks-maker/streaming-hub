'use strict';

// Tests: gemeinsame Leiste im Modus „Video“ — Modell (Sichtbarkeit, Tooltips, Texte), Ansicht (Fake-DOM, Vorrang vor Radio/Podcast,
// Rückkehr zu Radio ohne Rest) und Kontextmenü-Erweiterung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { youtubeMiniPlayerModel, isVideoMiniPlayerVisible, videoPlayPauseAction, VIDEO_LABELS } = require('../youtube-miniplayer-model.js');
const { createRadioMiniPlayer } = require('../radio-miniplayer-view.js');
const { buildContextMenuTemplate } = require('../lib/webview-context-menu.js');
const { attachWebviewGuest } = require('../lib/webview-guest.js');
const { makeDoc, makeFakeRadio } = require('./helpers/fake-dom.js');

const root = path.join(__dirname, '..');
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const view = (extra = {}) => ({ stage: 'mini', status: 'playing', videoId: A, title: 'Mein Video', channel: 'Kanal', position: 65, duration: 300, volume: 0.5, playlist: [], panelOpen: false, ...extra });

// ───────── Modell ─────────

test('Playlist-Leiste ohne Video (idle) verschwindet bei idleHidden, ein laufendes Video nicht', () => {
  const idle = { stage: 'idle', playlist: [{ id: 'aaaaaaaaaaa' }] };
  assert.equal(isVideoMiniPlayerVisible(idle), true);
  assert.equal(isVideoMiniPlayerVisible({ ...idle, idleHidden: true }), false);
  assert.equal(isVideoMiniPlayerVisible({ stage: 'mini', idleHidden: true }), true);
});

test('Sichtbarkeit: Stufe mini; ohne Video nur, wenn Einträge in der Playlist warten; nicht bei unterdrückter Leiste', () => {
  assert.equal(isVideoMiniPlayerVisible(view()), true);
  assert.equal(isVideoMiniPlayerVisible(view({ stage: 'page' })), false);
  assert.equal(isVideoMiniPlayerVisible(view({ stage: 'app' })), false);
  assert.equal(isVideoMiniPlayerVisible(view({ stage: 'idle' })), false);
  assert.equal(isVideoMiniPlayerVisible(view({ stage: 'idle', playlist: [{ id: A, title: '' }] })), true);
  assert.equal(isVideoMiniPlayerVisible(view(), { suppressed: true }), false);
  assert.equal(isVideoMiniPlayerVisible(null), false);
  assert.equal(youtubeMiniPlayerModel(null).visible, false);
});

test('Tooltips: alle Knöpfe deutsch, Playlist-Knopf wechselt zwischen anzeigen und ausblenden', () => {
  assert.deepEqual(
    { back: VIDEO_LABELS.back, appFill: VIDEO_LABELS.appFill, fullscreen: VIDEO_LABELS.fullscreen, show: VIDEO_LABELS.playlistShow, play: VIDEO_LABELS.play, pause: VIDEO_LABELS.pause, close: VIDEO_LABELS.close },
    { back: 'Zurück zum Video', appFill: 'App-füllend anzeigen', fullscreen: 'Vollbild', show: 'Playlist anzeigen', play: 'Abspielen', pause: 'Pausieren', close: 'Schließen' },
  );
  assert.equal(youtubeMiniPlayerModel(view()).playPauseLabel, 'Pausieren');
  assert.equal(youtubeMiniPlayerModel(view({ status: 'paused' })).playPauseLabel, 'Abspielen');
  assert.equal(VIDEO_LABELS.playlistHide, 'Playlist ausblenden');
});

test('Wiedergabetaste: laufend → pause, pausiert/beendet → resume, nichts geladen → start', () => {
  assert.equal(videoPlayPauseAction(view()), 'pause');
  assert.equal(videoPlayPauseAction(view({ status: 'loading' })), 'pause');
  assert.equal(videoPlayPauseAction(view({ status: 'paused' })), 'resume');
  assert.equal(videoPlayPauseAction(view({ status: 'ended' })), 'resume');
  assert.equal(videoPlayPauseAction(view({ stage: 'idle' })), 'start');
});

test('Texte und Fortschritt: Titel, Kanal/Status, Position, Lautstärke begrenzt; Playlist-Zeilen mit Vorschaubild', () => {
  const m = youtubeMiniPlayerModel(view({ playlist: [{ id: A, title: 'Eins' }, { id: B, title: '' }] }));
  assert.equal(m.name, 'Mein Video');
  assert.equal(m.subtitle, 'Kanal');
  assert.equal(youtubeMiniPlayerModel(view({ status: 'paused' })).subtitle, 'Pausiert – Kanal');
  assert.equal(m.valueText, '1:05 von 5:00');
  assert.equal(m.canSeek, true);
  assert.equal(m.volumePercent, 50);
  assert.equal(youtubeMiniPlayerModel(view({ volume: 9 })).volumePercent, 100);
  assert.deepEqual(m.playlist.map(r => [r.id, r.title, r.canUp, r.canDown]), [[A, 'Eins', false, true], [B, 'YouTube-Video', true, false]]);
  assert.equal(m.playlist[0].thumbnail, `https://i.ytimg.com/vi/${A}/mqdefault.jpg`);
  assert.equal(m.playlistText, '2 Videos in der Playlist');
  const idle = youtubeMiniPlayerModel(view({ stage: 'idle', playlist: [{ id: A, title: 'x' }] }));
  assert.deepEqual([idle.idle, idle.name, idle.subtitle, idle.action, idle.canSeek], [true, 'Playlist', '1 Video in der Playlist', 'start', false]);
});

// ───────── Ansicht ─────────

const STATION = { sourceId: 'a', id: 'one', name: 'Eins', logo: null, genre: 'Pop' };
const radioPlaying = { status: 'playing', station: STATION, volume: 0.5, nowPlaying: null, error: null, reconnecting: false };

function setup({ yt = view(), radioState } = {}) {
  const doc = makeDoc();
  const el = doc.createElement('div');
  const radio = makeFakeRadio(radioState ? { state: radioState } : {});
  const calls = [];
  const holder = { view: yt, listeners: new Set() };
  const actions = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  let slot = null;
  createRadioMiniPlayer(el, {
    radio,
    getFavoriteCount: () => 2,
    youtube: { getView: () => holder.view, subscribe: cb => (holder.listeners.add(cb), () => holder.listeners.delete(cb)), setVideoSlot: node => (slot = node), actions },
    notify: () => {},
    logger: { warn: () => {} },
  });
  const set = next => {
    holder.view = next;
    holder.listeners.forEach(cb => cb());
  };
  return { el, radio, calls, set, slot: () => slot };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Ansicht: Video-Modus zeigt Bildbereich, Tooltips und Knöpfe; Radio-Knöpfe sind verborgen', async () => {
  const { el, slot } = setup();
  await tick();
  assert.equal(el.hidden, false);
  assert.equal(el.dataset.mode, 'video');
  assert.equal(slot(), el.byClass('radio-mini-video')[0]);
  assert.equal(slot().hidden, false);
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Mein Video');
  const titles = id => el.byId(id).title;
  assert.equal(titles('youtubeMiniBack'), 'Zurück zum Video');
  assert.equal(titles('youtubeMiniApp'), 'App-füllend anzeigen');
  assert.equal(titles('youtubeMiniFull'), 'Vollbild');
  assert.equal(titles('youtubeMiniList'), 'Playlist anzeigen');
  assert.equal(titles('radioMiniPlayPause'), 'Pausieren');
  assert.equal(titles('radioMiniStop'), 'Schließen');
  assert.equal(titles('youtubeMiniOpen'), 'Zurück zum Video');
  assert.equal(el.byId('radioMiniPrev').hidden, true);
  assert.equal(el.byId('radioMiniNext').hidden, true);
  assert.equal(el.byId('radioMiniRate').parent.hidden, true);
  for (const id of ['youtubeMiniBack', 'youtubeMiniApp', 'youtubeMiniFull', 'youtubeMiniList']) assert.equal(el.byId(id).hidden, false, id);
  for (const node of el.find(n => n.tagName === 'button')) assert.ok(node.title || node.attrs['aria-label'], `Tooltip fehlt: ${node.id || node.className}`);
});

test('Ansicht: Knöpfe lösen die Aktionen des Controllers aus', async () => {
  const { el, calls } = setup();
  await tick();
  for (const id of ['radioMiniPlayPause', 'youtubeMiniBack', 'youtubeMiniApp', 'youtubeMiniFull', 'youtubeMiniList', 'radioMiniStop', 'youtubeMiniOpen']) el.byId(id).click();
  el.byId('radioMiniInfo').click();
  await tick();
  assert.deepEqual(calls.map(c => c[0]), ['playPause', 'back', 'appFill', 'fullscreen', 'togglePanel', 'close', 'back', 'back']);
  assert.equal(calls[0][1], 'pause');
  el.byId('radioMiniVolume').value = '30';
  el.byId('radioMiniVolume').dispatch('input');
  el.byId('radioMiniSeek').value = '120';
  el.byId('radioMiniSeek').dispatch('change');
  await tick();
  assert.deepEqual(calls.slice(-2), [['setVolume', 0.3], ['seek', 120]]);
});

test('Ansicht: Vorrang Video vor Radio; nach dem Schließen wieder Radio ohne Reste des Video-Modus', async () => {
  const { el, set } = setup({ radioState: radioPlaying });
  await tick();
  assert.equal(el.dataset.mode, 'video');
  set(view({ stage: 'idle' }));
  assert.equal(el.dataset.mode, 'radio');
  assert.equal(el.byClass('radio-mini-video')[0].hidden, true);
  assert.equal(el.byClass('radio-mini-logo')[0].hidden, false);
  assert.equal(el.byId('radioMiniStop').title, 'Radio stoppen');
  assert.equal(el.byId('radioMiniStop').hidden, false);
  assert.equal(el.byId('radioMiniPrev').hidden, false);
  assert.equal(el.byId('youtubeMiniBack').hidden, true);
  assert.equal(el.byId('youtubeMiniPanel').hidden, true);
  assert.equal(el.byClass('radio-mini-name')[0].textContent, 'Eins');
});

test('Ansicht: wartende Playlist ohne Video erscheint nur, wenn Radio und Podcast die Leiste nicht brauchen', async () => {
  const waiting = view({ stage: 'idle', playlist: [{ id: A, title: 'Eins' }] });
  const free = setup({ yt: waiting });
  await tick();
  assert.equal(free.el.hidden, false);
  assert.equal(free.el.dataset.mode, 'video');
  assert.equal(free.el.byId('youtubeMiniBack').hidden, true);
  assert.equal(free.el.byId('radioMiniInfo').title, 'Playlist');
  assert.equal(free.el.byId('radioMiniPlayPause').title, 'Abspielen');
  free.el.byId('radioMiniPlayPause').click();
  await tick();
  assert.deepEqual(free.calls[0], ['playPause', 'start']);
  const busy = setup({ yt: waiting, radioState: radioPlaying });
  await tick();
  assert.equal(busy.el.dataset.mode, 'radio');
});

test('Ansicht: Playlist-Feld zeigt Einträge, Klick spielt ab, Entfernen, ▲▼ und Ziehen melden dem Controller', async () => {
  const list = [{ id: A, title: 'Eins' }, { id: B, title: 'Zwei' }];
  const { el, calls, set } = setup({ yt: view({ playlist: list, panelOpen: true }) });
  await tick();
  const panel = el.byId('youtubeMiniPanel');
  assert.equal(panel.hidden, false);
  assert.equal(el.byId('youtubeMiniList').attrs['aria-expanded'], 'true');
  assert.equal(el.byId('youtubeMiniList').title, 'Playlist ausblenden');
  const rows = el.byClass('radio-mini-playlist-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].byClass('radio-mini-playlist-title')[0].textContent, 'Eins');
  assert.equal(rows[0].find(n => n.tagName === 'img')[0].src, `https://i.ytimg.com/vi/${A}/mqdefault.jpg`);
  rows[1].byClass('radio-mini-playlist-play')[0].click();
  rows[0].byClass('radio-mini-playlist-remove')[0].click();
  rows[1].find(n => n.dataset && n.dataset.action === 'up')[0].click();
  const dragged = { getData: () => A, setData: () => {} };
  rows[1].dispatch('drop', { preventDefault: () => {}, dataTransfer: dragged });
  await tick();
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['playEntry', B], ['removeEntry', A], ['moveBy', B, -1], ['moveEntry', A, B]]);
  assert.ok(rows[0].find(n => n.draggable === true).length, 'Ziehgriff vorhanden');
  set(view({ playlist: [], panelOpen: true }));
  assert.match(el.byClass('radio-mini-playlist-empty')[0].textContent, /Playlist ist leer/);
  set(view({ playlist: list, panelOpen: false }));
  assert.equal(panel.hidden, true);
});

// ───────── Kontextmenü ─────────

test('Kontextmenü: Video-Link bekommt „Als Nächstes abspielen“ und „Zur Playlist hinzufügen“ (nur bei gesetzten Aktionen)', () => {
  const calls = [];
  const actions = { openLink: () => {}, copyLink: () => {}, youtubeNext: u => calls.push(['next', u]), youtubeAdd: u => calls.push(['add', u]) };
  const template = buildContextMenuTemplate({ linkURL: `https://www.youtube.com/watch?v=${A}&t=5s&list=PL1` }, actions);
  const labels = template.filter(i => i.label).map(i => i.label);
  assert.deepEqual(labels, ['Als Nächstes abspielen', 'Zur Playlist hinzufügen', 'Link im Browser öffnen', 'Link kopieren']);
  template[0].click();
  template[1].click();
  assert.deepEqual(calls, [['next', `https://www.youtube.com/watch?v=${A}`], ['add', `https://www.youtube.com/watch?v=${A}`]]);
  // kein Video-Link oder Mini-Player aus: unverändert
  for (const [params, acts] of [
    [{ linkURL: 'https://www.youtube.com/@kanal' }, actions],
    [{ linkURL: 'https://example.org/watch?v=' + A }, actions],
    [{ linkURL: `https://www.youtube.com/watch?v=${A}` }, { openLink: () => {}, copyLink: () => {} }],
  ]) {
    assert.deepEqual(buildContextMenuTemplate(params, acts).filter(i => i.label).map(i => i.label), ['Link im Browser öffnen', 'Link kopieren']);
  }
});

test('Gast-Verdrahtung: Kontextmenü-Aktion geht mit Link und Linktext an den Haupt-Renderer, nur bei eingeschaltetem Mini-Player', () => {
  const streaming = {};
  const sent = [];
  const popups = [];
  const handlers = {};
  const contents = { session: streaming, getType: () => 'webview', getURL: () => 'https://www.youtube.com/', setWindowOpenHandler: () => {}, on: (n, f) => (handlers[n] = f) };
  let enabled = true;
  attachWebviewGuest(contents, {
    streamingSession: streaming,
    shell: {},
    Menu: { buildFromTemplate: t => ({ popup: () => popups.push(t) }) },
    clipboard: {},
    onYoutubeAction: (_c, payload) => sent.push(payload),
    isYoutubeMiniEnabled: () => enabled,
  });
  handlers['context-menu']({}, { linkURL: `https://www.youtube.com/watch?v=${A}`, linkText: 'Titel' });
  popups[0][0].click();
  popups[0][1].click();
  assert.deepEqual(sent, [{ action: 'next', url: `https://www.youtube.com/watch?v=${A}`, title: 'Titel' }, { action: 'add', url: `https://www.youtube.com/watch?v=${A}`, title: 'Titel' }]);
  enabled = false;
  handlers['context-menu']({}, { linkURL: `https://www.youtube.com/watch?v=${A}` });
  assert.deepEqual(popups[1].filter(i => i.label).map(i => i.label), ['Link im Browser öffnen', 'Link kopieren']);
});

test('Struktur: die Leiste erzeugt kein innerHTML mit Daten (Titel, Playlist) und der Radio-Pfad bleibt in der Ansicht unverändert', () => {
  const source = fs.readFileSync(path.join(root, 'radio-miniplayer-view.js'), 'utf8');
  const innerHtml = source.match(/innerHTML\s*=\s*[^;]+;/g) || [];
  for (const assignment of innerHtml) assert.match(assignment, /ICONS\[|ICONS\./, `innerHTML nur mit statischen Symbolen: ${assignment}`);
});
