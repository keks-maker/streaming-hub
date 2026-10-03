const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, removeRunTmp, createRunTmp, PREFIX } = require('../scripts/with-tmp.js');

const WRAPPER = path.join(__dirname, '..', 'scripts', 'with-tmp.js');
// Eigene Sandbox als "Temp-Root"; wird am Ende vom Test selbst entfernt.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sandbox-')));
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const entries = () => fs.readdirSync(sandbox).sort();

test('Erfolg: TMPDIR/TMP/TEMP zeigen auf Run-Verzeichnis, danach weg, Exit 0', async () => {
  const foreign = fs.mkdtempSync(path.join(sandbox, 'fremd-'));
  const before = entries();
  const code = await run(
    [
      process.execPath,
      '-e',
      `const fs=require('fs'),p=require('path');
       const d=process.env.TMPDIR;
       if(!d||d!==process.env.TMP||d!==process.env.TEMP||p.dirname(d)!==${JSON.stringify(sandbox)}||!p.basename(d).startsWith(${JSON.stringify(PREFIX)})) process.exit(9);
       fs.writeFileSync(p.join(d,'x.txt'),'x'); fs.mkdirSync(p.join(d,'sub'));`,
    ],
    { root: sandbox },
  );
  assert.equal(code, 0);
  assert.deepEqual(entries(), before, 'nur Run-Verzeichnis entfernt, Fremdes bleibt');
  assert.ok(fs.existsSync(foreign));
});

test('Exit-Code ungleich 0 wird durchgereicht und aufgeräumt', async () => {
  const code = await run([process.execPath, '-e', `require('fs').writeFileSync(process.env.TMPDIR+'/a','1');process.exit(7)`], {
    root: sandbox,
  });
  assert.equal(code, 7);
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 0);
});

test('Kind-Abbruch per Signal: Exit 128+n und aufgeräumt', async () => {
  const code = await run([process.execPath, '-e', `process.kill(process.pid,'SIGKILL')`], { root: sandbox });
  assert.equal(code, 137);
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 0);
});

test('Nicht startbares Kommando: Exit 127 und aufgeräumt', async () => {
  const code = await run(['/nicht/vorhanden/kommando'], { root: sandbox });
  assert.equal(code, 127);
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 0);
});

test('Read-only Unterordner im Run-Verzeichnis blockieren das Aufräumen nicht', async () => {
  const code = await run(
    [
      process.execPath,
      '-e',
      `const fs=require('fs'),p=require('path');const d=p.join(process.env.TMPDIR,'ro');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'f'),'1');fs.chmodSync(d,0o555);`,
    ],
    { root: sandbox },
  );
  assert.equal(code, 0);
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 0);
});

test('SIGTERM an den Wrapper: Kind wird beendet, Verzeichnis entfernt', async () => {
  const child = spawn(
    process.execPath,
    [WRAPPER, '--', process.execPath, '-e', `console.log('ready');setInterval(()=>{},1000)`],
    { env: { ...process.env, TMPDIR: sandbox }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise(resolve => child.stdout.on('data', d => String(d).includes('ready') && resolve()));
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 1);
  const exit = new Promise(resolve => child.on('close', code => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exit, 143);
  assert.equal(entries().filter(n => n.startsWith(PREFIX)).length, 0);
});

test('Löschen außerhalb des erwarteten Pfads wird verweigert', () => {
  const inner = fs.mkdtempSync(path.join(sandbox, 'fremd-'));
  assert.throws(() => removeRunTmp(inner, sandbox), /Präfix/);
  assert.ok(fs.existsSync(inner));

  const nested = path.join(createRunTmp(sandbox), 'tief');
  fs.mkdirSync(nested);
  assert.throws(() => removeRunTmp(nested, sandbox), /nicht direkt unter/);
  assert.throws(() => removeRunTmp(sandbox, sandbox), /nicht direkt unter/);
  assert.throws(() => removeRunTmp(path.join(os.tmpdir(), `${PREFIX}x`), sandbox), /nicht direkt unter/);
  removeRunTmp(path.dirname(nested), sandbox);
});

test('Symlink mit passendem Namen wird nicht gelöscht und nicht verfolgt', () => {
  const target = fs.mkdtempSync(path.join(sandbox, 'ziel-'));
  fs.writeFileSync(path.join(target, 'wichtig.txt'), 'bleibt');
  const link = path.join(sandbox, `${PREFIX}link`);
  fs.symlinkSync(target, link);
  assert.throws(() => removeRunTmp(link, sandbox), /kein echtes Verzeichnis/);
  assert.ok(fs.existsSync(path.join(target, 'wichtig.txt')));
  fs.unlinkSync(link);
});
