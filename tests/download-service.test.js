'use strict';

// Tests: DownloadService (Queue, Zustandsautomat, Persistenz/Wiederaufnahme, Duplikate, Zurückstellung bei Altersfreigabe, Platzprüfung,
// Serien-Batch, Benachrichtigung, Aufräumen, Quit). Ersatz für Auflösung, Jobs, Zeit und Plattenplatz: kein Netz, kein ffmpeg.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DownloadService, sortForBatch, MESSAGES } = require('../lib/download/DownloadService.js');
const { createDownloadStore } = require('../lib/download/DownloadStore.js');
const { normalizeDownloadSettings } = require('../lib/download/download-settings.js');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function entry(id, over = {}) {
  return { id, title: `Folge ${id}`, subtitle: null, description: 'Beschreibung', imageUrl: 'https://img.ardmediathek.de/x.jpg', duration: 1800, sourceId: 'ard', airedAt: '2026-03-19T20:15:00.000Z', partner: 'ard', season: 1, episode: Number(id.replace(/\D/g, '')) || 1, regionRestricted: false, originalVersionId: null, audioDescriptionId: null, availableUntil: null, ...over };
}

const SERIES = { id: 'SER1', title: 'Testserie', imageUrl: null, description: null, sourceId: 'ard', groupingURL: 'https://api.ardmediathek.de/page-gateway/pages/ard/grouping/SER1?embedded=true' };

function info(over = {}) {
  return {
    source: 'ard',
    variants: [{ id: 'v', kind: 'progressive', url: 'https://x.invalid/v.mp4', width: 1280, height: 720, bitrate: 2000000, codec: 'h264', label: 'HD' }],
    audioTracks: [{ id: 'main', kind: 'main', language: 'deu', label: 'Standard', isDefault: true, url: 'https://x.invalid/v.mp4', hlsUrl: null, uri: null, groupId: null }],
    subtitles: [],
    restriction: null,
    availableUntil: null,
    season: 1,
    episode: 1,
    broadcastDate: '2026-03-19',
    seriesTitle: 'Testserie',
    title: 'Folge',
    durationSeconds: 1800,
    isExtra: false,
    ...over,
  };
}

function fakeJobs() {
  const jobs = [];
  const create = opts => {
    const job = {
      opts,
      subtitleFiles: [],
      state: 'new',
      run() {
        job.state = 'running';
        return new Promise((resolve, reject) => {
          job.resolve = resolve;
          job.reject = reject;
        });
      },
      pause() {
        job.state = 'paused';
        job.reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' }));
      },
      cancel() {
        job.state = 'canceled';
        job.reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' }));
      },
      killForQuit() {
        job.state = 'quit';
        job.reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' }));
      },
      finish(extra = {}) {
        fs.mkdirSync(opts.target.dir, { recursive: true });
        fs.writeFileSync(opts.target.file, 'video');
        job.state = 'done';
        job.resolve({ file: opts.target.file, fileSize: 5, durationSec: 1800, etag: '"e"', total: 5, warnings: [], ...extra });
      },
      fail(code, message) {
        job.state = 'failed';
        job.reject(Object.assign(new Error(message || 'Fehler'), { code }));
      },
    };
    jobs.push(job);
    return job;
  };
  return { jobs, create, running: () => jobs.filter(job => job.state === 'running') };
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-svc-'));
  const recRoot = path.join(dir, 'rec');
  fs.mkdirSync(recRoot, { recursive: true });
  const storeFile = path.join(dir, 'downloads.json');
  const clock = { ms: Date.parse('2026-10-20T12:00:00+02:00') };
  const infos = new Map();
  const resolved = [];
  const notes = [];
  const timers = [];
  const jobs = fakeJobs();
  const state = { settings: normalizeDownloadSettings({}).settings, recording: 0, free: 500 * GB, reserve: 1 * GB, watched: new Set(), covers: [] };
  const make = () =>
    new DownloadService({
      store: createDownloadStore({ file: storeFile }),
      resolver: {
        async resolveForDownload(e, options) {
          resolved.push({ id: e.id, series: options && options.series });
          const value = infos.get(e.id);
          if (value instanceof Error) throw value;
          return typeof value === 'function' ? value() : value || info();
        },
      },
      getSettings: () => state.settings,
      getRecordingRoot: () => recRoot,
      getReserveBytes: () => state.reserve,
      getRecordingActive: () => state.recording,
      notifier: { notify: (title, body) => notes.push({ title, body }) },
      getWatchState: record => ({ watched: state.watched.has(record.entry.id) }),
      coverFetcher: async url => {
        state.covers.push(url);
        return { ext: 'jpg', data: Buffer.from('jpg') };
      },
      freeBytes: () => state.free,
      now: () => clock.ms,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer: timer => {
        if (timer) timer.cleared = true;
      },
      createJob: jobs.create,
      validateRoot: () => ({ ok: true, error: null, freeBytes: state.free }),
      ...over,
    });
  let service = make();
  const env = { dir, recRoot, storeFile, clock, infos, resolved, notes, timers, jobs, state, get service() { return service; }, restart() { service.quitSweep(); service = make(); service.start(); return service; }, cleanup: () => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
  env.start = () => service.start();
  return env;
}

test('Einzeldownload: queued -> resolving -> downloading -> done, Datei im Zielpfad, eine Benachrichtigung', async () => {
  const env = setup();
  try {
    env.start();
    const states = [];
    env.service.on('changed', ({ view, reason }) => reason === 'state' && states.push(view.status));
    const result = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    assert.equal(result.ok, true);
    assert.equal(env.service.get(result.id).status, 'resolving');
    await settle();
    const job = env.jobs.jobs[0];
    assert.equal(env.service.get(result.id).status, 'downloading');
    assert.equal(job.opts.plan.mode, 'http');
    assert.equal(job.opts.sourceId, 'ard');
    job.finish();
    await settle();
    const record = env.service.get(result.id);
    assert.equal(record.status, 'done');
    assert.equal(record.file, path.join(env.recRoot, 'Mediathek', 'ARD', 'Testserie', 'S01E01 - Folge.mp4'));
    assert.equal(record.fileSize, 5);
    assert.equal(record.progress.percent, 100);
    assert.deepEqual(states.filter((s, i) => states.indexOf(s) === i), ['resolving', 'downloading', 'done']);
    assert.deepEqual(env.notes, [{ title: 'Download fertig', body: 'Folge' }]);
    assert.ok(env.service.fileInfo(result.id));
    // frisch aufgelöst, Serie wird mitgegeben (ARD-Staffelermittlung)
    assert.equal(env.resolved[0].series.id, 'SER1');
  } finally {
    env.cleanup();
  }
});

test('Parallelität: höchstens maxParallel, nächster startet nach Fertigstellung; eine Sammelbenachrichtigung', async () => {
  const env = setup();
  try {
    env.start();
    for (const id of ['E1', 'E2', 'E3']) env.service.enqueue({ entry: entry(id), series: SERIES });
    await settle();
    assert.equal(env.jobs.running().length, 2);
    assert.equal(env.service.summary().queued, 1);
    env.jobs.jobs[0].finish();
    await settle();
    assert.equal(env.jobs.jobs.length, 3);
    assert.equal(env.jobs.running().length, 2);
    env.jobs.jobs[1].finish();
    env.jobs.jobs[2].finish();
    await settle();
    assert.equal(env.service.list().filter(item => item.status === 'done').length, 3);
    assert.deepEqual(env.notes, [{ title: 'Downloads fertig', body: '3 Folgen wurden geladen.' }]);
  } finally {
    env.cleanup();
  }
});

test('Benachrichtigung abschaltbar', async () => {
  const env = setup();
  try {
    env.state.settings = normalizeDownloadSettings({ notifyOnDone: false }).settings;
    env.start();
    env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish();
    await settle();
    assert.deepEqual(env.notes, []);
  } finally {
    env.cleanup();
  }
});

test('Aufnahmen haben Vorrang: laufende Aufnahme -> ein Download, zweiter wird zurückgestellt und danach fortgesetzt', async () => {
  const env = setup();
  try {
    env.start();
    env.service.enqueue({ entry: entry('E1'), series: SERIES });
    env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    assert.equal(env.jobs.running().length, 2);
    env.state.recording = 1;
    env.service.onRecordingActivity();
    await settle();
    assert.equal(env.jobs.jobs[1].state, 'paused');
    assert.equal(env.service.list().find(item => item.entryId === 'E2').status, 'queued');
    assert.equal(env.jobs.running().length, 1);
    env.state.recording = 0;
    env.service.onRecordingActivity();
    await settle();
    assert.equal(env.jobs.running().length, 2);
    // neuer Download bei laufender Aufnahme: wartet
    env.state.recording = 2;
    env.service.enqueue({ entry: entry('E3'), series: SERIES });
    await settle();
    assert.equal(env.service.list().find(item => item.entryId === 'E3').status, 'queued');
  } finally {
    env.cleanup();
  }
});

test('Pause/Fortsetzen: Job wird angehalten, Fortsetzen startet neu; Warteschlange kann pausiert werden', async () => {
  const env = setup();
  try {
    env.state.settings = normalizeDownloadSettings({ maxParallel: 1 }).settings;
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    assert.equal(env.service.pause(b.id).ok, true); // wartend
    assert.equal(env.service.get(b.id).status, 'paused');
    assert.equal(env.service.pause(a.id).ok, true); // laufend
    await settle();
    assert.equal(env.jobs.jobs[0].state, 'paused');
    assert.equal(env.service.get(a.id).status, 'paused');
    assert.equal(env.jobs.running().length, 0); // pausierte starten nicht von selbst
    assert.equal(env.service.resume(a.id).ok, true);
    await settle();
    assert.equal(env.service.get(a.id).status, 'downloading');
    assert.equal(env.jobs.jobs.length, 2);
    assert.equal(env.service.resume(a.id).ok, false); // läuft schon
    assert.equal(env.service.pause('dl_gibtesnicht').ok, false);
  } finally {
    env.cleanup();
  }
});

test('Pause während der Auflösung verwirft das Ergebnis', async () => {
  const env = setup();
  try {
    env.start();
    let release;
    env.infos.set('E1', () => new Promise(resolve => { release = () => resolve(info()); }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.service.pause(a.id);
    release();
    await settle();
    assert.equal(env.service.get(a.id).status, 'paused');
    assert.equal(env.jobs.jobs.length, 0);
  } finally {
    env.cleanup();
  }
});

test('Abbrechen: Job beendet, Zustand canceled, Wiederholen reiht neu ein', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.cancel(a.id).ok, true);
    await settle();
    assert.equal(env.jobs.jobs[0].state, 'canceled');
    assert.equal(env.service.get(a.id).status, 'canceled');
    assert.equal(env.service.get(a.id).target, null);
    assert.equal(env.service.cancel(a.id).ok, false);
    assert.equal(env.service.retry(a.id).ok, true);
    await settle();
    assert.equal(env.service.get(a.id).status, 'downloading');
    assert.equal(env.jobs.jobs.length, 2);
  } finally {
    env.cleanup();
  }
});

test('Fehler: Meldung ohne Adresse, Wiederholen möglich; abgelaufene Adresse wird genau einmal frisch aufgelöst', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.jobs.jobs[0].fail('expired');
    await settle();
    assert.equal(env.resolved.filter(item => item.id === 'E1').length, 2); // zweiter Versuch mit frischer Auflösung
    assert.equal(env.service.get(a.id).status, 'downloading');
    env.jobs.jobs[1].fail('expired');
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).error, MESSAGES.expired);
    assert.equal(env.resolved.filter(item => item.id === 'E1').length, 2);
    env.service.retry(a.id);
    await settle();
    env.jobs.jobs.at(-1).fail('network', 'Verbindung zum Server fehlgeschlagen');
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).error, 'Verbindung zum Server fehlgeschlagen');
    assert.equal(env.service.get(a.id).errorCode, 'network');
  } finally {
    env.cleanup();
  }
});

test('Quelle nicht erreichbar: lesbare Meldung statt Fehlertext', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1', Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), { code: 'network' }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).error, MESSAGES.network);
    assert.ok(!/ENOTFOUND/.test(JSON.stringify(env.service.list())));
  } finally {
    env.cleanup();
  }
});

test('Sperren: Geoblock/nicht unterstützt/nicht verfügbar/abgelaufen -> failed mit lesbarer Meldung', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('G', info({ variants: [], audioTracks: [], restriction: { code: 'geo', message: 'x' } }));
    env.infos.set('U', info({ variants: [], audioTracks: [], restriction: { code: 'unsupported', message: 'Nur mit Zugangs-Token abrufbar.' } }));
    env.infos.set('N', info({ variants: [], audioTracks: [], restriction: { code: 'unavailable', message: 'Stream nicht verfügbar.' } }));
    env.infos.set('A', info({ availableUntil: '2026-10-01T00:00:00.000Z' }));
    env.infos.set('K', info({ variants: [], audioTracks: [] }));
    for (const id of ['G', 'U', 'N', 'A', 'K']) env.service.enqueue({ entry: entry(id, { sourceId: 'ard' }), series: SERIES });
    await settle();
    const by = id => env.service.list().find(item => item.entryId === id);
    assert.deepEqual([by('G').status, by('G').error], ['failed', MESSAGES.geo]);
    assert.deepEqual([by('U').status, by('U').error], ['failed', 'Nur mit Zugangs-Token abrufbar.']);
    assert.deepEqual([by('N').status, by('N').errorCode], ['failed', 'unavailable']);
    assert.deepEqual([by('A').status, by('A').error], ['failed', MESSAGES.expired]);
    assert.equal(by('K').status, 'failed');
    assert.match(by('K').error, /kein ladbarer Stream/);
    assert.equal(env.jobs.jobs.length, 0);
  } finally {
    env.cleanup();
  }
});

test('Altersfreigabe: Zustand scheduled mit Timer bis zum Fenster, danach neuer Versuch und Download', async () => {
  const env = setup();
  try {
    env.start();
    let blocked = true;
    env.infos.set('E1', () => (blocked ? info({ variants: [], audioTracks: [], restriction: { code: 'age', rating: 'FSK16', window: '22 bis 6 Uhr', message: 'Dieser Beitrag ist ab FSK 16 eingestuft und nur von 22 bis 6 Uhr abrufbar.', retryAt: null } }) : info()));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    const record = env.service.get(a.id);
    assert.equal(record.status, 'scheduled');
    assert.equal(record.retryAt, '2026-10-20T20:00:00.000Z'); // 22:00 MESZ
    assert.match(record.error, /22 bis 6 Uhr/);
    assert.equal(env.jobs.jobs.length, 0);
    assert.equal(env.service.pause(a.id).ok, true); // auch zurückgestellte lassen sich anhalten
    assert.equal(env.service.resume(a.id).ok, true);
    await settle();
    assert.equal(env.service.get(a.id).status, 'scheduled'); // Fenster noch zu: wieder zurückgestellt
    const timer = env.timers.filter(item => !item.cleared).at(-1);
    assert.ok(timer.ms >= 9.9 * 3600 * 1000 && timer.ms <= 10.1 * 3600 * 1000); // 12:00 bis 22:00
    blocked = false;
    env.clock.ms = Date.parse('2026-10-20T22:00:05+02:00');
    timer.fn();
    await settle();
    assert.equal(env.service.get(a.id).status, 'downloading');
  } finally {
    env.cleanup();
  }
});

test('Altersfreigabe: Zurückstellung übersteht den Neustart (Timer wird neu gesetzt)', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1', info({ variants: [], audioTracks: [], restriction: { code: 'age', rating: 'FSK16', message: 'FSK 16', retryAt: '2026-10-20T20:00:00.000Z' } }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.get(a.id).retryAt, '2026-10-20T20:00:00.000Z');
    const before = env.timers.length;
    env.restart();
    assert.equal(env.service.get(a.id).status, 'scheduled');
    assert.ok(env.timers.length > before);
  } finally {
    env.cleanup();
  }
});

test('Altersfreigabe: nach vielen Fehlversuchen -> failed statt endloser Zurückstellung', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1', info({ variants: [], audioTracks: [], restriction: { code: 'age', rating: 'FSK16', message: 'FSK 16' } }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    for (let i = 0; i < 40 && env.service.get(a.id).status !== 'failed'; i += 1) {
      await settle();
      const timer = env.timers.filter(item => !item.cleared).at(-1);
      if (env.service.get(a.id).status === 'scheduled') {
        env.clock.ms = Date.parse(env.service.get(a.id).retryAt) + 2000;
        timer.fn();
      }
    }
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).errorCode, 'age');
  } finally {
    env.cleanup();
  }
});

test('Duplikate: gleiche Folge, OV-/AD-Variante und fertige Datei; fehlgeschlagene und gelöschte Dateien dürfen erneut', async () => {
  const env = setup();
  try {
    env.start();
    const original = entry('E1', { originalVersionId: 'E1-OV', audioDescriptionId: 'E1-AD' });
    const a = env.service.enqueue({ entry: original, series: SERIES });
    assert.equal(a.ok, true);
    const again = env.service.enqueue({ entry: original, series: SERIES });
    assert.deepEqual([again.ok, again.code, again.id], [false, 'duplicate', a.id]);
    const ov = env.service.enqueue({ entry: entry('E1-OV', { title: 'Folge E1 (Originalversion)' }), series: SERIES });
    assert.equal(ov.code, 'duplicate');
    const ad = env.service.enqueue({ entry: entry('E1-AD'), series: SERIES });
    assert.equal(ad.code, 'duplicate');
    await settle();
    env.jobs.jobs[0].finish();
    await settle();
    assert.equal(env.service.enqueue({ entry: original, series: SERIES }).message, 'Bereits geladen.');
    // Datei extern gelöscht -> erneut ladbar, der alte Eintrag wird ersetzt
    fs.rmSync(env.service.get(a.id).file);
    const redo = env.service.enqueue({ entry: original, series: SERIES });
    assert.equal(redo.ok, true);
    assert.equal(env.service.get(a.id), null);
    // andere Quelle mit gleicher ID ist keine Dublette
    assert.equal(env.service.enqueue({ entry: entry('E1', { sourceId: 'zdf' }), series: null }).ok, true);
  } finally {
    env.cleanup();
  }
});

test('Duplikat-Index: fehlgeschlagene Folge wird beim erneuten Einreihen ersetzt', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1', info({ variants: [], audioTracks: [] }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    env.infos.set('E1', info());
    const b = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    assert.equal(b.ok, true);
    assert.notEqual(b.id, a.id);
    assert.equal(env.service.get(a.id), null);
  } finally {
    env.cleanup();
  }
});

test('Platzprüfung: zu wenig Platz (Bedarf + Reserve) -> failed, unbekannter Platz (Netzlaufwerk) -> weiter', async () => {
  const env = setup();
  try {
    env.start();
    env.state.free = 1 * GB + 100 * MB; // Reserve 1 GB, Bedarf ca. 450 MB
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).error, MESSAGES.space);
    assert.equal(env.service.get(a.id).errorCode, 'space');
    env.state.free = null;
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    assert.equal(env.service.get(b.id).status, 'downloading');
    env.state.free = 5 * GB;
    const c = env.service.enqueue({ entry: entry('E3'), series: SERIES });
    await settle();
    assert.equal(env.service.get(c.id).status, 'downloading');
  } finally {
    env.cleanup();
  }
});

test('Platzprüfung: Reserve verdoppelt sich bei laufender Aufnahme; Rest laufender Downloads wird abgezogen', async () => {
  const env = setup();
  try {
    env.start();
    env.state.free = 2 * GB; // 450 MB Bedarf + 1 GB Reserve passen, mit 2 GB Reserve nicht
    env.state.recording = 1;
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    env.state.recording = 0;
    env.state.free = 3 * GB;
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    assert.equal(env.service.get(b.id).status, 'downloading'); // belegt rechnerisch 450 MB
    env.state.free = 1400 * MB; // 1400 - 450 (Rest von b) = 950 MB < 450 MB + 1 GB
    const c = env.service.enqueue({ entry: entry('E3'), series: SERIES });
    await settle();
    assert.equal(env.service.get(c.id).status, 'failed');
  } finally {
    env.cleanup();
  }
});

test('Platz-Wächter: sinkt der Platz unter die Reserve, wird der Download angehalten (Reserve für Aufnahmen)', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.state.free = 500 * MB;
    env.clock.ms += 6000;
    env.jobs.jobs[0].opts.onProgress({ percent: 10, bytes: 1000, totalBytes: 10000, speed: 100, etaSec: 50 });
    await settle();
    assert.equal(env.service.get(a.id).status, 'failed');
    assert.equal(env.service.get(a.id).error, MESSAGES.spaceLow);
    assert.equal(env.jobs.jobs[0].state, 'paused');
  } finally {
    env.cleanup();
  }
});

test('Persistenz und Wiederaufnahme: laufende Downloads kehren in die Warteschlange zurück und werden fortgesetzt', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    const c = env.service.enqueue({ entry: entry('E3'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish({}); // E1 fertig
    await settle();
    env.service.pause(c.id);
    const file = JSON.parse(fs.readFileSync(env.storeFile, 'utf8'));
    assert.equal(file.version, 1);
    assert.equal(file.items.length, 3);
    // Neustart: B lief noch
    const before = env.jobs.jobs.length;
    env.restart();
    await settle();
    assert.equal(env.service.get(a.id).status, 'done');
    assert.equal(env.service.get(c.id).status, 'paused');
    assert.equal(env.service.get(b.id).status, 'downloading');
    assert.equal(env.jobs.jobs.length, before + 1);
    assert.equal(env.service.get(b.id).entry.title, 'Folge E2');
    // das Ziel bleibt für den Resume dasselbe
    assert.equal(env.jobs.jobs.at(-1).opts.target.file, env.service.get(b.id).target.file);
  } finally {
    env.cleanup();
  }
});

test('Persistenz: defekte Datei -> leere Liste (Sicherung .bak), manipulierte Pfade werden verworfen', async () => {
  const env = setup();
  try {
    fs.writeFileSync(env.storeFile, '{kaputt');
    env.start();
    assert.deepEqual(env.service.list(), []);
    assert.ok(fs.existsSync(`${env.storeFile}.bak`));
    env.service.stop();
    const evil = { version: 1, items: [{ id: 'dl_abcd1234', status: 'done', entry: { id: 'X', title: 'T', sourceId: 'ard' }, root: path.join(env.recRoot, 'Mediathek'), file: '/etc/passwd', createdAt: '2026-01-01T00:00:00.000Z' }, { id: '../../x', status: 'done', entry: { id: 'Y', sourceId: 'ard' } }, { id: 'dl_zzzz1234', status: 'bogus', entry: { id: 'Z', title: 'T', sourceId: 'evil' } }] };
    fs.writeFileSync(env.storeFile, JSON.stringify(evil));
    const store = createDownloadStore({ file: env.storeFile });
    const loaded = store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].file, null); // außerhalb des Speicherorts
  } finally {
    env.cleanup();
  }
});

test('Löschen: Eintrag allein oder mit Datei, Begleitdateien und leeren Ordnern; Fremddateien bleiben', async () => {
  const env = setup();
  try {
    env.state.settings = normalizeDownloadSettings({ writeNfoCover: true }).settings;
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish();
    await settle();
    const record = env.service.get(a.id);
    const dir = path.dirname(record.file);
    assert.ok(fs.existsSync(path.join(dir, 'S01E01 - Folge.nfo')));
    assert.ok(fs.existsSync(path.join(dir, 'poster.jpg')));
    assert.equal(env.state.covers.length, 1);
    assert.equal(record.sidecars.length, 1); // das Serienposter gehört der Serie, nicht der Folge
    fs.writeFileSync(path.join(dir, 'fremd.txt'), 'bleibt');
    assert.equal(env.service.remove(a.id, { deleteFile: true }).ok, true);
    assert.equal(fs.existsSync(record.file), false);
    assert.equal(fs.existsSync(path.join(dir, 'S01E01 - Folge.nfo')), false);
    assert.ok(fs.existsSync(path.join(dir, 'fremd.txt')));
    assert.equal(env.service.get(a.id), null);
    // ohne deleteFile bleibt die Datei
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    env.jobs.jobs[1].finish();
    await settle();
    const file = env.service.get(b.id).file;
    env.service.remove(b.id, { deleteFile: false });
    assert.ok(fs.existsSync(file));
  } finally {
    env.cleanup();
  }
});

test('Löschen: leere Serien- und Quellenordner verschwinden, der Speicherort bleibt', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish();
    await settle();
    env.service.remove(a.id, { deleteFile: true });
    assert.equal(fs.existsSync(path.join(env.recRoot, 'Mediathek', 'ARD')), false);
    assert.ok(fs.existsSync(path.join(env.recRoot, 'Mediathek')));
  } finally {
    env.cleanup();
  }
});

test('Löschen eines laufenden Downloads bricht ihn ab', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.service.remove(a.id, { deleteFile: true });
    await settle();
    assert.equal(env.jobs.jobs[0].state, 'canceled');
    assert.equal(env.service.list().length, 0);
  } finally {
    env.cleanup();
  }
});

test('Manipulierter Datensatz: Löschen/Abspielen fasst nur Dateien unter dem Speicherort an', async () => {
  const env = setup();
  try {
    const outside = path.join(env.dir, 'wichtig.mp4');
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(env.storeFile, JSON.stringify({ version: 1, items: [{ id: 'dl_evil0001', status: 'done', entry: { id: 'X', title: 'T', sourceId: 'ard' }, root: path.join(env.recRoot, 'Mediathek'), file: outside, sidecars: [outside], createdAt: '2026-01-01T00:00:00.000Z' }] }));
    env.start();
    assert.equal(env.service.fileInfo('dl_evil0001'), null);
    env.service.remove('dl_evil0001', { deleteFile: true });
    assert.ok(fs.existsSync(outside));
  } finally {
    env.cleanup();
  }
});

test('Serien-Batch: bald ablaufende zuerst, dann chronologisch; Duplikate melden sich einzeln', async () => {
  const now = Date.parse('2026-10-20T12:00:00+02:00');
  const day = 86400000;
  const e = (id, season, episode, until, aired = '2026-01-01T00:00:00.000Z') => entry(id, { season, episode, availableUntil: until === null ? null : new Date(now + until * day).toISOString(), airedAt: aired });
  const sorted = sortForBatch([e('S2E1', 2, 1, null), e('S1E2', 1, 2, null), e('S1E1', 1, 1, null), e('LATE', 1, 3, 90), e('SOON2', 3, 1, 9), e('SOON1', 3, 2, 2), e('GONE', 1, 9, -3), e('NOEP', null, null, null, '2026-02-01T00:00:00.000Z')], now);
  assert.deepEqual(sorted.map(item => item.id), ['SOON1', 'SOON2', 'S1E1', 'S1E2', 'LATE', 'GONE', 'S2E1', 'NOEP']);
  const env = setup();
  try {
    env.start();
    env.service.enqueue({ entry: entry('E2'), series: SERIES });
    const result = env.service.enqueueMany({ series: SERIES, entries: [entry('E3'), entry('E2'), entry('E1')] });
    assert.equal(result.added, 2);
    assert.deepEqual(result.results.map(r => [r.entryId, r.ok, r.code || null]), [['E1', true, null], ['E2', false, 'duplicate'], ['E3', true, null]]);
    const records = env.service.list().filter(item => item.entryId !== 'E2').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    assert.equal(records.length, 2);
    await settle();
    // Startreihenfolge folgt der Sortierung: E2 lief schon, danach E1 vor E3 (zwei Plätze)
    assert.deepEqual(env.resolved.map(item => item.id), ['E2', 'E1']);
    env.jobs.jobs[0].finish();
    await settle();
    assert.deepEqual(env.resolved.map(item => item.id), ['E2', 'E1', 'E3']);
  } finally {
    env.cleanup();
  }
});

test('Speicherort nicht nutzbar -> enqueue meldet storage, nichts wird angelegt', async () => {
  const env = setup({ validateRoot: () => ({ ok: false, error: 'nicht beschreibbar' }) });
  try {
    env.start();
    const result = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    assert.deepEqual([result.ok, result.code], [false, 'storage']);
    assert.match(result.message, /nicht beschreibbar/);
    assert.equal(env.service.list().length, 0);
    assert.equal(env.service.enqueueMany({ series: SERIES, entries: [entry('E1')] }).ok, false);
  } finally {
    env.cleanup();
  }
});

test('Aufräumen gesehener Downloads: Tage-Schwelle, 0 = nur merken', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    const b = env.service.enqueue({ entry: entry('E2'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish();
    env.jobs.jobs[1].finish();
    await settle();
    const fileA = env.service.get(a.id).file;
    env.state.watched.add('E1');
    assert.equal(env.service.cleanupWatched(), 0); // days = 0
    assert.ok(env.service.get(a.id).watchedAt);
    assert.ok(fs.existsSync(fileA));
    env.state.settings = normalizeDownloadSettings({ cleanupWatchedDays: 7 }).settings;
    env.clock.ms += 6 * 86400000;
    assert.equal(env.service.cleanupWatched(), 0);
    env.clock.ms += 2 * 86400000;
    assert.equal(env.service.cleanupWatched(), 1);
    assert.equal(fs.existsSync(fileA), false);
    assert.equal(env.service.get(a.id), null);
    assert.ok(env.service.get(b.id)); // ungesehen bleibt
  } finally {
    env.cleanup();
  }
});

test('Beenden: laufende Downloads werden gestoppt und für den nächsten Start vorgemerkt', async () => {
  const env = setup();
  try {
    env.start();
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    env.service.enqueue({ entry: entry('E2'), series: SERIES });
    env.service.enqueue({ entry: entry('E3'), series: SERIES });
    await settle();
    assert.equal(env.service.activeCount(), 3);
    env.service.quitSweep();
    await settle();
    assert.equal(env.jobs.jobs[0].state, 'quit');
    assert.equal(env.service.get(a.id).status, 'queued');
    assert.equal(JSON.parse(fs.readFileSync(env.storeFile, 'utf8')).items.every(item => item.status === 'queued'), true);
    assert.equal(env.jobs.jobs.length, 2); // nach dem Sweep startet nichts mehr
  } finally {
    env.cleanup();
  }
});

test('Vorschau: Plan, Spuren, Größe, freier Platz, Dublette, Altersfreigabe, Sperre', async () => {
  const env = setup();
  try {
    env.start();
    const preview = await env.service.preview({ entry: entry('E1'), series: SERIES, overrides: { container: 'mkv' } });
    assert.equal(preview.ok, true);
    assert.equal(preview.plan.container, 'mkv');
    assert.equal(preview.plan.video.height, 720);
    assert.equal(preview.plan.estimatedBytes, Math.round((2000000 / 8) * 1800));
    assert.equal(preview.freeBytes, 500 * GB);
    assert.equal(preview.enoughSpace, true);
    assert.deepEqual(preview.available.heights, [720]);
    assert.equal(preview.duplicate, null);
    env.service.enqueue({ entry: entry('E1'), series: SERIES });
    assert.ok(['resolving', 'downloading'].includes((await env.service.preview({ entry: entry('E1'), series: SERIES })).duplicate.status));
    env.infos.set('A', info({ variants: [], audioTracks: [], restriction: { code: 'age', rating: 'FSK16', message: 'FSK 16' } }));
    const age = await env.service.preview({ entry: entry('A') });
    assert.equal(age.restricted, true);
    assert.equal(age.restriction.retryAt, '2026-10-20T20:00:00.000Z');
    env.infos.set('G', info({ variants: [], audioTracks: [], restriction: { code: 'geo', message: 'x' } }));
    assert.equal((await env.service.preview({ entry: entry('G') })).ok, false);
    env.infos.set('N', Object.assign(new Error('x'), { code: 'network' }));
    assert.equal((await env.service.preview({ entry: entry('N') })).code, 'network');
    env.state.free = 100 * MB;
    assert.equal((await env.service.preview({ entry: entry('E9') })).enoughSpace, false);
  } finally {
    env.cleanup();
  }
});

test('ARD Original-Ton: OV-Eintrag wird mit aufgelöst, wenn die Sprachreihenfolge "orig" enthält', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1-OV', info({ audioTracks: [{ id: 'ard-main', kind: 'main', language: 'ov', label: 'Standard', isDefault: true, url: 'https://x.invalid/ov.mp4', hlsUrl: null, uri: null, groupId: null }] }));
    env.state.settings = normalizeDownloadSettings({ audioLanguages: ['orig', 'deu'] }).settings;
    const a = env.service.enqueue({ entry: entry('E1', { originalVersionId: 'E1-OV' }), series: SERIES });
    await settle();
    assert.deepEqual(env.resolved.map(item => item.id), ['E1', 'E1-OV']);
    const plan = env.jobs.jobs[0].opts.plan;
    assert.equal(plan.audio.length, 1);
    assert.equal(plan.audio[0].id, 'ard-ov');
    assert.equal(plan.inputs[1].url, 'https://x.invalid/ov.mp4');
    assert.equal(env.service.get(a.id).status, 'downloading');
  } finally {
    env.cleanup();
  }
});

test('Ansicht für den Renderer: keine Pfade, Ablauf-Markierung, fehlende Datei', async () => {
  const env = setup();
  try {
    env.start();
    env.infos.set('E1', info({ availableUntil: '2026-10-21T00:00:00.000Z' }));
    const a = env.service.enqueue({ entry: entry('E1'), series: SERIES });
    await settle();
    env.jobs.jobs[0].finish();
    await settle();
    let view = env.service.list()[0];
    assert.equal(view.sourceExpired, false);
    assert.equal(view.fileMissing, false);
    assert.equal(view.container, 'mp4');
    assert.ok(!JSON.stringify(view).includes(env.dir), 'Pfad im View');
    assert.ok(!JSON.stringify(view).includes('x.invalid'), 'Adresse im View');
    env.clock.ms = Date.parse('2026-10-22T00:00:00Z');
    fs.rmSync(env.service.get(a.id).file);
    view = env.service.list()[0];
    assert.equal(view.sourceExpired, true);
    assert.equal(view.fileMissing, true);
    assert.equal(view.seriesTitle, 'Testserie');
    assert.equal(view.title, 'Folge');
  } finally {
    env.cleanup();
  }
});
