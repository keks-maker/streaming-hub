'use strict';
/**
 * Prueft, dass zur Version aus package.json alle drei GitHub-Releases mit gueltigem Asset existieren:
 *   vX.Y.Z        Streaming.Hub-X.Y.Z-mac.zip          (darwin-arm64)
 *   vX.Y.Z-x64    Streaming.Hub-X.Y.Z-mac-x64.zip      (darwin-x64)
 *   vX.Y.Z-linux  Streaming.Hub-X.Y.Z-linux-x64.tar.gz (linux-x64)
 *
 *   npm run release:check                 Version aus package.json
 *   npm run release:check -- --version 0.9.9
 * Exit-Code 0 = vollstaendig, 1 = Luecke, 2 = Abfrage fehlgeschlagen (Netz/API).
 * Ein Release gilt nur als vorhanden, wenn es dem Updater-Schema entspricht (kein Draft/Prerelease,
 * Tag + genau ein Asset mit passendem Namen; lib/github-releases.js).
 */
const { RELEASE_TARGETS, RELEASES_API_URL, ASSET_NAME, fetchReleaseCandidates } = require('../lib/github-releases.js');

async function checkReleaseSet(version, fetchImpl = fetch, apiUrl = RELEASES_API_URL) {
  const results = [];
  for (const target of Object.keys(RELEASE_TARGETS)) {
    const expectedAsset = ASSET_NAME(version, target);
    let candidate = null;
    let error = null;
    try {
      candidate = (await fetchReleaseCandidates(fetchImpl, apiUrl, target)).find(item => item.version === version) || null;
    } catch (e) {
      error = e.message;
    }
    results.push({ target, tagName: candidate ? candidate.tagName : null, expectedAsset, ok: !!candidate, error });
  }
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const flag = argv.indexOf('--version');
  const version = flag >= 0 ? argv[flag + 1] : require('../package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    console.error(`Ungueltige Version: ${version}`);
    return 2;
  }
  const results = await checkReleaseSet(version, fetch, process.env.STREAMING_HUB_RELEASES_API_URL || RELEASES_API_URL);
  for (const r of results) {
    console.log(`${r.ok ? 'OK    ' : 'FEHLT '} ${r.target.padEnd(13)} ${r.ok ? r.tagName : `${r.expectedAsset}${r.error ? ` (${r.error})` : ''}`}`);
  }
  if (results.some(r => r.error)) return 2;
  const missing = results.filter(r => !r.ok);
  console.log(missing.length ? `Release-Satz v${version} UNVOLLSTAENDIG (${missing.length} von ${results.length} fehlen)` : `Release-Satz v${version} vollstaendig (${results.length} von ${results.length})`);
  return missing.length ? 1 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}

module.exports = { checkReleaseSet, main };
