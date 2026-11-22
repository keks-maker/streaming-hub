'use strict';

// Updater-Pfad für den Mac-Helfer: Asset-Erkennung, Signaturprüfung (codesign/spctl per Fake-Werkzeug), atomarer Tausch,
// Ablehnung bei Fehlern, keine Ad-hoc-Neusignierung. Keine echten Downloads, keine echte Signatur.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseReleaseCandidate, parseSyncHelperRelease, findSyncHelperReleases, findReleaseCandidates } = require('../lib/github-releases.js');
const oldClient = require('./fixtures/github-releases-v0.14.0.js');
const { createSyncHelperProvider } = require('../lib/sync-helper-provider.js');
const { verifyHelperApp, installSyncHelper, assertNoAppleDouble, dittoUnzip, stashSyncHelper, restoreSyncHelper, installedHelperVersion } = require('../lib/sync-helper-update.js');

const asset = name => ({ name, browser_download_url: `https://example.invalid/${name}` });
const release = (tag, assets) => ({ tag_name: tag, draft: false, prerelease: false, assets });

test('Release-Erkennung: App-Releases haben genau ein Asset, Helfer-Release eigener Tag mit genau einem Asset', () => {
  const app = asset('Streaming.Hub-1.2.3-mac.zip');
  const helper = asset('StreamingHubSync-1.0.0.zip');
  assert.equal(parseReleaseCandidate(release('v1.2.3', [app]), 'darwin-arm64').asset.name, 'Streaming.Hub-1.2.3-mac.zip');
  assert.equal(parseReleaseCandidate(release('v1.2.3', [app, helper]), 'darwin-arm64'), null); // zwei Assets: v0.14.0-Clients würden verwerfen
  assert.deepEqual(parseSyncHelperRelease(release('sync-helper-v1.0.0', [helper])), { version: '1.0.0', tagName: 'sync-helper-v1.0.0', asset: { name: 'StreamingHubSync-1.0.0.zip', browserDownloadUrl: helper.browser_download_url } });
  assert.equal(parseSyncHelperRelease(release('sync-helper-v1.0.0', [asset('StreamingHubSync-1.0.1.zip')])), null); // Version passt nicht zum Tag
  assert.equal(parseSyncHelperRelease(release('sync-helper-v1.0.0', [helper, app])), null);
  assert.equal(parseSyncHelperRelease(release('sync-helper-v1.0.0', [])), null);
  assert.equal(parseSyncHelperRelease({ ...release('sync-helper-v1.0.0', [helper]), prerelease: true }), null);
  assert.equal(parseSyncHelperRelease({ ...release('sync-helper-v1.0.0', [helper]), draft: true }), null);
  assert.equal(parseSyncHelperRelease(release('v1.0.0', [helper])), null);
  const newest = findSyncHelperReleases([release('sync-helper-v1.0.0', [helper]), release('sync-helper-v1.10.0', [asset('StreamingHubSync-1.10.0.zip')]), release('sync-helper-v1.2.0', [asset('StreamingHubSync-1.2.0.zip')]), release('v0.15.0', [asset('Streaming.Hub-0.15.0-mac.zip')])]).at(-1);
  assert.equal(newest.version, '1.10.0');
});

test('Alte Clients (v0.14.0-Code-Abbild): Helfer-Release wird ignoriert, 0.15.0 wird erkannt', () => {
  const releases = [
    release('sync-helper-v1.0.0', [asset('StreamingHubSync-1.0.0.zip')]),
    release('v0.15.0', [asset('Streaming.Hub-0.15.0-mac.zip')]),
    release('v0.15.0-x64', [asset('Streaming.Hub-0.15.0-mac-x64.zip')]),
    release('v0.15.0-linux', [asset('Streaming.Hub-0.15.0-linux-x64.tar.gz')]),
    release('v0.14.0', [asset('Streaming.Hub-0.14.0-mac.zip')]),
  ];
  for (const [target, tag] of [['darwin-arm64', 'v0.15.0'], ['darwin-x64', 'v0.15.0-x64'], ['linux-x64', 'v0.15.0-linux']]) {
    const oldCandidates = oldClient.findReleaseCandidates(releases, target);
    assert.equal(oldCandidates.at(-1).tagName, tag);
    assert.equal(oldCandidates.some(c => /sync-helper/.test(c.tagName)), false);
    assert.deepEqual(findReleaseCandidates(releases, target).map(c => c.tagName), oldCandidates.map(c => c.tagName)); // neuer Code sieht dasselbe
  }
  // Gegenprobe: ein zweites Asset auf dem App-Release würde alte Clients ausschließen (Grund für das eigene Helfer-Release)
  assert.deepEqual(oldClient.findReleaseCandidates([release('v0.15.0', [asset('Streaming.Hub-0.15.0-mac.zip'), asset('StreamingHubSync-1.0.0.zip')])], 'darwin-arm64'), []);
});

test('install.sh und Updater lesen keine Latest-Abfrage (Helfer-Release kann nie als Latest ausgeliefert werden)', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.equal(/releases\/latest/.test(sh), false);
  assert.equal(/releases\/latest/.test(fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8')), false);
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

const helperRel = (version, extra = {}) => ({ tag_name: `sync-helper-v${version}`, draft: false, prerelease: false, assets: [asset(`StreamingHubSync-${version}.zip`)], ...extra });
const fetchOf = releases => async () => ({ ok: true, json: async () => releases });

function providerEnv(t, overrides = {}) {
  clearFakeEnv();
  t.after(clearFakeEnv);
  const e = makeEnv(t);
  let clock = 1_000_000_000_000;
  let stored = null;
  const downloads = [];
  const provider = createSyncHelperProvider({
    helperDir: e.helperDir,
    fetchImpl: fetchOf([helperRel('1.0.0'), release('v0.15.0', [asset('Streaming.Hub-0.15.0-mac.zip')])]),
    download: async (url, dest) => { downloads.push(url); fs.copyFileSync(e.zip, dest); },
    unzip: e.unzip,
    verify: e.verify,
    checkStore: { read: () => stored, write: ms => { stored = ms; } },
    nowMs: () => clock,
    ...overrides,
  });
  return { ...e, provider, downloads, advance: ms => { clock += ms; }, stored: () => stored };
}

test('Provider: Helfer fehlt -> Download und Installation, onInstall wird gemeldet', async t => {
  const e = providerEnv(t);
  let announced = 0;
  assert.deepEqual(await e.provider.ensure({ force: true, onInstall: () => { announced += 1; } }), { installed: true, version: '1.0.0' });
  assert.equal(announced, 1);
  assert.deepEqual(e.downloads, ['https://example.invalid/StreamingHubSync-1.0.0.zip']);
  assert.equal(e.marker(), 'neu');
});

test('Provider: nur neuere Helfer-Version wird geladen; gleiche oder ältere nicht', async t => {
  const e = providerEnv(t);
  e.putOld();
  const plist = version => fs.writeFileSync(path.join(e.helperDir, 'StreamingHubSync.app', 'Contents', 'Info.plist'), `<key>CFBundleShortVersionString</key>\n<string>${version}</string>`);
  plist('1.0.0');
  assert.match((await e.provider.ensure({ force: true })).skipped, /aktuell/);
  plist('2.0.0');
  e.advance(25 * 3600 * 1000);
  assert.match((await e.provider.ensure({})).skipped, /aktuell/);
  plist('0.9.0');
  e.advance(25 * 3600 * 1000);
  assert.equal((await e.provider.ensure({})).installed, true);
  assert.equal(e.marker(), 'neu');
});

test('Provider: höchstens einmal pro Tag (auch nach Fehler); Einschalten ohne Helfer erzwingt', async t => {
  let calls = 0;
  const e = providerEnv(t, { fetchImpl: async () => { calls += 1; return { ok: true, json: async () => [helperRel('1.0.0')] }; } });
  e.putOld(); // ohne lesbare Version: wird ersetzt
  assert.equal((await e.provider.ensure({})).installed, true);
  assert.equal(calls, 1);
  fs.writeFileSync(path.join(e.helperDir, 'StreamingHubSync.app', 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key>\n<string>1.0.0</string>');
  assert.match((await e.provider.ensure({})).skipped, /heute/);
  e.advance(23 * 3600 * 1000);
  assert.match((await e.provider.ensure({ force: true })).skipped, /heute|aktuell/); // Helfer vorhanden: force hebt das Limit nicht auf
  assert.equal(calls, 1);
  e.advance(2 * 3600 * 1000);
  await e.provider.ensure({});
  assert.equal(calls, 2);
  // Ohne Helfer: force ignoriert das Tageslimit
  fs.rmSync(e.helperDir, { recursive: true, force: true });
  assert.equal((await e.provider.ensure({ force: true })).installed, true);
  assert.equal(calls, 3);
});

test('Provider: Netzfehler, Prüffehler und fehlendes Release liefern failed; alter Helfer bleibt', async t => {
  const e = providerEnv(t, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  e.putOld();
  assert.match((await e.provider.ensure({})).failed, /503/);
  assert.equal(e.marker(), 'alt');
  const none = providerEnv(t, { fetchImpl: fetchOf([release('v0.15.0', [asset('Streaming.Hub-0.15.0-mac.zip')])]) });
  assert.match((await none.provider.ensure({ force: true })).failed, /kein Helfer-Release/);
  const bad = providerEnv(t);
  bad.putOld();
  process.env.FAKE_VERIFY_FAIL = '1';
  assert.match((await bad.provider.ensure({})).failed, /Signatur/);
  assert.equal(bad.marker(), 'alt');
  assert.equal(fs.readdirSync(os.tmpdir()).some(n => n.startsWith('streaming-hub-synchelper-') && fs.existsSync(path.join(os.tmpdir(), n, 'StreamingHubSync-1.0.0.zip'))), false); // Temp-Zip aufgeräumt
});

test('AppleDouble: ._*-Einträge und __MACOSX werden abgelehnt (Liste und entpackter Baum)', t => {
  assert.doesNotThrow(() => assertNoAppleDouble(['StreamingHubSync.app/', 'StreamingHubSync.app/Contents/Info.plist']));
  assert.throws(() => assertNoAppleDouble(['StreamingHubSync.app/Contents/._Info.plist']), /AppleDouble/);
  assert.throws(() => assertNoAppleDouble(['__MACOSX/StreamingHubSync.app/x']), /AppleDouble/);
  const e = makeEnv(t);
  e.putOld();
  const unzipWithDouble = (zip, dest) => { e.unzip(zip, dest); fs.writeFileSync(path.join(dest, 'StreamingHubSync.app', 'Contents', '._marker'), 'x'); };
  assert.throws(() => installSyncHelper({ zipPath: e.zip, helperDir: e.helperDir, unzip: unzipWithDouble, verify: e.verify }), /AppleDouble/);
  assert.equal(e.marker(), 'alt');
});

test('dittoUnzip: echtes zip mit ._-Eintrag wird vor dem Entpacken abgelehnt, sauberes zip entpackt', { skip: process.platform !== 'darwin' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'StreamingHubSync.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'StreamingHubSync.app', 'Contents', 'Info.plist'), 'x');
  fs.writeFileSync(path.join(src, 'StreamingHubSync.app', 'Contents', '._Info.plist'), 'x');
  const bad = path.join(dir, 'bad.zip');
  require('child_process').execFileSync('/usr/bin/zip', ['-qr', bad, 'StreamingHubSync.app'], { cwd: src });
  assert.throws(() => dittoUnzip(bad, path.join(dir, 'out-bad')), /AppleDouble/);
  fs.rmSync(path.join(src, 'StreamingHubSync.app', 'Contents', '._Info.plist'));
  const good = path.join(dir, 'good.zip');
  require('child_process').execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', path.join(src, 'StreamingHubSync.app'), good]);
  fs.mkdirSync(path.join(dir, 'out'));
  dittoUnzip(good, path.join(dir, 'out'));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'StreamingHubSync.app', 'Contents', 'Info.plist')));
});

test('Quelltext: Helfer-Pfad kennt weder resignBundleAdHoc noch --sign', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sync-helper-update.js'), 'utf8');
  assert.equal(/resignBundleAdHoc|'--sign'|--force/.test(src), false);
  const provider = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sync-helper-provider.js'), 'utf8');
  assert.equal(/resignBundleAdHoc|'--sign'|--force/.test(provider), false);
  assert.equal(/installSyncHelper|syncHelperAsset|updateSyncHelper/.test(fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8')), false); // App-Update fasst den Helfer nur als Stash an
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

function makeApp(dir, version) {
  const contents = path.join(dir, 'StreamingHubSync.app', 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<key>CFBundleShortVersionString</key><string>${version}</string>`);
}

test('recoverSyncHelperStash: fehlender Helferordner wird aus dem Stash zurückgelegt', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  fs.mkdirSync(support);
  const stash = `${support}.synchelper-stash-99999999`;
  makeApp(stash, '1.2.0');
  fs.writeFileSync(path.join(stash, 'state.json'), 'x');
  const helperDir = path.join(support, 'SyncHelper');
  const result = recoverSyncHelperStash(helperDir, support);
  assert.equal(result.restored.length, 1);
  assert.equal(installedHelperVersion(helperDir), '1.2.0');
  assert.equal(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'), 'x');
  assert.equal(fs.existsSync(stash), false);
});

test('recoverSyncHelperStash: beides vorhanden, der neuere Helfer bleibt, Stash erst nach gültiger Kopie weg', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  fs.mkdirSync(support);
  // aktueller Helfer neuer als Stash: Stash ergänzt nur, wird entfernt
  makeApp(helperDir, '1.3.0');
  const stash = `${support}.synchelper-stash-99999999`;
  makeApp(stash, '1.2.0');
  fs.writeFileSync(path.join(stash, 'state.json'), 's');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(installedHelperVersion(helperDir), '1.3.0');
  assert.equal(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'), 's');
  assert.equal(fs.existsSync(stash), false);
  // Stash neuer als aktueller Helfer: Stash gewinnt, Zustand des alten Ordners bleibt ergänzt
  const stash2 = `${support}.synchelper-stash-99999998`;
  makeApp(stash2, '1.9.0');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(installedHelperVersion(helperDir), '1.9.0');
  assert.equal(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'), 's');
  assert.equal(fs.existsSync(stash2), false);
  assert.equal(fs.existsSync(`${helperDir}.old-${process.pid}`), false);
});

test('recoverSyncHelperStash: Stash neuer, die aktuelle state.json wird nicht von der älteren überschrieben', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  fs.mkdirSync(support);
  makeApp(helperDir, '1.0.0');
  fs.writeFileSync(path.join(helperDir, 'state.json'), 'aktuell');
  const stash = `${support}.synchelper-stash-99999999`;
  makeApp(stash, '1.9.0');
  fs.writeFileSync(path.join(stash, 'state.json'), 'alt');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(installedHelperVersion(helperDir), '1.9.0');
  assert.equal(fs.readFileSync(path.join(helperDir, 'state.json'), 'utf8'), 'aktuell');
});

test('recoverSyncHelperStash: vorhandener .old-Ordner wird bei ungültigem Helfer nicht gelöscht', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  fs.mkdirSync(helperDir, { recursive: true }); // ohne lesbare App
  const old = `${helperDir}.old-${process.pid}`;
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'wichtig.txt'), 'x');
  const stash = `${support}.synchelper-stash-99999999`;
  makeApp(stash, '1.9.0');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(installedHelperVersion(helperDir), '1.9.0');
  assert.equal(fs.readFileSync(path.join(old, 'wichtig.txt'), 'utf8'), 'x');
});

test('recoverSyncHelperStash: liegengebliebener .old-Ordner wird bei gültigem Helfer aufgeräumt', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  makeApp(helperDir, '1.0.0');
  const old = `${helperDir}.old-${process.pid}`;
  fs.mkdirSync(old);
  const stash = `${support}.synchelper-stash-99999999`;
  makeApp(stash, '1.9.0');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(installedHelperVersion(helperDir), '1.9.0');
  assert.equal(fs.existsSync(old), false);
});

test('recoverSyncHelperStash: weder Stash noch Helfer lesbar, nichts wird gelöscht', t => {
  const { recoverSyncHelperStash } = require('../lib/sync-helper-update.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchelper-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, 'Support');
  const helperDir = path.join(support, 'SyncHelper');
  fs.mkdirSync(helperDir, { recursive: true });
  const stash = `${support}.synchelper-stash-99999999`;
  fs.mkdirSync(stash);
  fs.writeFileSync(path.join(stash, 'state.json'), 'x');
  recoverSyncHelperStash(helperDir, support);
  assert.equal(fs.existsSync(path.join(stash, 'state.json')), true);
});

test('restoreSyncHelperSafely: wirft restore, bleibt es beim Rückgabewert false (Update gilt nicht als gescheitert)', () => {
  const { restoreSyncHelperSafely } = require('../updater.js');
  assert.equal(restoreSyncHelperSafely('/x', '/y', () => { throw new Error('kaputt'); }), false);
  assert.equal(restoreSyncHelperSafely('/x', '/y', () => true), true);
});
