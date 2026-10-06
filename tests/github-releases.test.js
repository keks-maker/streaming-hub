'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchReleaseCandidates, findReleaseCandidates, parseReleaseCandidate } = require('../lib/github-releases.js');

const asset = version => ({ name: `Streaming.Hub-${version}-mac.zip`, browser_download_url: `https://github.com/keks-maker/streaming-hub/releases/download/v${version}/Streaming.Hub-${version}-mac.zip` });

test('Release-Kandidat verlangt stabile vX.Y.Z und genau ein passend versioniertes Mac-Zip', () => {
  assert.equal(parseReleaseCandidate({ tag_name: 'v0.5.5', draft: false, prerelease: false, assets: [] }), null);
  assert.equal(parseReleaseCandidate({ tag_name: 'v0.5.4', draft: false, prerelease: false, assets: [asset('0.5.3')] }), null);
  assert.equal(parseReleaseCandidate({ tag_name: 'v0.5.4', draft: true, prerelease: false, assets: [asset('0.5.4')] }), null);
  assert.equal(parseReleaseCandidate({ tag_name: 'v0.5.4', draft: false, prerelease: true, assets: [asset('0.5.4')] }), null);
  assert.equal(parseReleaseCandidate({ tag_name: 'v0.5.4', draft: false, prerelease: false, assets: [asset('0.5.4'), { name: 'notes.txt' }] }), null);
});

test('Discovery ignoriert asset-lose Releases und wählt den höchsten gültigen Kandidaten', () => {
  const releases = [
    { tag_name: 'v0.5.6', draft: false, prerelease: false, assets: [] },
    { tag_name: 'v0.5.3', draft: false, prerelease: false, assets: [asset('0.5.3')] },
    { tag_name: 'v0.5.2', draft: false, prerelease: false, assets: [asset('0.5.2')] },
    { tag_name: 'v0.5.16', draft: false, prerelease: false, assets: [] },
  ];
  assert.deepEqual(findReleaseCandidates(releases).map(candidate => candidate.version), ['0.5.2', '0.5.3']);
});

test('Release-Abfrage paginiert mit 100 Einträgen und sortiert alle gültigen Kandidaten', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    tag_name: `v0.5.${index + 1}`,
    draft: false,
    prerelease: false,
    assets: [asset(`0.5.${index + 1}`)],
  }));
  const secondPage = [{ tag_name: 'v9.0.0', draft: false, prerelease: false, assets: [asset('9.0.0')] }];
  const urls = [];
  const candidates = await fetchReleaseCandidates(async url => {
    urls.push(url);
    return { ok: true, json: async () => urls.length === 1 ? firstPage : secondPage };
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/keks-maker/streaming-hub/releases?per_page=100&page=1',
    'https://api.github.com/repos/keks-maker/streaming-hub/releases?per_page=100&page=2',
  ]);
  assert.equal(candidates.at(-1).version, '9.0.0');
});

test('Release-Abfrage akzeptiert eine alternative API-Basis für Installer-Smoke-Tests', async () => {
  const urls = [];
  const candidates = await fetchReleaseCandidates(async url => {
    urls.push(url);
    return { ok: true, json: async () => urls.length === 1 ? [{ tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [asset('1.2.3')] }] : [] };
  }, 'https://mock.example/releases');
  assert.equal(candidates.at(-1).version, '1.2.3');
  assert.deepEqual(urls, ['https://mock.example/releases?per_page=100&page=1']);
});

// --- Release-Kategorien (je Plattform+Architektur ein eigenes Release) ---
const { RELEASE_TARGETS, ASSET_NAME, resolveTarget, targetKey } = require('../lib/github-releases.js');
const oldParser = require('./fixtures/github-releases-0.9.4.js');

const rel = (tag, name, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name, browser_download_url: `https://example.test/${tag}/${name}` }], ...extra });
const arm = v => rel(`v${v}`, `Streaming.Hub-${v}-mac.zip`);
const x64 = v => rel(`v${v}-x64`, `Streaming.Hub-${v}-mac-x64.zip`);

test('Schema-Tabelle: arm64 unveraendert, x64 mit eigenem Tag und Asset', () => {
  assert.equal(ASSET_NAME('1.2.3'), 'Streaming.Hub-1.2.3-mac.zip');
  assert.equal(ASSET_NAME('1.2.3', 'darwin-arm64'), 'Streaming.Hub-1.2.3-mac.zip');
  assert.equal(ASSET_NAME('1.2.3', 'darwin-x64'), 'Streaming.Hub-1.2.3-mac-x64.zip');
  assert.equal(targetKey('darwin', 'x64'), 'darwin-x64');
  assert.throws(() => resolveTarget('win32-x64'), /Keine Release-Kategorie/);
});

test('Kategorien sind strikt getrennt: jeder Client sieht nur Releases der eigenen Kategorie', () => {
  const releases = [arm('0.9.4'), x64('0.9.5'), arm('0.9.3'), x64('0.9.4')];
  assert.deepEqual(findReleaseCandidates(releases).map(c => c.tagName), ['v0.9.3', 'v0.9.4']);
  assert.deepEqual(findReleaseCandidates(releases, 'darwin-arm64').map(c => c.tagName), ['v0.9.3', 'v0.9.4']);
  assert.deepEqual(findReleaseCandidates(releases, 'darwin-x64').map(c => c.tagName), ['v0.9.4-x64', 'v0.9.5-x64']);
  assert.equal(findReleaseCandidates(releases, 'darwin-x64').at(-1).asset.name, 'Streaming.Hub-0.9.5-mac-x64.zip');
});

test('x64-Kategorie lehnt falsche Asset-Namen, Tags und arm64-Assets ab (kein Fallback)', () => {
  assert.equal(parseReleaseCandidate(arm('0.9.5'), 'darwin-x64'), null);
  assert.equal(parseReleaseCandidate(x64('0.9.5'), 'darwin-arm64'), null);
  assert.equal(parseReleaseCandidate(rel('v0.9.5-x64', 'Streaming.Hub-0.9.5-mac.zip'), 'darwin-x64'), null);
  assert.equal(parseReleaseCandidate(rel('v0.9.5', 'Streaming.Hub-0.9.5-mac-x64.zip'), 'darwin-arm64'), null);
  assert.equal(parseReleaseCandidate(rel('v0.9.5-x64', 'Streaming.Hub-0.9.4-mac-x64.zip'), 'darwin-x64'), null);
  assert.equal(parseReleaseCandidate(x64('0.9.5'), 'darwin-x64').version, '0.9.5');
});

test('Versionsvergleich nur innerhalb der Kategorie: hoeheres x64-Release erzeugt kein arm64-Update', () => {
  const releases = [arm('0.9.4'), x64('0.9.9')];
  assert.equal(findReleaseCandidates(releases, 'darwin-arm64').at(-1).version, '0.9.4');
  assert.deepEqual(findReleaseCandidates([arm('0.9.4')], 'darwin-x64'), []);
});

test('Der ALTE Parser aus 0.9.4 (main) sieht x64-Releases nie als Kandidat', () => {
  const releases = [arm('0.9.4'), x64('0.9.5'), x64('0.9.4'), x64('99.0.0'), arm('0.9.3')];
  assert.deepEqual(oldParser.findReleaseCandidates(releases).map(c => c.tagName), ['v0.9.3', 'v0.9.4']);
  for (const r of releases.filter(r => r.tag_name.endsWith('-x64'))) assert.equal(oldParser.parseReleaseCandidate(r), null);
});

test('Linux (Platzhalter) ist nur ein weiterer Tabelleneintrag; unbekannte Kategorie wirft', () => {
  const linux = { tag: /^v(\d+\.\d+\.\d+)-linux-x64$/, asset: v => `Streaming.Hub-${v}-linux-x64.AppImage` };
  const releases = [arm('0.9.4'), x64('0.9.5'), rel('v0.9.6-linux-x64', 'Streaming.Hub-0.9.6-linux-x64.AppImage')];
  assert.deepEqual(findReleaseCandidates(releases, linux).map(c => c.tagName), ['v0.9.6-linux-x64']);
  assert.deepEqual(findReleaseCandidates(releases, 'darwin-x64').map(c => c.tagName), ['v0.9.5-x64']);
  assert.deepEqual(oldParser.findReleaseCandidates(releases).map(c => c.tagName), ['v0.9.4']);
  assert.deepEqual(Object.keys(RELEASE_TARGETS), ['darwin-arm64', 'darwin-x64']);
  assert.throws(() => findReleaseCandidates(releases, 'linux-x64'), /Keine Release-Kategorie/);
});

test('fetchReleaseCandidates filtert nach Kategorie', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [arm('0.9.4'), x64('0.9.5')] });
  assert.equal((await fetchReleaseCandidates(fetchImpl, 'https://mock.example/r', 'darwin-x64')).at(-1).tagName, 'v0.9.5-x64');
  assert.equal((await fetchReleaseCandidates(fetchImpl, 'https://mock.example/r')).at(-1).tagName, 'v0.9.4');
});
