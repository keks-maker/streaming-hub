'use strict';

// Navigationseintrag „Start“: Aufbau, Kürzel, Entfernung der alten Beschriftung #overlayLocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const renderer = read('renderer.js');
const icons = read('icons.js');

test('Start ist der erste Eintrag, nutzt house und springt zur Startseite', () => {
  assert.match(icons, /'house':/);
  assert.match(renderer, /start: Icons\.iconSvg\('house'\)/);
  assert.ok(renderer.indexOf("key: 'start', label: 'Start'") < renderer.indexOf("key: 'livetv', label: 'LiveTV', icon: NAV_ICONS"));
  assert.match(renderer, /group\.key === 'start' \? goToStartPage\(\)/);
});

test('Start bekommt nie den aktiven Zustand', () => {
  assert.match(renderer, /groupKey === 'start' \? null : nav\.querySelector/);
});

test('Strg+Umsch+H geht zur Startseite und steht vor Strg+H (Verlauf)', () => {
  const home = renderer.indexOf("ctrlKey && shiftKey && (key === 'h'");
  const hist = renderer.indexOf("ctrlKey && (key === 'h'");
  assert.ok(home > 0 && home < hist);
  assert.match(read('index.html'), /<kbd>Umsch<\/kbd> \+ <kbd>H<\/kbd><\/span><span class="shortcut-desc">Zur Startseite/);
});

test('#overlayLocation ist entfernt', () => {
  assert.ok(!/overlayLocation|overlay-location/.test(renderer + read('index.html') + read('styles.css')));
});
