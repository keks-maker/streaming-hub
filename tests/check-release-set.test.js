'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkReleaseSet } = require('../scripts/check-release-set.js');

const rel = (tag, name) => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name, browser_download_url: `https://example.test/${tag}/${name}` }] });
const full = v => [
  rel(`v${v}`, `Streaming.Hub-${v}-mac.zip`),
  rel(`v${v}-x64`, `Streaming.Hub-${v}-mac-x64.zip`),
  rel(`v${v}-linux`, `Streaming.Hub-${v}-linux-x64.tar.gz`),
];
const fetchOf = releases => async () => ({ ok: true, json: async () => releases });

test('release:check: vollstaendiger Satz ist ok', async () => {
  const results = await checkReleaseSet('0.9.9', fetchOf([...full('0.9.8'), ...full('0.9.9')]));
  assert.deepEqual(results.map(r => [r.target, r.ok, r.tagName]), [
    ['darwin-arm64', true, 'v0.9.9'],
    ['darwin-x64', true, 'v0.9.9-x64'],
    ['linux-x64', true, 'v0.9.9-linux'],
  ]);
});

test('release:check: fehlendes Linux-Release, falsches Asset und Draft werden als Luecke gemeldet', async () => {
  const releases = [rel('v0.9.9', 'Streaming.Hub-0.9.9-mac.zip'), rel('v0.9.9-x64', 'Streaming.Hub-0.9.9-mac-x64.zip')];
  assert.deepEqual((await checkReleaseSet('0.9.9', fetchOf(releases))).filter(r => !r.ok).map(r => r.target), ['linux-x64']);
  const wrong = [...releases, rel('v0.9.9-linux', 'Streaming.Hub-0.9.9-linux-x64.AppImage')];
  assert.deepEqual((await checkReleaseSet('0.9.9', fetchOf(wrong))).filter(r => !r.ok).map(r => r.target), ['linux-x64']);
  const draft = [...full('0.9.9').slice(0, 2), { ...rel('v0.9.9-linux', 'Streaming.Hub-0.9.9-linux-x64.tar.gz'), draft: true }];
  assert.deepEqual((await checkReleaseSet('0.9.9', fetchOf(draft))).filter(r => !r.ok).map(r => r.expectedAsset), ['Streaming.Hub-0.9.9-linux-x64.tar.gz']);
  // Nur andere Version vorhanden
  assert.equal((await checkReleaseSet('0.9.9', fetchOf(full('0.9.8')))).every(r => !r.ok), true);
});

test('release:check: API-Fehler wird als Fehler je Ziel gemeldet (nicht als vorhanden)', async () => {
  const results = await checkReleaseSet('0.9.9', async () => ({ ok: false, status: 500 }));
  assert.equal(results.every(r => !r.ok && /500/.test(r.error)), true);
});
