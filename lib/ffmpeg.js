// v0.5.7 – ffmpeg-Bündelung (Spike-Ergebnis Aufnahme Phase 1a, Karte t_eb56f6c6)
//
// Liefert die ffmpeg/ffprobe-Binaries auf macOS und Linux, ohne dass der User
// ffmpeg selbst installieren muss (Konzept §2.2: "kein bitte Homebrew/apt
// nachinstallieren").
//
// Gewählter Weg (Spike-Verifikation 2026-09-30):
// - Quelle sind die statischen Builds der ffmpeg-static-Releases
//   (github.com/eugeneware/ffmpeg-static, Release b6.1.1 = ffmpeg 7.0.2-static).
//   Release-Assets auf GitHub sind unveränderlich (Tags werden nicht neu
//   hochgeladen); Integrität wird über die hier festgepinnten SHA-256-Prüfsummen
//   erzwungen — der Upstream veröffentlicht selbst keine Checksummen.
// - Bewusst NICHT das npm-Paket ffmpeg-static: dessen install.js-Postinstall
//   wird von unserem etablierten Install-/Update-Pfad (install.sh und
//   updater.js laufen beide mit `npm install --ignore-scripts`) nie ausgeführt
//   (empirisch im Spike verifiziert). Dieser Loader downlädt stattdessen
//   deterministisch selbst.
// - Ablageort ist der App-Stamm (neben package.json, im Git-Clone also
//   install.sh/updater-Update-sicher). Im AppImage entpackt electron-builder
//   das App-Verzeichnis nach squashfs-root/resources/app — relative Pfade vom
//   app-Root funktionieren dort ebenfalls.
// - Läuft ensureBinaries() nach jedem Update, fungiert es zugleich als
//   Selbstheilung: fehlende/entfernte Binaries werden neu geladen
//   (Konzept §2.2 "Selbstheilung beim App-Start").

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const logger = require('../logger.js');

const FFMPEG_STATIC_RELEASE = 'b6.1.1'; // ffmpeg 7.0.2-static (johnvansickle-Builds)
const FFMPEG_STATIC_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}`;

// SHA-256 der .gz-Release-Assets (einmalig aus dem Release b6.1.1 berechnet;
// GitHub-Release-Assets sind immutable). Schlüssel: "<tool>-<platform>-<arch>".
const FFMPEG_SHA256_GZ = {
  'ffmpeg-linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'ffprobe-linux-x64': '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
  'ffmpeg-darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'ffprobe-darwin-arm64': 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
  'ffmpeg-darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'ffprobe-darwin-x64': 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
};

const MIN_FFMPEG_VERSION = [7, 0, 0];

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[ffmpeg] ${message}`);
}

function ffmpegReleaseTag() {
  return FFMPEG_STATIC_RELEASE;
}

function binaryKey(tool) {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return `${tool}-${platform}-${arch}`;
}

function expectedSha256Gz(tool) {
  return FFMPEG_SHA256_GZ[binaryKey(tool)] || null;
}

function binaryDir(appRoot) {
  return appRoot || path.join(__dirname, '..');
}

function binaryPath(tool, appRoot) {
  const name = process.platform === 'win32' ? `${tool}.exe` : tool;
  return path.join(binaryDir(appRoot), 'bin', name);
}

function versionFilePath(appRoot) {
  return path.join(binaryDir(appRoot), 'bin', '.ffmpeg-release');
}

/**
 * Existiert die Binary, ist sie ausführbar und meldet sich mit einer
 * hinreichend neuen Version?
 */
function isBinaryHealthy(tool, appRoot) {
  const bin = binaryPath(tool, appRoot);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch (_) {
    return false;
  }
  try {
    const out = require('child_process').execFileSync(bin, ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /version\s+(\d+)\.(\d+)\.(\d+)/.exec(String(out));
    if (!match) return false;
    const got = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let i = 0; i < MIN_FFMPEG_VERSION.length; i++) {
      if (got[i] !== (MIN_FFMPEG_VERSION[i] || 0)) return got[i] > (MIN_FFMPEG_VERSION[i] || 0);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(file);
  hash.update(data);
  return hash.digest('hex');
}

function downloadFile(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: timeoutMs || 300000 }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, dest, timeoutMs).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} für ${url}`));
        return;
      }
      const stream = fs.createWriteStream(dest);
      response.on('error', reject);
      stream.on('error', reject);
      stream.on('finish', () => {
        stream.close(() => resolve(dest));
      });
      response.pipe(stream);
    });
    request.on('timeout', () => {
      request.destroy(new Error(`Timeout beim Download von ${url}`));
    });
    request.on('error', reject);
  });
}

async function ensureBinary(tool, appRoot, { force = false, logProgress = null } = {}) {
  const bin = binaryPath(tool, appRoot);
  const versionFile = versionFilePath(appRoot);
  const expected = expectedSha256Gz(tool);
  if (!expected) {
    throw new Error(`Keine ffmpeg-static-Prüfsumme für ${binaryKey(tool)} (Plattform nicht unterstützt)`);
  }

  // 1) Gesunder Bestand ohne Download (schneller Pfad).
  if (!force && isBinaryHealthy(tool, appRoot)) {
    try {
      const pinned = fs.readFileSync(versionFile, 'utf-8').trim();
      if (pinned === FFMPEG_STATIC_RELEASE) {
        log('info', `${tool}: vorhandene Binary OK (${pinned})`);
        return { tool, path: bin, action: 'ok' };
      }
      // 2) Bestand gesund, aber aus anderem Release: Binaries im Bundle-Verzeichnis
      //    sind über den Update-Checkout versioniert — hier gilt der Release-Tag
      //    der laufenden App als Quelle der Wahrheit und die Binary wird erneuert.
      log('info', `${tool}: Release-Wechsel ${pinned || 'unbekannt'} → ${FFMPEG_STATIC_RELEASE}, erneuere`);
    } catch (_) {
      // kein .ffmpeg-release: Bestand zählt als gültig (u. a. install.sh-Beilage)
      fs.writeFileSync(versionFile, `${FFMPEG_STATIC_RELEASE}\n`, 'utf-8');
      log('info', `${tool}: vorhandene Binary OK (Release-Tag nachgetragen: ${FFMPEG_STATIC_RELEASE})`);
      return { tool, path: bin, action: 'ok' };
    }
  }

  // 3) Download in temporäres Verzeichnis, Prüfsumme, dann atomar einspielen.
  const asset = `${binaryKey(tool)}.gz`;
  const url = `${FFMPEG_STATIC_BASE_URL}/${asset}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-ffmpeg-'));
  const gzPath = path.join(tmpDir, asset);
  try {
    log('info', `${tool}: lade ${url} …`);
    if (logProgress) logProgress(`ffmpeg wird geladen (${tool}) …`);
    await downloadFile(url, gzPath);

    const actual = sha256File(gzPath);
    if (actual !== expected) {
      throw new Error(
        `Prüfsummen-Fehler für ${asset}: erwartet ${expected}, erhalten ${actual} — Download wird verworfen`,
      );
    }

    require('child_process').execFileSync('gunzip', ['-kf', gzPath], { timeout: 60000 });
    const gunzipped = gzPath.replace(/\.gz$/, '');
    fs.chmodSync(gunzipped, 0o755);

    // Ausführlichkeit der frischen Binary beweisen, bevor sie eingesetzt wird.
    const smoke = require('child_process').execFileSync(gunzipped, ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!/version\s+\d+\.\d+/.test(String(smoke))) {
      throw new Error(`${tool}: frische Binary liefert keine Versionsausgabe`);
    }

    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(gunzipped, bin);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(versionFile, `${FFMPEG_STATIC_RELEASE}\n`, 'utf-8');
    log('info', `${tool}: installiert (${FFMPEG_STATIC_RELEASE}) nach ${bin}`);
    return { tool, path: bin, action: 'downloaded' };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * Stellt ffmpeg + ffprobe bereit (idempotent).
 * Rückgabe: { ffmpeg: {path, action}, ffprobe: {path, action}, ok, error }
 */
async function ensureBinaries(appRoot, options = {}) {
  const root = binaryDir(appRoot);
  const result = { ffmpeg: null, ffprobe: null, ok: false, error: null };
  try {
    result.ffmpeg = await ensureBinary('ffmpeg', root, options);
    result.ffprobe = await ensureBinary('ffprobe', root, options);
    result.ok = true;
  } catch (e) {
    result.error = e.message;
    log('error', `ensureBinaries fehlgeschlagen: ${e.message}`);
  }
  return result;
}

/**
 * App-Start-Check (Konzept §2.2): Binary vorhanden + ausführbar + -version ok.
 * Fehlschlag = sichtbare Degradierung der Aufnahme-Features (kein stilles Versagen).
 */
function checkHealth(appRoot) {
  const root = binaryDir(appRoot);
  const missing = [];
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!isBinaryHealthy(tool, root)) missing.push(tool);
  }
  return {
    ok: missing.length === 0,
    missing,
    ffmpegPath: missing.includes('ffmpeg') ? null : binaryPath('ffmpeg', root),
    ffprobePath: missing.includes('ffprobe') ? null : binaryPath('ffprobe', root),
    release: ffmpegReleaseTag(),
  };
}

module.exports = {
  ensureBinaries,
  ensureBinary,
  checkHealth,
  isBinaryHealthy,
  binaryPath,
  ffmpegReleaseTag,
  FFMPEG_STATIC_RELEASE,
  FFMPEG_SHA256_GZ,
};
