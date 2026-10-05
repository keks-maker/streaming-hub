'use strict';

// Tests: LiveTV-Hub (Etappe 3.6b) — Statusmodell der Einstiegskarten, Karten-Ansicht (Fake-DOM),
// NavBar-Indikator und statische Invarianten (Sidebar/Vorschau entfernt, rechte Senderliste unberührt).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../dashboard-hub-model.js');
const { createDashboardHub } = require('../dashboard-hub-view.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const sched = state => ({ id: `sch_${Math.random()}`, state });
const rec = status => ({ id: `rec_${Math.random()}`, status });

// ───────── Modell: Zählung ─────────

test('countRecordings: läuft aus recording:list, geplant nur state "scheduled", fertig nur "completed"', () => {
  const counts = model.countRecordings({
    schedules: [sched('scheduled'), sched('scheduled'), sched('recording'), sched('done'), sched('missed'), sched('cancelled'), sched('failed')],
    recordings: [rec('recording'), rec('completed'), rec('completed'), rec('failed'), rec('aborted'), rec('remux-pending')],
  });
  assert.deepEqual(counts, { running: 1, planned: 2, completed: 2, total: 6 });
});

test('countRecordings: robust gegen fehlende/ungültige Eingaben', () => {
  assert.deepEqual(model.countRecordings(), { running: 0, planned: 0, completed: 0, total: 0 });
  assert.deepEqual(model.countRecordings({ schedules: null, recordings: [null, 'x', 7] }), { running: 0, planned: 0, completed: 0, total: 3 });
});

// ───────── Modell: Aufnahmen-Karte ─────────

test('Aufnahmen-Karte: „N läuft · M geplant“ (nur Zähler > 0)', () => {
  const m = model.recordingsCardModel({ loaded: true, ffmpegOk: true, schedules: [sched('scheduled'), sched('scheduled')], recordings: [rec('recording')] });
  assert.equal(m.state, 'active');
  assert.equal(m.status, '1 läuft · 2 geplant');
  assert.deepEqual(m.parts.map(p => p.kind), ['running', 'planned']);
  assert.equal(m.running, 1);
  assert.equal(m.tone, 'normal');
});

test('Aufnahmen-Karte: nur geplant, nur laufend, fertig wird ergänzt', () => {
  assert.equal(model.recordingsCardModel({ loaded: true, schedules: [sched('scheduled')], recordings: [] }).status, '1 geplant');
  assert.equal(model.recordingsCardModel({ loaded: true, schedules: [], recordings: [rec('recording'), rec('recording')] }).status, '2 läuft');
  const m = model.recordingsCardModel({ loaded: true, schedules: [sched('scheduled')], recordings: [rec('completed'), rec('completed'), rec('completed')] });
  assert.equal(m.status, '1 geplant · 3 fertig');
});

test('Aufnahmen-Karte: leer = „Noch keine Aufnahmen“ (auch wenn nur Planungs-Verlauf existiert)', () => {
  const m = model.recordingsCardModel({ loaded: true, ffmpegOk: true, schedules: [sched('done'), sched('missed')], recordings: [] });
  assert.equal(m.state, 'empty');
  assert.equal(m.status, 'Noch keine Aufnahmen');
  assert.equal(m.tone, 'dim');
  assert.deepEqual(m.parts, []);
});

test('Aufnahmen-Karte: nur beendete/fehlgeschlagene Einträge → neutrale Zahl statt „Noch keine“', () => {
  assert.equal(model.recordingsCardModel({ loaded: true, recordings: [rec('failed')] }).status, '1 Aufnahme');
  assert.equal(model.recordingsCardModel({ loaded: true, recordings: [rec('failed'), rec('aborted')] }).status, '2 Aufnahmen');
});

test('Aufnahmen-Karte: ffmpeg fehlt → Warnhinweis, Karte bleibt nutzbar (Hinweis nennt bestehende Aufnahmen)', () => {
  const m = model.recordingsCardModel({ loaded: true, ffmpegOk: false, schedules: [sched('scheduled')], recordings: [rec('completed')] });
  assert.equal(m.state, 'ffmpeg-missing');
  assert.equal(m.status, 'ffmpeg fehlt · Aufnehmen nicht möglich');
  assert.equal(m.tone, 'warn');
  assert.match(m.hint, /Bestehende Aufnahmen bleiben erreichbar/);
  // ffmpegOk unbekannt (undefined) ist KEIN Fehler
  assert.equal(model.recordingsCardModel({ loaded: true, schedules: [], recordings: [] }).state, 'empty');
});

test('Aufnahmen-Karte: Ladezustand und Fehler', () => {
  assert.equal(model.recordingsCardModel({ loaded: false }).state, 'loading');
  const err = model.recordingsCardModel({ loaded: true, error: true });
  assert.equal(err.state, 'unavailable');
  assert.equal(err.status, 'Status nicht verfügbar');
});

// ───────── Modell: Programmübersicht-Karte ─────────

test('Programmübersicht-Karte: keine Favoriten → Hinweistext (Warnton)', () => {
  for (const favoriteCount of [0, undefined, -3, NaN]) {
    const m = model.epgCardModel({ favoriteCount, epgStatus: 'success' });
    assert.equal(m.state, 'no-favorites');
    assert.equal(m.status, 'Favorisiere Sender, um die Programmübersicht zu sehen');
    assert.equal(m.tone, 'warn');
  }
});

test('Programmübersicht-Karte: Statuszeile „EPG aktuell · N Favoriten“ nach EPG-Status', () => {
  assert.equal(model.epgCardModel({ favoriteCount: 12, epgStatus: 'success' }).status, 'EPG aktuell · 12 Favoriten');
  assert.equal(model.epgCardModel({ favoriteCount: 1, epgStatus: 'success' }).status, 'EPG aktuell · 1 Favorit');
  assert.equal(model.epgCardModel({ favoriteCount: 3, epgStatus: 'loading' }).status, 'EPG wird geladen · 3 Favoriten');
  assert.equal(model.epgCardModel({ favoriteCount: 3, epgStatus: 'idle' }).status, 'EPG wird geladen · 3 Favoriten');
  // Fehler/keine Quelle im Renderer-Index: der Programmführer liest den Main-Cache, die Karte behauptet daher nichts über das EPG
  assert.equal(model.epgCardModel({ favoriteCount: 3, epgStatus: 'error' }).status, '3 Favoriten');
  assert.equal(model.epgCardModel({ favoriteCount: 3, epgStatus: 'unavailable' }).status, '3 Favoriten');
});

// ───────── Ansicht (Fake-DOM) ─────────

class FakeNode {
  constructor(tag, doc) {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this._text = '';
    this.innerHTML = '';
    const node = this;
    this.classList = {
      toggle(name, on) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        if (on) set.add(name);
        else set.delete(name);
        node.className = [...set].join(' ');
      },
      contains: name => node.className.split(/\s+/).includes(name),
    };
  }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  append(...nodes) {
    nodes.forEach(n => this.children.push(n));
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  click() {
    (this.listeners.click || []).forEach(fn => fn());
  }
  find(pred, acc = []) {
    if (pred(this)) acc.push(this);
    this.children.forEach(c => c.find && c.find(pred, acc));
    return acc;
  }
}

function makeDoc() {
  const doc = {
    createElement: tag => new FakeNode(tag, doc),
    createTextNode: text => ({ textContent: text, nodeType: 3 }),
  };
  return doc;
}

function setup(apiOverrides = {}, epgInput = { favoriteCount: 4, epgStatus: 'success' }) {
  const doc = makeDoc();
  const root = doc.createElement('div');
  const calls = { epg: 0, rec: 0, ffmpeg: 0 };
  const api = {
    listSchedules: async () => [sched('scheduled')],
    listRecordings: async () => [rec('recording')],
    checkFfmpegStatus: async () => {
      calls.ffmpeg += 1;
      return { ok: true };
    },
    ...apiOverrides,
  };
  const warnings = [];
  const hub = createDashboardHub(root, {
    api,
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
    getEpgInput: () => epgInput,
    onOpenEpg: () => (calls.epg += 1),
    onOpenRecordings: () => (calls.rec += 1),
  });
  const byId = id => root.find(n => n.id === id)[0];
  const card = key => root.children.find(c => c.dataset.card === key);
  const status = key => card(key).find(n => n.className.includes('hub-card-status'))[0];
  return { root, hub, calls, byId, card, status, warnings };
}

test('Ansicht: zwei Karten in fester Reihenfolge (links Programmübersicht, rechts Aufnahmen) mit festen IDs', () => {
  const { root, byId } = setup();
  assert.deepEqual(root.children.map(c => c.dataset.card), ['epg', 'recordings']);
  assert.equal(byId('dashboardEpgOpen').textContent, 'Programmübersicht');
  assert.equal(byId('dashboardRecordingsOpen').textContent, 'Aufnahmen');
});

test('Ansicht: Klick auf die Karten öffnet Programmführer bzw. Aufnahmen-Bereich', () => {
  const { byId, calls } = setup();
  byId('dashboardEpgOpen').click();
  byId('dashboardRecordingsOpen').click();
  byId('dashboardRecordingsOpen').click();
  assert.deepEqual({ epg: calls.epg, rec: calls.rec }, { epg: 1, rec: 2 });
});

test('Ansicht: Programmübersicht-Karte zeigt nur Statuszeile (keine Senderliste), keine Favoriten → Hinweis, Karte klickbar', () => {
  const { status, card, byId, calls } = setup({}, { favoriteCount: 0, epgStatus: 'success' });
  assert.equal(status('epg').textContent, 'Favorisiere Sender, um die Programmübersicht zu sehen');
  assert.equal(card('epg').dataset.state, 'no-favorites');
  assert.ok(status('epg').classList.contains('is-warn'));
  byId('dashboardEpgOpen').click();
  assert.equal(calls.epg, 1);
  assert.equal(card('epg').find(n => n.tagName === 'li' || n.className.includes('row')).length, 0);
});

test('Ansicht: refresh() füllt die Aufnahmen-Karte (läuft rot pulsierend, geplant rot statisch)', async () => {
  const { hub, status, card } = setup({ listSchedules: async () => [sched('scheduled'), sched('scheduled')], listRecordings: async () => [rec('recording')] });
  assert.equal(status('recordings').textContent, 'Status wird geladen …');
  await hub.refresh();
  assert.equal(status('recordings').textContent, '1 läuft · 2 geplant');
  const dots = status('recordings').find(n => n.className.includes('hub-dot'));
  assert.equal(dots.length, 2);
  assert.ok(dots[0].className.includes('hub-dot-live'));
  assert.ok(dots[1].className.includes('hub-dot-planned') && !dots[1].className.includes('hub-dot-live'));
  assert.ok(dots.every(d => d.attrs['aria-hidden'] === 'true'));
  assert.ok(card('recordings').classList.contains('has-running'));
});

test('Ansicht: leer → „Noch keine Aufnahmen“; ffmpeg fehlt → Hinweis, Karte weiter klickbar', async () => {
  const empty = setup({ listSchedules: async () => [], listRecordings: async () => [] });
  await empty.hub.refresh();
  assert.equal(empty.status('recordings').textContent, 'Noch keine Aufnahmen');

  const noff = setup({ listSchedules: async () => [], listRecordings: async () => [rec('completed')], checkFfmpegStatus: async () => ({ ok: false, missing: ['ffmpeg'] }) });
  await noff.hub.refresh();
  assert.equal(noff.status('recordings').textContent, 'ffmpeg fehlt · Aufnehmen nicht möglich');
  assert.ok(noff.status('recordings').classList.contains('is-warn'));
  noff.byId('dashboardRecordingsOpen').click();
  assert.equal(noff.calls.rec, 1);
});

test('Ansicht: ffmpeg-Status wird nur geprüft, bis er „ok“ ist (kein wiederholter schwerer Aufruf)', async () => {
  const { hub, calls } = setup();
  await hub.refresh();
  await hub.refresh();
  await hub.refresh();
  assert.equal(calls.ffmpeg, 1);
  const missing = setup({ checkFfmpegStatus: async () => ({ ok: false }) });
  let n = 0;
  const hub2 = createDashboardHub(missing.root, {
    api: { listSchedules: async () => [], listRecordings: async () => [], checkFfmpegStatus: async () => (n++, { ok: false }) },
    getEpgInput: () => ({}),
    onOpenEpg() {},
    onOpenRecordings() {},
  });
  await hub2.refresh();
  await hub2.refresh();
  assert.equal(n, 2, 'fehlendes ffmpeg wird erneut geprüft (Nutzer kann es nachinstallieren)');
});

test('Ansicht: IPC-Fehler → „Status nicht verfügbar“ + Log; veraltete Antworten werden verworfen', async () => {
  const failing = setup({
    listSchedules: async () => {
      throw new Error('boom');
    },
  });
  await failing.hub.refresh();
  assert.equal(failing.status('recordings').textContent, 'Status nicht verfügbar');
  assert.equal(failing.warnings.length, 1);

  let release;
  const slowFirst = new Promise(resolve => (release = resolve));
  let call = 0;
  const stale = setup({
    listSchedules: async () => {
      call += 1;
      if (call === 1) await slowFirst;
      return call === 1 ? [] : [sched('scheduled')];
    },
    listRecordings: async () => [],
  });
  const first = stale.hub.refresh();
  await stale.hub.refresh(); // zweite (neuere) Antwort kommt zuerst
  assert.equal(stale.status('recordings').textContent, '1 geplant');
  release();
  await first; // veraltete Antwort darf die Anzeige nicht überschreiben
  assert.equal(stale.status('recordings').textContent, '1 geplant');
});

// ───────── Statische Invarianten ─────────

test('Markup: LiveTV-Hub vorhanden, „Jetzt im TV“-Vorschau und linke TV-Sidebar entfernt', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="dashboardHub"') && html.includes('id="dashboardHubCards"'));
  for (const id of ['dashboardTvManage', 'dashboardTvSettings', 'dashboardTvStatusBtn', 'dashboardTvRefresh', 'dashboardTvStatus', 'dashboardCount']) {
    assert.ok(html.includes(`id="${id}"`), `${id} fehlt`);
  }
  for (const gone of ['id="dashboardEpg"', 'dashboardEpgList', 'dashboardEpgRefresh', 'id="dashboardEpgOpen"', 'tvSidebar', 'tv-sidebar', 'tvSearchInput']) {
    assert.ok(!html.includes(gone), `index.html enthält noch ${gone}`);
  }
  // die Karte mit der ID dashboardEpgOpen entsteht in der Ansicht, nicht doppelt im Markup
  assert.equal(read('dashboard-hub-view.js').split("id: 'dashboardEpgOpen'").length - 1, 1);
});

test('Quellcode: keine Reste der Sidebar/Vorschau in renderer.js, styles.css, preload-content.js', () => {
  const renderer = read('renderer.js');
  const css = read('styles.css');
  for (const gone of ['tvSidebar', 'openTvSidebar', 'closeTvSidebar', 'toggleTvSidebar', 'renderDashboardEpg', 'dashboardEpgList', 'dashboardEpgRefresh', 'sidebar-close']) {
    assert.ok(!renderer.includes(gone), `renderer.js enthält noch ${gone}`);
  }
  for (const gone of ['.tv-sidebar', '.dashboard-epg', '.tv-search-input']) {
    assert.ok(!css.includes(gone), `styles.css enthält noch ${gone}`);
  }
  assert.ok(!read('preload-content.js').includes('sidebar-close'));
});

test('Rechte Senderliste im Player und Zapping bleiben unberührt (tv.html, Pfeiltasten-Weg)', () => {
  const tv = read('tv.html');
  assert.ok(tv.includes('Channel list overlay'));
  const renderer = read('renderer.js');
  assert.match(renderer, /getNextChannelId\(tvActiveChannelId, tvChannels, tvSources, direction\)/);
  assert.match(renderer, /function switchTvChannel\(/);
});

test('Aufrufer umgestellt: Verlaufsklick „TV“ → LiveTV-Dashboard, „Sender öffnen“ wählt nur den Sender', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /e\.serviceKey === '__tv__'\) \{[^}]*showDashboard\('livetv'\)/);
  const openChannel = /openChannel: channel => \{([\s\S]*?)\n\x20{2}\},/.exec(renderer)?.[1] || '';
  assert.match(openChannel, /selectTvChannel\(ch, \{ suppressChannelList: true \}\)/);
  assert.ok(!/Sidebar/.test(openChannel));
});

test('Fester Ladeweg: ensureTvDataLoaded beim Öffnen des LiveTV-Dashboards, nie parallel zu laufenden Ladevorgängen', () => {
  const renderer = read('renderer.js');
  const fn = /function ensureTvDataLoaded\(\) \{([\s\S]*?)\n\}/.exec(renderer)?.[1] || '';
  assert.ok(fn.includes("tvEpgStatus === 'loading'") && fn.includes('tvSourcesRefreshing'), 'Schutz gegen parallele Ladevorgänge fehlt');
  assert.ok(fn.includes('loadEpgData(collectEpgUrls('), 'EPG-Index-Nachladen fehlt');
  assert.match(renderer, /if \(groupKey === 'livetv'\) \{\s*ensureTvDataLoaded\(\);/);
  // Start- und Refresh-Ladewege bleiben
  assert.match(renderer, /const result = await loadTvChannels\(true\);\s*await loadEpgData\(collectEpgUrls\(result\.epgUrls\)\);/);
});

test('NavBar (P21): kein Aufnahmen-Eintrag; Indikator-Punkt am LiveTV-Eintrag mit Screenreader-Text, ohne Zahl', () => {
  const renderer = read('renderer.js');
  const css = read('styles.css');
  const groups = /const groups = \[[\s\S]*?\];/.exec(renderer)[0];
  assert.ok(!groups.includes("key: 'recording'"));
  assert.ok(renderer.includes("sr.textContent = 'Aufnahme läuft'"));
  assert.match(renderer, /function updateNavRecordingIndicator\(\) \{\s*const running = recordingActive\(\);/);
  // Indikator folgt dem Aufnahme-Snapshot und wird nach jedem Neuaufbau der NavBar gesetzt
  assert.match(renderer, /updateRecordingsScreenIfVisible\(\);\s*updateNavRecordingIndicator\(\);/);
  assert.match(renderer, /updateNavRecordingIndicator\(\);\s*\}\s*\nfunction createDivider/);
  // pulsierend, bei reduzierter Bewegung statisch
  assert.match(css, /\.nav-live-dot \{[^}]*animation:hubPulse/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.nav-live-dot \{ animation:none; \}|prefers-reduced-motion: reduce\) \{[^}]*\.nav-live-dot,/);
});

test('Sicherheit: Hub-Ansicht setzt Texte per textContent; innerHTML nur für die festen Icons', () => {
  const src = read('dashboard-hub-view.js');
  const uses = src.split('\n').filter(line => /innerHTML/.test(line) && !line.trim().startsWith('//'));
  assert.deepEqual(uses.map(l => l.trim()), ['icon.innerHTML = iconSvg;']);
});

test('Hub-Module sind im Renderer-Lint-Block geführt', () => {
  const eslint = read('eslint.config.js');
  assert.ok(eslint.includes("'dashboard-hub-model.js'") && eslint.includes("'dashboard-hub-view.js'"));
});
