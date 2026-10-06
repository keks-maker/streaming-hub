'use strict';
/**
 * Regressionstest (v0.9.4): Ohne EVS verändert install.sh das signierte Release-Bundle
 * (Info.plist, Resources/app-Symlink, Icon). Das Siegel ist danach ungültig; vor der
 * Verifikation muss daher ad-hoc neu signiert werden. Praxisbeleg: Release v0.9.3
 * brach auf Fremd-Macs ohne castlabs_evs mit "invalid Info.plist" ab.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sh = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
const noEvs = sh.slice(sh.indexOf('EVS (castlabs_evs) nicht verfügbar'));

test('No-EVS-Pfad: ad-hoc Neu-Signierung vor der codesign-Verifikation', () => {
  const sign = noEvs.indexOf('codesign --force --deep --sign - "$APP_BUNDLE_STAGE"');
  const verify = noEvs.indexOf('codesign --verify --deep "$APP_BUNDLE_STAGE"');
  assert.ok(sign > 0, 'Neu-Signierung fehlt');
  assert.ok(verify > sign, 'Verifikation muss nach der Neu-Signierung stehen');
});

test('No-EVS-Pfad: keine --strict-Verifikation des Staging-Bundles (Resources/app-Symlink zeigt nach außen)', () => {
  assert.ok(!/codesign --verify --deep --strict "\$APP_BUNDLE_STAGE"/.test(sh));
});

test('No-EVS-Pfad: Hinweis auf eingeschränkte DRM-Dienste', () => {
  assert.match(noEvs.slice(0, 300), /DRM-Dienste/);
});

test('Neu-Signierung läuft nach der Bundle-Veränderung (stage-mac-icon)', () => {
  assert.ok(sh.indexOf('stage-mac-icon.js"; then') < sh.indexOf('codesign --force --deep --sign -'));
});
