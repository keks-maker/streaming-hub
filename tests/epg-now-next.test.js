'use strict';

// Tests: epg:now-next und epg:channels (Etappe 3.7, Paket A): Store-Logik, IPC, Validierung, Preload-Whitelist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EpgService } = require('../lib/epg/EpgService.js');
const { registerEpgIpc } = require('../lib/epg/ipc.js');
const { validateEpgNowNext } = require('../lib/ipc-validation.js');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR = 3600 * 1000;

function fmt(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function prog(channel, start, stop, title, category = '') {
  const cat = category ? `<category>${category}</category>` : '';
  return `<programme start="${fmt(start)}" stop="${fmt(stop)}" channel="${channel}"><title>${title}</title>${cat}</programme>`;
}

async function setup(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-nn-'));
  const epg = new EpgService({
    dir,
    getSources: () => [{ id: 'de', epgUrl: 'https://epg.example/de.xml' }],
    fetchImpl: async () => new Response(`<tv>${body}</tv>`),
    validateUrl: u => u,
    now: () => NOW,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await epg.refresh({ force: true });
  const handlers = new Map();
  const mainSender = {};
  registerEpgIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    epg,
    requireMainRenderer: e => {
      if (e?.sender !== mainSender) throw new Error('IPC-Aufruf von nicht autorisiertem Renderer');
    },
  });
  return { epg, handlers, main: { sender: mainSender } };
}

const BODY =
  prog('ZDF.de', NOW - HOUR, NOW + HOUR, 'Laufend', 'Movie') +
  prog('ZDF.de', NOW + HOUR, NOW + 2 * HOUR, 'Danach') +
  prog('ZDF.de', NOW + 3 * HOUR, NOW + 4 * HOUR, 'Spaeter') +
  prog('Gap.de', NOW - 2 * HOUR, NOW - HOUR, 'Vorbei') +
  prog('Gap.de', NOW + 2 * HOUR, NOW + 3 * HOUR, 'Kommt') +
  prog('Ende.de', NOW - HOUR, NOW + HOUR, 'Letzte') +
  prog('Alpha.de', NOW + HOUR, NOW + 2 * HOUR, 'Alpha Titel');

test('now-next: laufende + nächste Sendung, schlanke Slots, Eingabereihenfolge', async () => {
  const { handlers, main } = await setup(BODY);
  const res = await handlers.get('epg:now-next')(main, ['ZDF.de@HD', 'Ende.de']);
  assert.equal(res.length, 2);
  assert.equal(res[0].channelKey, 'ZDF.de@HD');
  assert.deepEqual(Object.keys(res[0].current).sort(), ['genre', 'start', 'stop', 'title']);
  assert.equal(res[0].current.title, 'Laufend');
  assert.equal(res[0].current.start, NOW - HOUR);
  assert.equal(res[0].next.title, 'Danach');
  assert.equal(res[1].channelKey, 'Ende.de');
  assert.equal(res[1].current.title, 'Letzte');
  assert.equal(res[1].next, null);
});

test('now-next: Lücke ohne laufende Sendung, unbekannter Kanal, Grenze stop == jetzt', async () => {
  const { epg } = await setup(BODY);
  const [gap, unknown] = epg.nowNext(['Gap.de', 'Nope.de']);
  assert.equal(gap.current, null);
  assert.equal(gap.next.title, 'Kommt');
  assert.deepEqual(unknown, { channelKey: 'Nope.de', current: null, next: null });
  // zum Zeitpunkt stop der laufenden: die nächste ist laufend (start <= at < stop)
  const at = epg.store.nowNext(['ZDF.de'], NOW + HOUR)[0];
  assert.equal(at.current.title, 'Danach');
  assert.equal(at.next.title, 'Spaeter');
});

test('channels: sortiert, normId/channelId/sampleTitle', async () => {
  const { handlers, main } = await setup(BODY);
  const list = await handlers.get('epg:channels')(main);
  assert.deepEqual(list.map(c => c.normId), [...list.map(c => c.normId)].sort((a, b) => a.localeCompare(b)));
  assert.equal(list.length, 4);
  const zdf = list.find(c => c.normId.startsWith('zdf'));
  assert.ok(zdf);
  assert.equal(zdf.sampleTitle, 'Laufend');
  assert.equal(zdf.channelId, zdf.normId);
  assert.deepEqual(Object.keys(zdf).sort(), ['channelId', 'normId', 'sampleTitle']);
});

test('channels: ohne EPG-Daten leere Liste, now-next liefert null-Paare', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-nn-'));
  const epg = new EpgService({ dir, getSources: () => [], now: () => NOW, autoRefresh: false });
  assert.deepEqual(epg.channels(), []);
  assert.deepEqual(epg.nowNext(['A.de']), [{ channelKey: 'A.de', current: null, next: null }]);
});

test('Validierung und requireMainRenderer', async () => {
  assert.deepEqual(validateEpgNowNext([' A.de ', 'A.de', 'B.de']), ['A.de', 'B.de']);
  for (const bad of [undefined, null, 'A.de', [], [5], [''], ['x\ny'], Array.from({ length: 601 }, (_, i) => `c${i}`)]) {
    assert.throws(() => validateEpgNowNext(bad), String(bad));
  }
  assert.doesNotThrow(() => validateEpgNowNext(Array.from({ length: 600 }, (_, i) => `c${i}`)));
  const { handlers, main } = await setup(BODY);
  const stranger = { sender: {} };
  await assert.rejects(async () => handlers.get('epg:now-next')(stranger, ['ZDF.de']), /nicht autorisiert/);
  await assert.rejects(async () => handlers.get('epg:channels')(stranger), /nicht autorisiert/);
  await assert.rejects(async () => handlers.get('epg:now-next')(main, 'ZDF.de'), /Kanalliste/);
});

test('preload.js: feste Wrapper für now-next/channels', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  assert.match(preload, /getEpgNowNext: channelKeys => ipcRenderer\.invoke\('epg:now-next', channelKeys\)/);
  assert.match(preload, /getEpgChannels: \(\) => ipcRenderer\.invoke\('epg:channels'\)/);
});
