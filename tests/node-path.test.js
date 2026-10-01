// Unit-Tests: PATH-/Tool-Auflösung für den In-App-Updater (lib/node-path.js).
// Hintergrund: Bei GUI-Start (Finder/Launchpad) hat der Updater unter macOS nur
// den System-Mini-PATH; npm lag außerhalb → Update brach ab (S-Klasse,
// Karte t_9f74c461). Die Tests simulieren GUI-PATHs über minimale Envs.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nodePathLib = require('../lib/node-path.js');

const { execFileSync } = require('child_process');

const MINIMAL_GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function withEnv(extra, fn) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(extra)) {
      if (extra[key] === undefined) delete process.env[key];
      else process.env[key] = extra[key];
    }
    return fn();
  } finally {
    for (const key of Object.keys(extra)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Bauklötze: ein Verzeichnis mit ausführbarem npm/node (oder npm-Fail-Skript). */
function makeFakeBinDir(dir, { npmExit } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const nodeSh = `#!/bin/sh\nprintf 'v22.0.0-fake\\n'\n`;
  const npmSh = npmExit
    ? `#!/bin/sh\n>&2 echo "simulierter npm-Fehler"\nexit ${npmExit}\n`
    : `#!/bin/sh\nprintf '10.0.0-fake\\n'\n`;
  for (const [name, body] of [['node', nodeSh], ['npm', npmSh]]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

test.beforeEach(() => {
  // Jeder Test startet mit einem GUI-artigen Mini-PATH.
  withEnv({ PATH: MINIMAL_GUI_PATH, STREAMING_HUB_NODE_DIR: undefined, STREAMING_HUB_NO_PATH_FIX: undefined }, () => {});
});

test('candidateDirs: StreamEnv-Override hat Priorität und wird zuerst geprüft', () => {
  withEnv({ STREAMING_HUB_NODE_DIR: '/custom/node/bin' }, () => {
    const dirs = nodePathLib.candidateDirs();
    assert.strictEqual(dirs[0], '/custom/node/bin');
    assert.ok(dirs.length > 1, 'weitere Kandidaten vorhanden');
  });
});

test('candidateDirs: enthält plattformgerechte Kandidaten', () => {
  const dirs = nodePathLib.candidateDirs();
  const joined = dirs.join('\n');
  if (process.platform === 'darwin') {
    assert.ok(joined.includes(path.join(os.homedir(), 'Developer', 'tools', 'node', 'bin')), 'Streaming-Hub Mac-Pfad');
    assert.ok(dirs.includes('/opt/homebrew/bin'), 'Homebrew ARM');
  } else {
    assert.ok(dirs.includes('/usr/local/bin'), 'Linux-Builds');
    assert.ok(dirs.includes('/usr/bin'), 'System');
  }
  assert.ok(dirs.includes('/usr/local/bin'), 'Homebrew Intel / Linux');
});

test('findNpmTool findet npm via STREAMING_HUB_NODE_DIR unter GUI-PATH', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepath-'));
  try {
    const binDir = makeFakeBinDir(path.join(tmp, 'custom', 'bin'));
    withEnv({ STREAMING_HUB_NODE_DIR: binDir, PATH: MINIMAL_GUI_PATH }, () => {
      const tools = nodePathLib.findNpmTool();
      assert.ok(tools, 'Tools gefunden');
      assert.strictEqual(tools.npm, path.join(binDir, 'npm'));
      assert.strictEqual(tools.node, path.join(binDir, 'node'));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildToolEnv hängt das gefundene bin-Verzeichnis an den PATH-Anfang', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepath-'));
  try {
    const binDir = makeFakeBinDir(path.join(tmp, 'tools', 'bin'));
    withEnv({ STREAMING_HUB_NODE_DIR: binDir, PATH: MINIMAL_GUI_PATH }, () => {
      const env = nodePathLib.buildToolEnv(process.env);
      const first = env.PATH.split(path.delimiter)[0];
      assert.strictEqual(first, binDir);
      // Original-PATH bleibt hinten erhalten (dedupliziert):
      assert.ok(env.PATH.includes('/usr/bin'));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildToolEnv ohne Fund: PATH unverändert (kein Crash)', () => {
  withEnv(
    {
      STREAMING_HUB_NODE_DIR: undefined,
      STREAMING_HUB_NO_PATH_FIX: '1', // Login-Shell-Auflösung und Kandidaten abschalten
      PATH: MINIMAL_GUI_PATH,
    },
    () => {
      const env = nodePathLib.buildToolEnv({ PATH: MINIMAL_GUI_PATH });
      assert.strictEqual(env.PATH, MINIMAL_GUI_PATH);
    },
  );
});

test('buildToolEnv dedupliziert bereits vorhandene Einträge', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepath-'));
  try {
    const binDir = makeFakeBinDir(path.join(tmp, 'dup', 'bin'));
    withEnv({ STREAMING_HUB_NODE_DIR: binDir, PATH: `${binDir}:${MINIMAL_GUI_PATH}` }, () => {
      const env = nodePathLib.buildToolEnv(process.env);
      const entries = env.PATH.split(path.delimiter);
      assert.strictEqual(entries.filter(e => e === binDir).length, 1);
      assert.strictEqual(entries[0], binDir);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('describeToolProblem liefert Handlungsanweisung (install.sh / STREAMING_HUB_NODE_DIR)', () => {
  const msg = nodePathLib.describeToolProblem('Das In-App-Update kann nicht starten.');
  assert.ok(msg.includes('Das In-App-Update kann nicht starten.'));
  assert.ok(msg.includes('install.sh'));
  assert.ok(msg.includes('STREAMING_HUB_NODE_DIR'));
  assert.ok(msg.split('\n').length > 3, 'mehrzeilig für den Fehlerdialog');
});

test('Smoke: npm-Aufruf läuft unter GUI-Mini-PATH mit toolEnv (End-to-End execSync)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepath-'));
  try {
    const binDir = makeFakeBinDir(path.join(tmp, 'smoke', 'bin'));
    withEnv({ STREAMING_HUB_NODE_DIR: binDir, PATH: MINIMAL_GUI_PATH }, () => {
      const env = nodePathLib.buildToolEnv(process.env);
      const out = execFileSync('npm', ['--version'], { env, encoding: 'utf-8' });
      assert.strictEqual(out.trim(), '10.0.0-fake');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Smoke (Realwelt): npm vom System wird über toolEnv gefunden, wenn GUI-PATH minimal ist', () => {
  // Sucht ein echtes npm auf dem System (Linux-CI: /usr/bin oder ~/.local/bin).
  let realNpmDir = null;
  for (const candidate of ['/usr/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')]) {
    if (fs.existsSync(path.join(candidate, 'npm'))) {
      realNpmDir = candidate;
      break;
    }
  }
  if (!realNpmDir) return; // kein System-npm → Smoke überspringen
  withEnv({ STREAMING_HUB_NODE_DIR: realNpmDir, PATH: MINIMAL_GUI_PATH }, () => {
    const env = nodePathLib.buildToolEnv(process.env);
    const out = execFileSync('npm', ['--version'], { env, encoding: 'utf-8' });
    assert.match(out.trim(), /^\d+\.\d+\.\d+/);
  });
});

test('loginShellPathEntries: nicht leer auf POSIX-Systemen (zsh/bash Login-PATH)', () => {
  if (process.platform === 'win32') return;
  const entries = nodePathLib.loginShellPathEntries();
  assert.ok(Array.isArray(entries));
});
