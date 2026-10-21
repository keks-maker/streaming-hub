'use strict';

// Wächter: Die App folgt dem Systemdesign (hell/dunkel) über Tokens. Farbliterale dürfen nur in den mit
// `theme-literal:start/end` markierten Bereichen (Token-Paletten, Illustrationen) stehen; alle anderen Regeln nutzen var(--…).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { read, findLiterals, ROOT } = require('./helpers/css-theme.js');

test('CSS: keine Farbliterale außerhalb der Token-Bereiche', () => {
  for (const file of ['styles.css', 'styles-downloads.css']) {
    const hits = findLiterals(read(file));
    assert.deepEqual(hits, [], `${file}: Farbliterale statt Tokens:\n${hits.join('\n')}`);
  }
});

test('HTML-Seiten: Inline-Styles ohne Farbliterale (außer markierte Bereiche)', () => {
  // tv.html ist das Player-Fenster über Video (bleibt dunkel) und trägt seine Palette in einem markierten Bereich; pip.html nutzt die Tokens.
  for (const file of ['index.html', 'pip.html', 'tv.html']) {
    const html = read(file);
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    const hits = findLiterals(styleBlocks);
    assert.deepEqual(hits, [], `${file}: <style> mit Farbliteralen:\n${hits.join('\n')}`);
    const attrs = [...html.matchAll(/\sstyle="([^"]*)"/g)].map(m => m[1]).filter(v => /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/.test(v));
    assert.deepEqual(attrs, [], `${file}: style-Attribute mit Farbliteralen: ${attrs.join(' | ')}`);
  }
});

test('Renderer-JS: keine rgb()-Farbstrings in Inline-Styles (Marken-Hexwerte der Dienste sind Daten, kein Theme)', () => {
  const allowMarker = 'theme-literal';
  const offenders = [];
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !['main.js', 'eslint.config.js'].includes(f))) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    let allowedRegion = false;
    lines.forEach((line, i) => {
      if (line.includes(`${allowMarker}:start`)) allowedRegion = true;
      if (line.includes(`${allowMarker}:end`)) allowedRegion = false;
      if (allowedRegion || line.includes(allowMarker)) return;
      if (/['"`][^'"`]*\brgba?\(\s*\d/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], `rgb()-Literale in JS:\n${offenders.join('\n')}`);
});

test('Navbar: kein seitenbezogener Theme-Mechanismus mehr (folgt dem Systemdesign)', () => {
  assert.doesNotMatch(read('renderer.js'), /pageTheme|LIGHT_THEME_GROUPS|updatePageTheme/);
  assert.doesNotMatch(read('styles.css'), /data-page-theme/);
});

test('Systemdesign: color-scheme light dark am Wurzelelement, Player-Fenster erzwingen dunkel', () => {
  const css = read('styles.css');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/);
  assert.match(css, /\.theme-dark-scope[^{]*\{[^}]*color-scheme:\s*dark/);
  assert.match(read('tv.html'), /<meta name="color-scheme" content="dark">/, 'tv.html: meta color-scheme dark fehlt');
  for (const file of ['index.html', 'pip.html']) {
    assert.match(read(file), /<meta name="color-scheme" content="light dark"\s*\/?>/, `${file}: meta color-scheme light dark fehlt`);
  }
});
