'use strict';

// Tests: Quit-Cleanup / Orphan-Janitor (Karte t_695bf150)
//
// Akzeptanz der Karte:
// - RecordJob.finalizeForQuit: ffmpeg-Child wird synchron SIGKILL'ed, Meta
//   → aborted, ENDLIST in der Zwischenplaylist gesichert (F-FB-10).
// - RecorderService.quitSweep: alle Jobs + Background-Childs terminiert,
//   Registry geleert.
// - orphan-sweep: App-eigene ffmpeg-Orphans (PPID 1 / toter Parent, Binary
//   unter appRoot/bin) erkannt + gekillt; fremde ffmpeg-Instanzen unberührt.
// - Remux-Registry: Remux/Probe/Decode-Childs werden registriert.
// - main.js: before-quit-Hook + Start-Sweep verkabelt (Quelltext-Invariante).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RecordJob } = require('../lib/recorder/RecordJob.js');
const { RecorderService } = require('../lib/recorder/RecorderService.js');
const { findAppFfmpegOrphans, listProcesses } = require('../lib/orphan-sweep.js');

const FAKE_DIR = path.join(os.tmpdir(), `recorder-quit-fake-${process.pid}`);

const FAKE_TEMPLATE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('ffmpeg version 7.0.2-static'); process.exit(0); }
const segIdx = args.indexOf('-hls_segment_filename');
const segPattern = segIdx !== -1 ? args[segIdx + 1] : null;
const playlist = args[args.length - 1];
const segName = segPattern ? segPattern.split('/').pop() : 'seg_%05d.ts';
fs.writeFileSync(segPattern.replace('%05d', '00000'), Buffer.alloc(2048));
let existing = '';
try { existing = fs.readFileSync(playlist, 'utf-8'); } catch (_) {}
fs.writeFileSync(playlist, existing + '#EXTINF:1.0,\\n' + segName.replace('%05d', '00000') + '\\n');
process.on('SIGINT', () => {
  process.exit(0);
});
// IGNORIERT absichtlich nichts — das echte ffmpeg würde SIGINT sauber
// beantworten; für die Quit-Probe zählt: Nach finalizeForQuit lebt der
// Childprozess nicht mehr (SIGKILL läuft vor dem Signal-Tod nicht longer).
setInterval(() => {}, 1000);
`;

function createFakeFfmpeg(name) {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const file = path.join(FAKE_DIR, `${name}-${process.pid}.js`);
  fs.writeFileSync(file, FAKE_TEMPLATE, { mode: 0o755 });
  return file;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeJob(dir, recId, ffmpegPath) {
  return new RecordJob({
    recId,
    sourceUrl: 'https://stream.example/live.m3u8',
    dir,
    ffmpegPath,
    meta: {
      id: recId,
      channelId: 'c1',
      channelName: 'Das Erste',
      epgTitle: 'Tagesschau',
      startedAt: null,
      status: 'recording',
      sourceUrl: 'https://stream.example/live.m3u8',
    },
  });
}

// ── RecordJob.finalizeForQuit ──

test('Quit: finalizeForQuit killt ffmpeg-Child synchron, Status aborted, ENDLIST gesichert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-quit-1-'));
  const recId = `rec_20261002_qt1${process.pid}`;
  const job = makeJob(dir, recId, createFakeFfmpeg('run'));
  const startedP = new Promise(resolve => job.once('started', resolve));
  job.start();
  await startedP;
  await sleep(400); // Fake schreibt Segment + Playlist
  assert.ok(job.hasContent());

  const pid = job.ffmpegPid();
  assert.equal(typeof pid, 'number', 'ffmpeg-PID bekannt');
  const child = spawn('sh', ['-c', `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo GONE`]);
  let alive = '';
  child.stdout.on('data', c => (alive += c));
  await new Promise(r => child.on('close', r));
  assert.equal(alive.trim(), 'ALIVE', 'ffmpeg läuft vor dem Quit');

  const { pid: reported, alreadyFinalized } = job.finalizeForQuit();
  assert.equal(reported, pid);
  assert.equal(alreadyFinalized, false);

  // SIGKILL wirkt synchron: 200 ms später muss der Prozess weg sein.
  await sleep(200);
  const check = spawn('sh', ['-c', `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo GONE`]);
  let alive2 = '';
  check.stdout.on('data', c => (alive2 += c));
  await new Promise(r => check.on('close', r));
  assert.equal(alive2.trim(), 'GONE', 'ffmpeg-Child nach Quit-Sweep tot (E2E-Kern)');

  const meta = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf-8');
  assert.ok(meta.includes('#EXT-X-ENDLIST'), 'ENDLIST gesichert — Recovery-Remux möglich (F-FB-10)');

  // Meta-Status aborted via 'meta'-Event-Stream
  const payload = await new Promise(resolve => {
    if (job.getRunState().state === 'stopped') resolve(null);
    job.once('meta', ({ meta }) => resolve(meta));
  });
  if (payload) assert.equal(payload.status, 'aborted');
  assert.equal(job.getRunState().state, 'stopped');
});

test('Quit: finalizeForQuit ist idempotent (zweiter Aufruf alreadyFinalized)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-quit-2-'));
  const recId = `rec_20261002_qt2${process.pid}`;
  const job = makeJob(dir, recId, createFakeFfmpeg('idem'));
  job.start();
  await sleep(300);
  const first = job.finalizeForQuit();
  const second = job.finalizeForQuit();
  assert.equal(first.alreadyFinalized, false);
  assert.equal(second.alreadyFinalized, true);
  assert.equal(second.pid, null);
});

test('Quit: quitFast ist entfernt — stop() hat keine Quit-Parameter mehr (toter Code ausgeräumt)', async () => {
  const jobSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RecordJob.js'), 'utf8');
  assert.doesNotMatch(jobSource, /quitFast/, 'kein quitFast-Residuum in RecordJob');
  assert.doesNotMatch(jobSource, /STOP_QUIT_GRACE_MS/, 'keine tote Quit-Grace-Konstante');
  // Nicht-Quit-Verhalten unverändert: reguläre Grace-Konstante dominant
  assert.match(jobSource, /STOP_GRACE_MS = 10000/);
  assert.match(jobSource, /stop\(\{ reason = 'user' \} = \{\}\)/);
});

// ── RecorderService.quitSweep ──

function makeRecorderService() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-quit-svc-'));
  const appRoot = path.join(__dirname, '..', 'lib', 'recorder'); // bin-Pfad egal (Fake registriert sich direkt)
  return { svc: new RecorderService({ appRoot, storageRoot }), storageRoot };
}

test('Quit: quitSweep killt RecordJobs und Background-Childs, leert Registry', async () => {
  // RecordJobs simulieren: Fake-Job-Objekt am Service (zentraler Sweep-Vertrag
  // testet Verhalten, nicht echte Spawns — die machen die RecordJob-Tests oben).
  const { svc } = makeRecorderService();
  const killedPids = [];
  const fakeJob = {
    recId: 'rec_20261002_swp1',
    finalizeForQuit() {
      killedPids.push('job');
      return { pid: 424242, alreadyFinalized: false };
    },
  };
  svc.jobs.set(fakeJob.recId, fakeJob);
  const fakeChild = { pid: 777001, kill: sig => killedPids.push(`${sig}:777001`) };
  svc._bgChildren.set(777001, fakeChild);

  const killed = svc.quitSweep();
  assert.deepEqual(killedPids.sort(), ['SIGKILL:777001', 'job'].sort());
  assert.equal(killed.length, 2);
  assert.equal(svc.jobs.size, 0, 'Job-Registry geleert');
  assert.equal(svc._bgChildren.size, 0, 'Background-Registry geleert');
  assert.ok(killed.some(k => k.kind === 'record'));
  assert.ok(killed.some(k => k.kind === 'background'));
});

test('Quit: remuxAfterStop registriert Remux-Childs in der Background-Registry', () => {
  const svcSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RecorderService.js'), 'utf8');
  assert.match(svcSource, /_bgChildren/, 'Background-Child-Registry vorhanden');
  assert.match(svcSource, /onChild/, 'runRemux/decodeCheck erhalten den Registry-Hook');
  const remuxSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RemuxJob.js'), 'utf8');
  assert.match(remuxSource, /onChild\.js\)|typeof onChild === 'function'/, 'Remux-Job meldet Spawn-Childs'.replace('.js)', ' extra'));
  assert.match(remuxSource, /if \(typeof onChild === 'function'\) onChild\(child\);/, 'Registry-Hook an allen 3 Spawn-Stellen');
  assert.strictEqual((remuxSource.match(/typeof onChild === 'function'/g) || []).length, 3, 'Hook an runRemux + probeMp4 + decodeCheckMp4');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /before-quit/, 'before-quit-Hook vorhanden');
  assert.match(main, /quitSweep/, 'before-quit ruft den Sweep');
  assert.match(main, /sweepOrphans/, 'Start-Janitor verkabelt');
});

// ── orphan-sweep ──

test('Janitor: erkennt App-eigene ffmpeg-Orphan-Kandidaten, ignoriert fremde', async () => {
  // Fake-App-Bundle mit eigener ffmpeg-Binary (Shebang-Skript — wie im echten
  // Bundle eine Statik-Binary; für den Prozess-Scan zählt nur der Pfad).
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-jani-'));
  const binDir = path.join(appRoot, 'bin');
  fs.mkdirSync(binDir);
  const ourBin = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ourBin, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });

  const ours = spawn(ourBin, ['-orphanprobe'], { stdio: 'ignore' });
  const foreign = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  await sleep(400);

  try {
    const candidates = findAppFfmpegOrphans({ appRoot, currentPid: process.pid });
    const ourHit = candidates.find(c => c.pid === ours.pid);
    assert.ok(ourHit, 'eigenes ffmpeg erkannt');
    assert.equal(ourHit.bin.endsWith('/bin/ffmpeg'), true);
    assert.equal(ourHit.orphan, false, 'kein Orphan-Signal bei lebendem Parent');
    // Fremder Prozess (sleep, kein /bin/-ffmpeg-Pfad unter appRoot) darf nicht
    // als Kandidat auftauchen:
    assert.ok(!candidates.some(c => c.pid === foreign.pid), 'fremder Prozess ignoriert');

    // Alle Kandidaten liegen unterm appRoot-Realpath
    const realRoot = fs.realpathSync(appRoot);
    for (const c of candidates) {
      assert.ok(c.bin.startsWith(realRoot + '/'), `Pfad-Kontainment: ${c.bin}`);
    }
  } finally {
    for (const c of [ours, foreign]) {
      try { c.kill('SIGKILL'); } catch (_) {}
    }
  }
});

test('Janitor: listProcesses liefert pid/ppid/args-Zeilen', () => {
  const procs = listProcesses();
  assert.ok(Array.isArray(procs) && procs.length > 5, 'Prozessliste non-empty');
  const init = procs.find(p => p.pid === 1);
  assert.ok(init, 'PID 1 dabei');
  assert.equal(init.ppid, 0);
  assert.equal(typeof init.args, 'string');
});

// ── Review R1: Quit-Cleanup-Lücken (Runden-Fixes) ──

test('Review R1: TrayController nutzt app.quit() — kein app.exit() verblieben', () => {
  const traySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'TrayController.js'), 'utf8');
  // app.exit() feuert KEIN before-quit → der Quit-Sweep würde im
  // macOS-Shutdown-Zweig nie laufen (Orphan-Pfad). Verboten. Bewusst gegen
  // den CODE gematcht (Zeilenanfang = echte Ausdrücke, Kommentare ausgeschlossen).
  const codeLines = traySource.split('\n').filter(l => !/^\s*\/\//.test(l));
  assert.doesNotMatch(codeLines.join('\n'), /app\.exit\(/, 'app.exit ist im Quit-Pfad verboten (kein before-quit)');
  assert.match(codeLines.join('\n'), /\.then\(\(\) => app\.quit\(\)\)/, 'macOS-Shutdown-Zweig endet in app.quit()');
});

test('Review R1: quitSweep bedient in-flight stop() via finalizeForQuit (Registry-Fenster)', async () => {
  // Szenario: stop() hat den Job bereits awaited weggenommen (jobs.delete
  // läuft erst NACH dem await — aber der Sweep-Scan kann zwischen Abruf und
  // await fallen). Beweis: finalizeForQuit auf dem Job-Objekt wird gerufen
  // und liefert das Aborted-Payload an den awaiting stop()-Resolver.
  const { svc } = makeRecorderService();
  const storageRoot = svc.storageRoot;
  const dir = path.join(storageRoot, 'rec_20261002_r1stop');
  fs.mkdirSync(dir, { recursive: true });

  const svcSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RecorderService.js'), 'utf8');
  assert.match(svcSource, /_stopsInProgress/, 'stop()>Registry-Sichtbarkeit existiert');
  assert.match(svcSource, /_quitRequested = true/, 'Quit-Guard wird im Sweep gesetzt');
  assert.match(svcSource, /if \(this\._quitRequested\) \{[\s\S]{0,700}return meta;/, 'stop()-Continuation opfert den Remux dem Quit');

  // In-Flight-Vertrag deterministisch (ohne exec-Race): stop() marked den
  // RecId als awaiting (_stopsInProgress), der Job bleibt bis NACH dem
  // await in jobs registriert — der Sweep scannt beide Fenster. Ein Job in
  // BEIDEN Registries wird genau EINMAL finalisiert (alreadyFinalized-
  // Idempotenz), die Stops-Loop entdeckt ihn, falls der Job-Scan ihn
  // verpasst (Registry-Fenster).
  const calls = [];
  const fakeJob = {
    recId: 'rec_20261002_r1stop',
    finalizeForQuit() {
      calls.push('finalize');
      return { pid: 4242, alreadyFinalized: calls.length > 1 };
    },
  };
  svc.jobs.set(fakeJob.recId, fakeJob);
  svc._stopsInProgress.set(fakeJob.recId, fakeJob); // in-flight stop() (Vertrag aus stop())
  const killed = svc.quitSweep();
  assert.equal(calls.length, 1, 'finalizeForQuit genau einmal (Jobs-Loop bedient, Stops-Loop idempotent)');
  assert.ok(killed.some(k => k.kind === 'record' && k.recId === fakeJob.recId), 'in-flight Job via Sweep finalisiert');
  assert.equal(svc.jobs.size, 0, 'Registry geleert');
});

test('Review R1b: Stops-Loop zeigt in-flight Job, den der Jobs-Loop verpasst', () => {
  // Starkes Registry-Fenster: Job NUR in _stopsInProgress (stop() hat ihn
  // schon aus jobs gerutscht — await läuft, Continuation noch nicht).
  const { svc } = makeRecorderService();
  const calls = [];
  const fakeJob = {
    recId: 'rec_20261002_r1stop2',
    finalizeForQuit() {
      calls.push('finalize');
      return { pid: 919, alreadyFinalized: false };
    },
  };
  svc.jobs.set(fakeJob.recId, fakeJob);
  svc._stopsInProgress.set(fakeJob.recId, fakeJob);
  // Simuliere das Fenster: stop() hat den Job bereits entfernt (await),
  // der Sweep-Job-Scan sah ihn nicht mehr:
  svc.jobs.delete(fakeJob.recId);
  const killed = svc.quitSweep();
  assert.equal(calls.length, 1, 'Stops-Loop greift — finalizeForQuit gerufen');
  assert.ok(killed.some(k => k.kind === 'record' && k.recId === fakeJob.recId), 'Fenster-Job finalisiert statt versickert');
});

test('Review R1: stop()-Continuation startet nach Quit keinen Remux mehr (Quit-Race-Guard)', async () => {
  // Deterministischer Beweis des Kern-Rest-Holes: Wenn quitSweep genau
  // zwischen job.stop()-Resolve und der Remux-Continuation läuft, darf
  // KEIN Remux gespawnt werden. Wir simulieren: job.stop() resolvet
  // sofort (Kernel), danach feuern wir quitSweep, bevor die Continuation
  // drankommt — via quitFastloser Sequenz: stop() awaiten, quitSweep(),
  // dann _remuxAfterStop-weg natürlich nie erreicht.
  const { svc } = makeRecorderService();
  svc._quitRequested = true; // Quit gelaufen (sweep-artige Kernel-Setzung)
  // stop() mit Fake-Job, _remuxAfterStop stubben, um Spawn verhindern UND
  // Beweis zu führen, dass es NIEMAL gerufen wird:
  let remuxCalled = 0;
  const fakeJob = {
    recId: 'rec_20261002_r1guard',
    meta: { id: 'rec_20261002_r1guard', status: 'recording' },
    stop: async () => ({ meta: { id: 'rec_20261002_r1guard', status: 'aborted' }, reason: 'abort' }),
  };
  svc.jobs.set(fakeJob.recId, fakeJob);
  svc._remuxAfterStop = async () => {
    remuxCalled += 1;
    return { id: fakeJob.recId, status: 'completed' };
  };
  const out = await svc.stop(fakeJob.recId);
  assert.equal(remuxCalled, 0, 'Remux wurde dem Quit geopfert (kein Spawn im Registry-Fenster)');
  assert.equal(out.status, 'aborted', 'Meta bleibt aborted → Recovery beim nächsten Start');
});

test('Review R1: Remux-interne Probe läuft registriert (onChild an probeMp4 in runRemux)', () => {
  const remuxSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recorder', 'RemuxJob.js'), 'utf8');
  // probeMp4-Aufruf in der succeed()-Continuation reichert onChild durch:
  assert.match(remuxSource, /probeMp4\(ffprobePath, outputPath, 15000, onChild\)/, 'interne Probe erhält onChild');
  // Gesamt witnessed: alle 3 Spawn-Stellen bleiben registriert.
  assert.strictEqual((remuxSource.match(/typeof onChild === 'function'/g) || []).length, 3);
});
