'use strict';

const RELEASES_API_URL = 'https://api.github.com/repos/keks-maker/streaming-hub/releases';
const ASSET_NAME = version => `Streaming.Hub-${version}-mac.zip`;

function parseReleaseCandidate(release) {
  if (!release || release.draft !== false || release.prerelease !== false) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.match(/^v(\d+\.\d+\.\d+)$/) : null;
  if (!tag || !Array.isArray(release.assets) || release.assets.length !== 1) return null;
  const version = tag[1];
  const asset = release.assets[0];
  if (!asset || asset.name !== ASSET_NAME(version) || typeof asset.browser_download_url !== 'string') return null;
  return { version, tagName: tag[0], asset: { name: asset.name, browserDownloadUrl: asset.browser_download_url } };
}

function findReleaseCandidates(releases) {
  if (!Array.isArray(releases)) return [];
  return releases.map(parseReleaseCandidate).filter(Boolean).sort((a, b) => compareVersions(a.version, b.version));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

async function fetchReleaseCandidates(fetchImpl = fetch) {
  const response = await fetchImpl(RELEASES_API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Streaming-Hub' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub Releases API ${response.status}`);
  return findReleaseCandidates(await response.json());
}

module.exports = { ASSET_NAME, RELEASES_API_URL, compareVersions, fetchReleaseCandidates, findReleaseCandidates, parseReleaseCandidate };
