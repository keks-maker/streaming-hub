'use strict';

/**
 * Regressionstest (0.9.1 → 0.9.2): build.files darf keine scripts/*.js
 * ausschließen, die install.sh, updater.js oder main.js zur Laufzeit/Installation
 * brauchen. Bewertung wie electron-builder: Muster der Reihe nach, "!" negiert,
 * der letzte passende Eintrag entscheidet.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patterns = pkg.build.files;

function expandBraces(p) {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.replace(m[0], alt)));
}

function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function isIncluded(file) {
  let included = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const body = neg ? raw.slice(1) : raw;
    // "dir{,/**}" und "dir/**/*" erfassen auch den Ordner selbst und alles darunter
    if (expandBraces(body).some((g) => globToRegExp(g).test(file))) included = !neg;
  }
  return included;
}

function referencedScripts() {
  const found = new Set();
  for (const f of ['install.sh', 'updater.js', 'main.js']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/scripts\/[A-Za-z0-9_.-]+\.(?:js|cjs|mjs)/g)) {
      // Kommentarbezüge (z. B. "# scripts/…", "// scripts/…") zählen ebenfalls: konservativ
      found.add(m[0]);
    }
  }
  return [...found];
}

test('Matcher: docs/tests/übrige scripts ausgeschlossen, stage-mac-icon.js enthalten', () => {
  assert.strictEqual(isIncluded('scripts/stage-mac-icon.js'), true);
  assert.strictEqual(isIncluded('scripts/build-renderer.js'), false);
  assert.strictEqual(isIncluded('tests/backup.test.js'), false);
  assert.strictEqual(isIncluded('docs/aufnahme-konzept-v0.4.md'), false);
  assert.strictEqual(isIncluded('main.js'), true);
});

test('install.sh referenziert stage-mac-icon.js', () => {
  assert.ok(referencedScripts().includes('scripts/stage-mac-icon.js'));
});

test('jede referenzierte scripts/*.js liegt im Paket und ist nicht ausgeschlossen', () => {
  for (const rel of referencedScripts()) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} existiert nicht`);
    assert.ok(isIncluded(rel), `${rel} wird von build.files ausgeschlossen (Release-Installation bricht)`);
  }
});
