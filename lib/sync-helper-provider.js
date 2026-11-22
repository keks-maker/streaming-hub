'use strict';

// Bezug des Mac-Helfers StreamingHubSync unabhängig vom App-Update (D10): neuestes Release `sync-helper-v*`, höchstens
// einmal pro Tag geprüft (außer beim ausdrücklichen Einschalten ohne installierten Helfer). Installation über
// installSyncHelper (codesign/Identifier/Team/spctl, atomarer Tausch, alter Helfer bleibt bei Fehler).
// Nichts wird geladen, solange der Schalter aus ist: der Aufrufer (lib/icloud-sync.js) ruft nur bei eingeschaltetem Schalter auf.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchLatestSyncHelperRelease, compareVersions, RELEASES_API_URL } = require('./github-releases.js');
const { installSyncHelper, installedHelperVersion } = require('./sync-helper-update.js');
const { downloadAsset } = require('./release-download.js');

const TRUSTED_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com'];

/** Nur https von GitHub (bzw. dessen Asset-CDN); Ausnahme: lokales http-Ziel für Tests. */
function assertTrustedDownloadUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Ungültige Download-URL des Helfer-Assets'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local || (url.protocol === 'https:' && TRUSTED_DOWNLOAD_HOSTS.includes(url.hostname))) return;
  throw new Error(`Download-Host nicht vertrauenswürdig: ${url.hostname}`);
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * options: helperDir, apiUrl, fetchImpl, download(url, dest), install(opts) (Standard installSyncHelper), unzip, verify,
 *   checkStore { read(): number|null (ms), write(ms) }, nowMs(), log(msg), warn(msg)
 * ensure({ force, onInstall }) -> { skipped } | { installed: true, version } | { failed: Nachricht }
 *   force: Tageslimit ignorieren, wenn kein Helfer installiert ist (Einschalten durch den Nutzer).
 *   onInstall(): wird unmittelbar vor dem Download aufgerufen (Status "wird installiert").
 */
function createSyncHelperProvider(options = {}) {
  const helperDir = options.helperDir;
  const nowMs = options.nowMs || Date.now;
  const install = options.install || installSyncHelper;
  const log = options.log || (() => {});
  const warn = options.warn || (() => {});
  let inflight = null;

  function due(installed, force) {
    if (!installed && force) return true;
    let last;
    try { last = options.checkStore ? options.checkStore.read() : null; } catch (_) { last = null; }
    return !(typeof last === 'number' && Number.isFinite(last) && last <= nowMs() && nowMs() - last < CHECK_INTERVAL_MS);
  }

  async function run({ force, onInstall }) {
    const installed = installedHelperVersion(helperDir);
    if (!due(installed, force === true)) return { skipped: 'heute bereits geprüft' };
    try { options.checkStore?.write(nowMs()); } catch (_) { /* Zähler darf den Bezug nie stören */ }
    let tempRoot = null;
    try {
      const release = await fetchLatestSyncHelperRelease(options.fetchImpl || fetch, options.apiUrl || RELEASES_API_URL);
      if (!release) return installed ? { skipped: 'kein Helfer-Release' } : { failed: 'Es gibt noch kein Helfer-Release' };
      if (installed && compareVersions(installed, release.version) >= 0) return { skipped: `Helfer ${installed} ist aktuell` };
      try { onInstall?.(); } catch (_) { /* Anzeige */ }
      assertTrustedDownloadUrl(release.asset.browserDownloadUrl);
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-synchelper-'));
      const zipPath = path.join(tempRoot, release.asset.name);
      await (options.download || downloadAsset)(release.asset.browserDownloadUrl, zipPath);
      await install({ zipPath, helperDir, unzip: options.unzip, verify: options.verify, log });
      return { installed: true, version: release.version };
    } catch (error) {
      warn(`Sync-Helfer nicht installiert (alter Helfer bleibt): ${error.message}`);
      return { failed: error.message };
    } finally {
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  function ensure(args = {}) {
    if (!inflight) inflight = run(args).finally(() => { inflight = null; });
    return inflight;
  }

  return { ensure };
}

module.exports = { createSyncHelperProvider, assertTrustedDownloadUrl, TRUSTED_DOWNLOAD_HOSTS, CHECK_INTERVAL_MS };
