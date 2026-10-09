'use strict';

// Tests: Wake-Helfer (lib/recorder/wake-helper.sh) mit MOCK-pmset in einem
// Temp-Verzeichnis — kein osascript, kein echtes pmset, kein root. Plus
// WakeHelperClient mit gefaktem execFile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HELPER_SCRIPT } = require('../lib/recorder/wake-helper-script.js');
const { WakeHelperClient, shellQuote } = require('../lib/recorder/WakeHelperClient.js');

const TOKEN = 'a'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));
  const log = path.join(base, 'pmset.log');
  const pmset = path.join(base, 'pmset-mock');
  fs.writeFileSync(pmset, `#!/bin/sh\nprintf '%s|' "$@" >> '${log}'\necho >> '${log}'\n`, { mode: 0o755 });
  const dir = path.join(base, `streaminghub-wake-${process.getuid()}-${TOKEN}`);
  return { base, log, pmset, dir, fifo: path.join(dir, 'cmd') };
}

function startHelper(env, { appPid = process.pid, token = TOKEN } = {}) {
  return spawn('/bin/sh', ['-c', HELPER_SCRIPT, 'h', String(process.getuid()), String(appPid), token, env.pmset, env.base], {
    stdio: 'ignore',
  });
}

async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(40);
  }
  return false;
}

function sendLine(fifo, line) {
  const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  fs.writeSync(fd, line + '\n');
  fs.closeSync(fd);
}

const readLog = env => (fs.existsSync(env.log) ? fs.readFileSync(env.log, 'utf8').trim().split('\n').filter(Boolean) : []);

test('Helfer: Verzeichnis root-Muster, FIFO nur für die UID (0600), pmset-Aufträge exakt', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const child = startHelper(env);
  try {
    assert.ok(await waitFor(() => fs.existsSync(env.fifo)), 'FIFO entsteht');
    const dirStat = fs.statSync(env.dir);
    assert.equal(dirStat.mode & 0o777, 0o711);
    const fifoStat = fs.statSync(env.fifo);
    assert.ok(fifoStat.isFIFO());
    assert.equal(fifoStat.mode & 0o777, 0o600);
    assert.equal(fifoStat.uid, process.getuid());

    sendLine(env.fifo, 'wake 10/13/26 02:08:00');
    sendLine(env.fifo, 'cancel 10/13/26 02:08:00');
    assert.ok(await waitFor(() => readLog(env).length >= 2));
    assert.deepEqual(readLog(env), [
      'schedule|wake|10/13/26 02:08:00|StreamingHub|',
      'schedule|cancel|wake|10/13/26 02:08:00|StreamingHub|',
    ]);

    sendLine(env.fifo, 'quit');
    assert.ok(await waitFor(() => !fs.existsSync(env.dir)), 'Verzeichnis wird aufgeräumt');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('Helfer: Injection- und Formatversuche werden verworfen', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const child = startHelper(env);
  try {
    assert.ok(await waitFor(() => fs.existsSync(env.fifo)));
    const bad = [
      'wake 10/13/26 02:08:00; touch /tmp/pwned',
      'wake $(id)',
      'wake `id`',
      'wake 10/13/26 02:08:00 extra',
      'wake 13/13/26 02:08:00',
      'wake 10/32/26 02:08:00',
      'wake 10/13/26 24:08:00',
      'wake 10/13/26 02:60:00',
      'wake 10/13/2026 02:08:00',
      'wake  10/13/26 02:08:00',
      'wake *',
      'cancelall',
      'cancel wake 10/13/26 02:08:00',
      'schedule wake 10/13/26 02:08:00',
      '-a',
      'wake 10/13/26\t02:08:00',
      'wake ' + 'x'.repeat(200),
      '',
    ];
    for (const line of bad) sendLine(env.fifo, line);
    // Wächter: gültiger Auftrag danach beweist, dass alles Vorherige abgearbeitet wurde
    sendLine(env.fifo, 'wake 12/31/26 23:59:00');
    assert.ok(await waitFor(() => readLog(env).length >= 1));
    await sleep(150);
    assert.deepEqual(readLog(env), ['schedule|wake|12/31/26 23:59:00|StreamingHub|']);
    assert.ok(!fs.existsSync('/tmp/pwned'));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('Helfer: ungültige Argumente (UID/PID/Token/Basis) brechen ab, legen nichts an', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  try {
    const run = args =>
      new Promise(resolve => {
        const c = spawn('/bin/sh', ['-c', HELPER_SCRIPT, 'h', ...args], { stdio: 'ignore' });
        c.on('exit', code => resolve(code));
      });
    const uid = String(process.getuid());
    assert.equal(await run(['1; id', '1', TOKEN, env.pmset, env.base]), 2);
    assert.equal(await run([uid, 'x', TOKEN, env.pmset, env.base]), 2);
    assert.equal(await run([uid, '1', '../../../etc', env.pmset, env.base]), 2);
    assert.equal(await run([uid, '1', 'A'.repeat(32), env.pmset, env.base]), 2);
    assert.equal(await run([uid, '1', TOKEN, env.pmset, 'relativ']), 2);
    assert.equal(await run([uid, '1', TOKEN, '/nicht/vorhanden', env.base]), 2);
    assert.deepEqual(fs.readdirSync(env.base).filter(n => n.startsWith('streaminghub')), []);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('Helfer: existiert das Verzeichnis schon (Symlink-Angriff), bricht er ab', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-victim-'));
  try {
    fs.symlinkSync(victim, env.dir);
    const code = await new Promise(resolve => {
      const c = startHelper(env);
      c.on('exit', resolve);
    });
    assert.equal(code, 3);
    assert.deepEqual(fs.readdirSync(victim), []);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

test('Helfer: beendet sich und räumt auf, wenn die App-PID endet', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const app = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const child = startHelper(env, { appPid: app.pid });
  try {
    assert.ok(await waitFor(() => fs.existsSync(env.fifo)));
    app.kill('SIGKILL');
    assert.ok(await waitFor(() => !fs.existsSync(env.dir), 8000), 'Aufräumen nach App-Ende');
    assert.ok(await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000), 'Helfer beendet');
  } finally {
    app.kill('SIGKILL');
    child.kill('SIGKILL');
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('Helfer: räumt verwaiste Verzeichnisse toter Helfer früherer Läufe auf', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const stale = path.join(env.base, `streaminghub-wake-${process.getuid()}-${'b'.repeat(32)}`);
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'pid'), '999999\n');
  const child = startHelper(env);
  try {
    assert.ok(await waitFor(() => fs.existsSync(env.fifo)));
    assert.ok(!fs.existsSync(stale));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

// ── Client ──

test('Client: privilegierter Befehl enthält nur feste Tokens, Skript korrekt gequotet', () => {
  const client = new WakeHelperClient({ platform: 'darwin', getUid: () => 501, pid: 4242 });
  const cmd = client.buildCommand(TOKEN);
  assert.ok(cmd.startsWith("/bin/sh -c '"));
  assert.ok(cmd.endsWith(` streaminghub-wake-helper '501' '4242' '${TOKEN}' '/usr/bin/pmset' '/var/run' >/dev/null 2>&1 &`));
  assert.ok(!cmd.includes(os.userInfo().username) || os.userInfo().username.length < 3);
  assert.throws(() => client.buildCommand('nicht-hex'));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  // Das Skript lässt sich aus dem Quoting verlustfrei zurückgewinnen
  const body = cmd.slice("/bin/sh -c ".length, cmd.indexOf(" streaminghub-wake-helper"));
  assert.equal(body.slice(1, -1).replace(/'\\''/g, "'"), HELPER_SCRIPT);
});

test('Client: Linux/Windows no-op ohne osascript-Aufruf', async () => {
  let called = false;
  const client = new WakeHelperClient({ platform: 'linux', execFile: () => (called = true) });
  const r = await client.start();
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.equal(client.send('wake', '10/13/26 02:08:00'), false);
  assert.equal(client.sweepOrphans(), 0);
});

test('Client: start ruft osascript mit Befehl als Argument, Abbruch wird erkannt', async () => {
  const calls = [];
  const client = new WakeHelperClient({
    platform: 'darwin',
    getUid: () => 501,
    pid: 7,
    randomToken: () => TOKEN,
    execFile: (file, args, opts, cb) => {
      calls.push({ file, args });
      cb(Object.assign(new Error('x'), { code: 1 }), '', 'execution error: User canceled. (-128)');
    },
  });
  const r = await client.start();
  assert.deepEqual([r.ok, r.cancelled], [false, true]);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.equal(calls[0].args[calls[0].args.length - 1], client.buildCommand(TOKEN));
});

test('Client: send validiert Verb und Datum; ohne Kanal false', () => {
  const client = new WakeHelperClient({ platform: 'darwin' });
  client.fifo = '/nirgendwo/cmd';
  assert.equal(client.send('wake', '10/13/26 02:08:00; id'), false);
  assert.equal(client.send('quit', '10/13/26 02:08:00'), false);
  assert.equal(client.send('wake', '10/13/26 02:08:00'), false); // FIFO nicht erreichbar
  assert.equal(client.isActive(), false);
});

test('Client mit echtem Helfer (Mock-pmset): start-Pfad, send, quit, sweepOrphans', { skip: process.platform === 'win32' }, async () => {
  const env = setup();
  const child = startHelper(env);
  try {
    assert.ok(await waitFor(() => fs.existsSync(env.fifo)));
    const client = new WakeHelperClient({ platform: 'darwin', baseDir: env.base });
    // verwaister Helfer des früheren Laufs wird erkannt und beendet
    assert.equal(client.sweepOrphans(), 1);
    assert.ok(await waitFor(() => !fs.existsSync(env.dir)));
    // aktiver Helfer: send funktioniert
    const env2 = { ...env, dir: path.join(env.base, `streaminghub-wake-${process.getuid()}-${'c'.repeat(32)}`) };
    env2.fifo = path.join(env2.dir, 'cmd');
    const child2 = spawn('/bin/sh', ['-c', HELPER_SCRIPT, 'h', String(process.getuid()), String(process.pid), 'c'.repeat(32), env.pmset, env.base], { stdio: 'ignore' });
    try {
      assert.ok(await waitFor(() => fs.existsSync(env2.fifo)));
      client.fifo = env2.fifo;
      assert.equal(client.isActive(), true);
      assert.equal(client.send('wake', '10/13/26 02:08:00'), true);
      assert.ok(await waitFor(() => readLog(env).length >= 1));
      assert.equal(client.quit(), true);
      assert.ok(await waitFor(() => !fs.existsSync(env2.dir)));
      assert.equal(client.isActive(), false);
    } finally {
      child2.kill('SIGKILL');
    }
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});
