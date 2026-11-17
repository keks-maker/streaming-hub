'use strict';

// WCAG-AA-Prüfung der Farb-Tokens (Text 4,5:1, große/grafische UI 3:1) in beiden Systemdesigns.
// Rechnet direkt auf den Token-Definitionen in styles.css; halbtransparente Farben werden über dem Seitenhintergrund gemischt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectTokens, resolve, contrast } = require('./helpers/css-theme.js');

const tokens = collectTokens(['styles.css']);

function color(name, scheme) {
  assert.ok(name in tokens, `Token ${name} fehlt`);
  const c = resolve(`var(${name})`, tokens, scheme);
  assert.ok(c, `Token ${name} (${scheme}) ist keine einfache Farbe`);
  return c;
}

// [Vordergrund, Fläche, Mindestkontrast, Seitenhintergrund für Transparenz]
const TEXT = 4.5;
const UI = 3;
const SURFACES = ['--surface-inset', '--surface-0', '--surface-3', '--surface-1', '--surface-2', '--surface-nav', '--epg-surface', '--epg-surface-2'];
const PAIRS = [];
for (const s of SURFACES) {
  PAIRS.push(['--text-primary', s, TEXT], ['--text-secondary', s, TEXT], ['--text-muted', s, TEXT]);
  for (const t of ['--violet', '--status-rec', '--status-warn', '--status-ok', '--status-error', '--err-soft', '--green-soft', '--green-accent', '--orange-play']) PAIRS.push([t, s, TEXT]);
}
PAIRS.push(
  ['--brand-red', '--surface-3', TEXT], ['--brand-red', '--surface-0', TEXT],
  ['--epg-dim', '--epg-surface', TEXT], ['--epg-dim', '--epg-surface-2', TEXT], ['--epg-dim', '--epg-block', TEXT],
  ['--text-primary', '--epg-block', TEXT], ['--text-primary', '--epg-block-hover', TEXT], ['--text-primary', '--epg-block-now', TEXT],
  ['--text-primary', '--epg-dayhead', TEXT], ['--text-primary', '--epg-flag', TEXT], ['--text-primary', '--epg-chan-hover', TEXT],
  ['--rec-text', '--epg-surface', TEXT], ['--epg-accent-light', '--epg-surface', TEXT],
  ['--on-accent', '--accent', TEXT], ['--on-accent', '--green-strong', TEXT], ['--on-rec', '--status-rec', TEXT],
  ['--amber-ink', '--amber-fill', TEXT], ['--media-ink', '--scrim-media', TEXT], ['--media-ink', '--scrim-media-strong', TEXT],
  ['--mark-ink', '--mark-bg', TEXT], ['--err-text', '--player-err-bg', TEXT],
  // Mediathek
  ...['--md-bg', '--md-surface', '--md-surface2', '--md-dialog'].flatMap(s => [['--md-text', s, TEXT], ['--md-dim', s, TEXT], ['--md-accent', s, TEXT], ['--md-danger', s, TEXT], ['--md-amber', s, TEXT]]),
  ['--md-btn-ink', '--md-btn-bg', TEXT], ['--md-amber-ink', '--md-amber', TEXT], ['--media-ink', '--md-danger-btn', TEXT],
  // Navigationsleiste: Text/Label und Bereichsfarben auf der Leiste
  ['--nav-text', '--surface-nav', TEXT], ['--nav-btn-fg', '--surface-nav', TEXT],
);
// Genre-Farben tragen Balken/Rahmen (grafisch, Genre steht zusätzlich als Text): 3:1 auf der Fläche
for (const g of ['news', 'sport', 'doku', 'kinder', 'serie', 'film', 'show', 'musik', 'sonstiges']) PAIRS.push([`--genre-${g}`, '--epg-surface', UI], [`--on-genre`, `--genre-${g}`, TEXT]);

for (const scheme of ['dark', 'light']) {
  test(`Kontrast AA im ${scheme === 'dark' ? 'dunklen' : 'hellen'} Design: Token-Paare`, () => {
    const failures = [];
    const base = color('--surface-0', scheme);
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(color(fg, scheme), color(bg, scheme), base);
      if (ratio < min) failures.push(`${fg} auf ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  test(`Kontrast AA im ${scheme === 'dark' ? 'dunklen' : 'hellen'} Design: Bereichsfarben der Navigationsleiste`, () => {
    // Bereichsfarben (area-*) auf der Leiste; Label 11,5 px: Textkontrast 4,5:1
    const css = require('./helpers/css-theme.js').read('styles.css');
    const rows = [...css.matchAll(/\[data-section="(\w+)"\] \{ --nav-c: var\((--area-[\w-]+)\); \}/g)];
    assert.equal(rows.length, 6);
    const failures = [];
    const bar = color('--surface-nav', scheme);
    for (const [, name, token] of rows) {
      const ratio = contrast(color(token, scheme), bar, bar);
      if (ratio < TEXT) failures.push(`${name}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });
}

test('Hell und Dunkel unterscheiden sich bei allen Hintergrund- und Text-Tokens', () => {
  for (const name of ['--surface-0', '--surface-3', '--surface-1', '--text-primary', '--text-secondary', '--epg-surface', '--md-bg', '--surface-nav']) {
    assert.notDeepEqual(color(name, 'light'), color(name, 'dark'), `${name} ist in beiden Designs gleich`);
  }
});
