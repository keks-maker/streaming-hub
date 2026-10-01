// Unit-Tests: Versionsauflösung (lib/app-version.js).
// Hintergrund (User-Befund 01.10.): git describe --tags --abbrev=0 zeigt ohne
// lokale Tags den nächsten erreichbaren ALTEN Tag — die App meldete „v0.5.10",
// obwohl v0.5.11-Code lief. Die Fallback-Kette (HEAD-Tag → package.json →
// Electron-Fallback) darf nie eine ältere Version anzeigen.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveAppVersion, versionFromGitTag, versionFromPackageJson } = require('../lib/app-version.js');

let tmpRoot;
let gitEnv;

function sh(cmd, cwd) {
  execFileSync('sh', ['-c', cmd], { cwd, env: gitEnv, stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appversion-'));
  gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example',
  };
});

test.afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Git-Sandbox mit einem Commit; optionaler Tag. */
function makeRepo({ tag, pkgVersion } = {}) {
  const appDir = path.join(tmpRoot, 'app');
  fs.mkdirSync(appDir);
  sh('git init --quiet', appDir);
  writeJson(path.join(appDir, 'package.json'), { name: 'streaming-hub', version: pkgVersion || '0.0.0' });
  fs.writeFileSync(path.join(appDir, 'app.js'), '// app\n');
  sh('git add -A', appDir);
  sh('git commit --quiet -m init', appDir);
  if (tag) sh(`git tag ${tag}`, appDir);
  return appDir;
}

test('versionFromGitTag: exaktes HEAD-Tag wird gefunden (auch ohne describe-fähige Historie)', () => {
  const appDir = makeRepo({ tag: 'v0.5.11' });
  assert.strictEqual(versionFromGitTag(appDir), '0.5.11');
});

test('describe-Fall rekonstruiert: Commits nach dem Tag zeigen NICHT das alte Tag', () => {
  // Das ist die Wurzel des User-Befunds: describe liefert hier v0.5.10,
  // versionFromGitTag korrekt null → Kette fällt auf package.json (0.5.11).
  const appDir = makeRepo({ tag: 'v0.5.10', pkgVersion: '0.5.11' });
  fs.writeFileSync(path.join(appDir, 'app.js'), '// neuere Änderung nach Tag\n');
  sh('git add -A', appDir);
  sh('git commit --quiet -m post-tag-commit', appDir);

  const describeOut = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
    cwd: appDir,
    encoding: 'utf-8',
  }).trim();
  assert.strictEqual(describeOut, 'v0.5.10', 'Reproduktion: describe zeigt das alte Tag');

  assert.strictEqual(versionFromGitTag(appDir), null, 'HEAD trägt kein Tag');
  const result = resolveAppVersion(appDir, '9.9.9-electron');
  assert.strictEqual(result.version, '0.5.11', 'Kette nimmt package.json statt altem Tag');
  assert.strictEqual(result.source, 'package.json');
});

test('versionFromPackageJson: ungültige/fehlende Version → null', () => {
  const appDir = makeRepo({ pkgVersion: 'nicht-semver' });
  assert.strictEqual(versionFromPackageJson(appDir), null);
  const result = resolveAppVersion(appDir, '9.9.9-electron');
  assert.strictEqual(result.version, '9.9.9-electron');
  assert.strictEqual(result.source, 'app-fallback');
});

test('Priorität: HEAD-Tag schlägt package.json', () => {
  const appDir = makeRepo({ tag: 'v1.2.3', pkgVersion: '0.5.11' });
  const result = resolveAppVersion(appDir, '9.9.9-electron');
  assert.strictEqual(result.version, '1.2.3');
  assert.strictEqual(result.source, 'git-tag');
});

test('Kein Git-Repo: Fallback-Kette läuft ohne Crash', () => {
  const plainDir = path.join(tmpRoot, 'plain');
  fs.mkdirSync(plainDir);
  writeJson(path.join(plainDir, 'package.json'), { version: '0.5.12' });
  const result = resolveAppVersion(plainDir, '9.9.9-electron');
  assert.strictEqual(result.version, '0.5.12');
  assert.strictEqual(result.source, 'package.json');
});
