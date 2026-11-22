'use strict';

// Updater-Pfad für den Mac-Helfer: Asset-Erkennung, Signaturprüfung (codesign/spctl per Fake-Werkzeug), atomarer Tausch,
// Ablehnung bei Fehlern, keine Ad-hoc-Neusignierung. Keine echten Downloads, keine echte Signatur.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseReleaseCandidate } = require('../lib/github-releases.js');
const { verifyHelperApp, installSyncHelper, stashSyncHelper, restoreSyncHelper, installedHelperVersion } = require('../lib/sync-helper-update.js');
const { updateSyncHelper } = require('../updater.js');

const asset = name => ({ name, browser_download_url: `https://example.invalid/${name}` });
const release = (tag, assets) => ({ tag_name: tag, draft: false, prerelease: false, assets });

test('Release-Erkennung: Helfer-Asset optional auf Mac, nie auf Linux', () => {
  const app = asset('Streaming.Hub-1.2.3-mac.zip');
  const helper = asset('StreamingHubSync-1.0.0.zip');
  assert.equal(parseReleaseCandidate(release('v1.2.3', [app]), 'darwin-arm64').syncHelperAsset, null);
  const withHelper = parseReleaseCandidate(release('v1.2.3', [app, helper]), 'darwin-arm64');
  assert.deepEqual(withHelper.syncHelperAsset, { name: 'StreamingHubSync-1.0.0.zip', version: '1.0.0', browserDownloadUrl: helper.browser_download_url });
  assert.equal(withHelper.asset.name, 'Streaming.Hub-1.2.3-mac.zip');
  assert.equal(parseReleaseCandidate(release('v1.2.3', [app, helper, asset('StreamingHubSync-1.0.1.zip')]), 'darwin-arm64'), null);
  assert.equal(parseReleaseCandidate(release('v1.2.3', [helper]), 'darwin-arm64'), null);
  assert.equal(parseReleaseCandidate(release('v1.2.3', [app, asset('notes.txt')]), 'darwin-arm64'), null);
  assert.equal(parseReleaseCandidate(release('v1.2.3-linux', [asset('Streaming.Hub-1.2.3-linux-x64.tar.gz'), helper]), 'linux-x64'), null);
});

// Fake-Werkzeuge: Verhalten über Env, jeder Aufruf wird protokolliert.
function makeTools(dir) {
  const log = path.join(dir, 'tools.log');
  const body = name => `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, '${name} ' + process.argv.slice(2).join(' ') + '\\n');
const e = process.env, a = process.argv.slice(2);
if ('${name}' === 'codesign') {
  if (a.includes('--verify')) { if (e.FAKE_VERIFY_FAIL) { console.error('invalid signature'); process.exit(1); } process.exit(0); }
  process.stderr.write('Identifier=' + (e.FAKE_IDENTIFIER || 'tv.streaminghub.desktopsync') + '\\nTeamIdentifier=' + (e.FAKE_TEAM || 'LXXDCD6K7Z') + '\\n');
} else {
  if (e.FAKE_SPCTL_FAIL) { console.error('rejected'); process.exit(3); }
  process.stderr.write('accepted\\nsource=Notarized Developer ID\\norigin=Developer ID Application: X (' + (e.FAKE_ORIGIN_TEAM || 'LXXDCD6K7Z') + ')\\n');
}
`;
  const codesignPath = path.join(dir, 'codesign');
  const spctlPath = path.join(dir, 'spctl');
  fs.writeFileSync(codesignPath, body('codesign'), { mode: 0o755 });
  fs.writeFileSync(spctlPath, body('spctl'), { mode: 0o755 });
  return { codesignPath, spctlPath, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

function makeEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-test-'));
  const tools = makeTools(dir);
  const helperDir = path.join(dir, 'SyncHelper');
  const verify = app => verifyHelperApp(app, tools);
  // Entpacken ersetzt: legt ein App-Bundle mit Marker an
  const unzip = (zip, dest) => {
    const app = path.join(dest, 'StreamingHubSync.app', 'Contents');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'marker'), fs.readFileSync(zip, 'utf8'));
  };
  const putOld = () => {
    fs.mkdirSync(path.join(helperDir, 'StreamingHubSync.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(helperDir, 'StreamingHubSync.app', 'Contents', 'marker'), 'alt');
    fs.writeFileSync(path.join(helperDir, 'state.json'), '{}');
  };
  const zip = path.join(dir, 'h.zip');
  fs.writeFileSync(zip, 'neu');
  const marker = () => fs.readFileSync(path.join(helperDir, 'StreamingHubSync.app', 'Contents', 'marker'), 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, tools, helperDir, verify, unzip, putOld, zip, marker };
}

const clearFakeEnv = () => ['FAKE_VERIFY_FAIL', 'FAKE_IDENTIFIER', 'FAKE_TEAM', 'FAKE_SPCTL_FAIL', 'FAKE_ORIGIN_TEAM'].forEach(k => delete process.env[k]);

test('Gültiger Helfer wird geprüft und atomar getauscht, state.json bleibt', t => {
  clearFakeEnv();
  const e = makeEnv(t);
  e.putOld();
  assert.deepEqual(installSyncHelper({ zipPath: e.zip, helperDir: e.helperDir, unzip: e.unzip, verify: e.verify }), { installed: true });
  assert.equal(e.marker(), 'neu');
  assert.ok(fs.existsSync(path.join(e.helperDir, 'state.json')));
  assert.deepEqual(fs.readdirSync(e.helperDir).sort(), ['StreamingHubSync.app', 'state.json']); // kein Staging/Rollback übrig
  const calls = e.tools.calls();
  assert.ok(calls.some(c => c.startsWith('codesign --verify --deep --strict')));
  assert.ok(calls.some(c => c.startsWith('spctl -a -vv')));
});

for (const [label, env] of [
  ['ungültige Signatur', { FAKE_VERIFY_FAIL: '1' }],
  ['falscher Identifier', { FAKE_IDENTIFIER: 'com.evil.app' }],
  ['falsches Team', { FAKE_TEAM: 'AAAAAAAAAA' }],
  ['Gatekeeper lehnt ab', { FAKE_SPCTL_FAIL: '1' }],
  ['Gatekeeper-Herkunft anderes Team', { FAKE_ORIGIN_TEAM: 'BBBBBBBBBB' }],
]) {
  test(`Ablehnung (${label}): alter Helfer bleibt, kein Rest`, t => {
    clearFakeEnv();
    Object.assign(process.env, env);
    t.after(clearFakeEnv);
    const e = makeEnv(t);
    e.putOld();
    assert.throws(() => installSyncHelper({ zipPath: e.zip, helperDir: e.helperDir, unzip: e.unzip, verify: e.verify }));
    assert.equal(e.marker(), 'alt');
    assert.deepEqual(fs.readdirSync(e.helperDir).sort(), ['StreamingHubSync.app', 'state.json']);
  });
}

test('Asset ohne StreamingHubSync.app wird abgelehnt', t => {
  clearFakeEnv();
  const e = makeEnv(t);
  e.putOld();
  assert.throws(() => installSyncHelper({ zipPath: e.zip, helperDir: e.helperDir, unzip: (zip, dest) => fs.mkdirSync(path.join(dest, 'Anderes.app')), verify: e.verify }), /kein StreamingHubSync\.app/);
  assert.equal(e.marker(), 'alt');
});

test('updateSyncHelper: fehlendes Asset ist kein Fehler; Prüffehler behält alten Helfer; gleiche Version wird übersprungen; keine Neusignierung', async t => {
  clearFakeEnv();
  t.after(clearFakeEnv);
  const e = makeEnv(t);
  e.putOld();
  const download = async (url, dest) => fs.copyFileSync(e.zip, dest);
  const deps = { download, unzip: e.unzip, verify: e.verify };
  assert.deepEqual(await updateSyncHelper({ version: '1.2.3', syncHelperAsset: null }, e.helperDir, deps), { skipped: 'kein Helfer-Asset im Release' });
  const rel = { syncHelperAsset: { name: 'StreamingHubSync-1.0.0.zip', version: '1.0.0', browserDownloadUrl: 'https://example.invalid/x' } };
  process.env.FAKE_VERIFY_FAIL = '1';
  const failed = await updateSyncHelper(rel, e.helperDir, deps);
  assert.ok(failed.failed);
  assert.equal(e.marker(), 'alt');
  delete process.env.FAKE_VERIFY_FAIL;
  assert.deepEqual(await updateSyncHelper(rel, e.helperDir, deps), { installed: true });
  assert.equal(e.marker(), 'neu');
  // Nie ad hoc signiert: kein codesign mit --sign/--force
  assert.equal(e.tools.calls().some(c => /--sign|--force/.test(c)), false);
  // gleiche Version installiert -> übersprungen
  fs.writeFileSync(path.join(e.helperDir, 'StreamingHubSync.app', 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key>\n<string>1.0.0</string>');
  assert.equal(installedHelperVersion(e.helperDir), '1.0.0');
  assert.match((await updateSyncHelper(rel, e.helperDir, deps)).skipped, /aktuell/);
});

test('Quelltext: Helfer-Pfad kennt weder resignBundleAdHoc noch --sign', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sync-helper-update.js'), 'utf8');
  assert.equal(/resignBundleAdHoc|'--sign'|--force/.test(src), false);
  const updater = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  const fn = updater.slice(updater.indexOf('async function updateSyncHelper'), updater.indexOf('async function applyLinuxRelease'));
  assert.equal(/resignBundleAdHoc|--sign/.test(fn), false);
});

test('Helferordner übersteht den App-Austausch (stash/restore)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-stash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  const stash = `${support}.stash`;
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(helperDir, 'state.json'), 'x');
  assert.equal(stashSyncHelper(helperDir, stash), true);
  fs.rmSync(support, { recursive: true }); // App-Austausch ersetzt das Verzeichnis
  fs.mkdirSync(support);
  assert.equal(restoreSyncHelper(helperDir, stash), true);
  assert.equal(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'), 'x');
  assert.equal(fs.existsSync(stash), false);
  assert.equal(stashSyncHelper(path.join(dir, 'fehlt'), stash), false);
});
