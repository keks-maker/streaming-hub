'use strict';

const RELEASES_API_URL = 'https://api.github.com/repos/keks-maker/streaming-hub/releases';
const SEMVER = '(\\d+\\.\\d+\\.\\d+)';

// Release-Kategorien: je Plattform+Architektur ein eigenes GitHub-Release.
// Schluessel = `${platform}-${arch}` (process.platform / process.arch).
// arm64 bleibt unveraendert (aeltere Clients kennen nur ^vX.Y.Z$ und ignorieren damit alle anderen Tags).
// Weitere Plattformen (z. B. Linux) sind nur ein zusaetzlicher Eintrag.
const RELEASE_TARGETS = {
  'darwin-arm64': { tag: new RegExp(`^v${SEMVER}$`), asset: version => `Streaming.Hub-${version}-mac.zip` },
  'darwin-x64': { tag: new RegExp(`^v${SEMVER}-x64$`), asset: version => `Streaming.Hub-${version}-mac-x64.zip` },
};
const DEFAULT_TARGET = 'darwin-arm64';

// Kategorie des laufenden Builds (Architektur der App, nicht der Hardware: eine unter Rosetta laufende
// x64-App aktualisiert sich mit dem x64-Release, damit Architektur und Update zusammenpassen).
function targetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function resolveTarget(target = DEFAULT_TARGET, targets = RELEASE_TARGETS) {
  const spec = typeof target === 'string' ? targets[target] : target;
  if (!spec || !(spec.tag instanceof RegExp) || typeof spec.asset !== 'function') {
    throw new Error(`Keine Release-Kategorie fuer ${typeof target === 'string' ? target : 'unbekanntes Ziel'}`);
  }
  return spec;
}

// Rueckwaertskompatibel: ohne Ziel gilt arm64 (Dateiname ohne Arch-Suffix).
const ASSET_NAME = (version, target = DEFAULT_TARGET) => resolveTarget(target).asset(version);

function parseReleaseCandidate(release, target = DEFAULT_TARGET) {
  const spec = resolveTarget(target);
  if (!release || release.draft !== false || release.prerelease !== false) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.match(spec.tag) : null;
  if (!tag || !Array.isArray(release.assets) || release.assets.length !== 1) return null;
  const version = tag[1];
  const asset = release.assets[0];
  if (!asset || asset.name !== spec.asset(version) || typeof asset.browser_download_url !== 'string') return null;
  return { version, tagName: tag[0], asset: { name: asset.name, browserDownloadUrl: asset.browser_download_url } };
}

function findReleaseCandidates(releases, target = DEFAULT_TARGET) {
  resolveTarget(target);
  if (!Array.isArray(releases)) return [];
  return releases.map(release => parseReleaseCandidate(release, target)).filter(Boolean).sort((a, b) => compareVersions(a.version, b.version));
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

async function fetchReleaseCandidates(fetchImpl = fetch, apiUrl = RELEASES_API_URL, target = DEFAULT_TARGET) {
  resolveTarget(target);
  const releases = [];
  for (let page = 1; ; page += 1) {
    const separator = apiUrl.includes('?') ? '&' : '?';
    const response = await fetchImpl(`${apiUrl}${separator}per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Streaming-Hub' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub Releases API ${response.status}`);
    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) throw new Error('GitHub Releases API lieferte keine Release-Liste');
    releases.push(...pageReleases);
    if (pageReleases.length < 100) break;
  }
  return findReleaseCandidates(releases, target);
}

module.exports = { ASSET_NAME, DEFAULT_TARGET, RELEASE_TARGETS, resolveTarget, targetKey, RELEASES_API_URL, compareVersions, fetchReleaseCandidates, findReleaseCandidates, parseReleaseCandidate };
