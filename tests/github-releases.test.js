'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findReleaseCandidates, parseReleaseCandidate } = require('../lib/github-releases.js');

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
