// v0.5.7 – ffmpeg-Bündelung (Spike-Ergebnis Aufnahme Phase 1a, Karte t_eb56f6c6)
//
// Liefert die ffmpeg/ffprobe-Binaries auf macOS und Linux, ohne dass der User
// ffmpeg selbst installieren muss (Konzept §2.2: "kein bitte Homebrew/apt
// nachinstallieren").
//
// Gewählter Weg (Spike-Verifikation 2026-09-30, Fix-Set 1 t_48acdc23):
// - linux-x64: statische Builds aus dem ffmpeg-static-Release b6.1.1
//   (github.com/eugeneware/ffmpeg-static = johnvansickle-Builds, ffmpeg
//   7.0.2-static). Release-Assets auf GitHub sind unveränderlich; Integrität
//   wird über die hier festgepinnten SHA-256-Prüfsummen der .gz-Assets
//   erzwungen — der Upstream veröffentlicht selbst keine Checksummen.
// - darwin (x64 + arm64): versionierte Zips von evermeet.cx (ffmpeg-7.0.2.zip),
//   gepinnt über die SHA-256 der ENTPACKTEN Binaries. Hintergrund (QA
//   F-FB-03, empirisch 30.09.2026 am Test-Mac verifiziert): der
//   ffmpeg-static-darwin-arm64-Build des Tags b6.1.1 meldet ffmpeg 6.0 —
//   der Tag-Name pinnt die macOS-Version NICHT (ffmpeg-static Issue #151,
//   Quelle der darwin-Assets ist ohnehin evermeet/osxexperts). evermeet.cx
//   liefert versionierte, unveränderliche Archive eines statischen
//   7.0.2-Builds (x86_64); auf Apple Silicon läuft er über Rosetta 2
//   (am Test-Mac verifiziert installiert und ausführbar).
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

const FFMPEG_STATIC_RELEASE = 'b6.1.1'; // linux-Quelle: ffmpeg 7.0.2-static (johnvansickle)
const FFMPEG_STATIC_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}`;

// darwin-Quelle: evermeet.cx, versionierte Zips (ffmpeg 7.0.2, statisch).
const DARWIN_FFMPEG_VERSION = '7.0.2';
const DARWIN_PIN_TAG = 'evermeet-7.0.2'; // Release-Tag des darwin-Pin-Satzes
const DARWIN_BASE_URL = 'https://evermeet.cx/ffmpeg';

// SHA-256 der .gz-Release-Assets (einmalig aus dem Release b6.1.1 berechnet;
// GitHub-Release-Assets sind immutable). Nur linux — die darwin-Assets des
// Tags melden ffmpeg 6.0 (siehe Kommentar oben) und werden nicht genutzt.
// Schlüssel: "<tool>-<platform>-<arch>".
const FFMPEG_SHA256_GZ = {
  'ffmpeg-linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'ffprobe-linux-x64': '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
};

// darwin: SHA-256 der entpackten Binaries aus den evermeet-Zips (7.0.2,
// x86_64 — derselbe Build für beide Arch-Schlüssel: nativ auf Intel,
// via Rosetta 2 auf Apple Silicon). Einmalig aus den Zips berechnet;
// die URLs sind versioniert und unveränderlich.
const FFMPEG_SHA256_DARWIN = {
  'ffmpeg-darwin-arm64': '963c2a860d7da397858be2dc6e15cd1ce07581b1d740566983f2754e61b6cfd5',
  'ffprobe-darwin-arm64': '974da255767e9805b8922f27bfdf98f7e47863b3748da9f094b145118d56f49c',
  'ffmpeg-darwin-x64': '963c2a860d7da397858be2dc6e15cd1ce07581b1d740566983f2754e61b6cfd5',
  'ffprobe-darwin-x64': '974da255767e9805b8922f27bfdf98f7e47863b3748da9f094b145118d56f49c',
};

const MIN_FFMPEG_VERSION = [7, 0, 0];

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[ffmpeg] ${message}`);
}

function ffmpegReleaseTag() {
  // Pin-Tag je Plattform: darwin = evermeet-7.0.2, linux = ffmpeg-static b6.1.1.
  return process.platform === 'darwin' ? DARWIN_PIN_TAG : FFMPEG_STATIC_RELEASE;
}

/**
 * Gemeldete Version einer Binary als Array [major, minor, patch] oder null.
 */
function binaryVersion(tool, appRoot) {
  try {
    const out = require('child_process').execFileSync(binaryPath(tool, appRoot), ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /version\s+(\d+)\.(\d+)\.(\d+)/.exec(String(out));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  } catch (_) {
    return null;
  }
}

// ── SHA-256-Referenz der entpackten Binaries (QA F-FB-03) ──
// Die gepinnten Prüfsummen (FFMPEG_SHA256_GZ) gelten für die .gz-Release-
// Assets; der Download-Pfad verifiziert sie und kennt dadurch die SHA-256
// der entpackten Binary. Diese Referenz wird neben dem Marker persistiert
// (bin/.ffmpeg-sha256.json), damit der Ensure-Schnellpfad die installierte
// Binary ohne Netzwerk gegen das gepinnte Bundle prüfen kann. Fehlt die
// Datei (Update von < 0.5.10, install.sh-Beilage), wird sie einmalig aus
// dem gepinnten Asset abgeleitet und fortan lokal vorgehalten.
function sha256ReferenceFilePath(appRoot) {
  return path.join(binaryDir(appRoot), 'bin', '.ffmpeg-sha256.json');
}

function readSha256References(appRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sha256ReferenceFilePath(appRoot), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeSha256Reference(appRoot, tool, sha) {
  const refs = readSha256References(appRoot);
  refs[binaryKey(tool)] = sha;
  fs.writeFileSync(sha256ReferenceFilePath(appRoot), `${JSON.stringify(refs, null, 2)}\n`, 'utf-8');
}

// Prozess-lokaler Cache für die abgeleitete Referenz (vermeidet doppelte
// Downloads, wenn ffmpeg und ffprobe nacheinander geprüft werden).
const UNPACKED_SHA256_CACHE = new Map(); // binaryKey → sha

// TEST-SEAM: Tests können den Bundle-Download übersetzen (fn(tool, tmpDir) →
// Pfad einer gestellt verifizierten Binary in tmpDir). Produktiv immer null.
let testDownloadOverride = null;

async function deriveUnpackedSha256(tool) {
  const key = binaryKey(tool);
  const cached = UNPACKED_SHA256_CACHE.get(key);
  if (cached) return cached;

  // Deterministische Referenz: gepinnte .gz-Asset-Prüfsumme verifizieren,
  // entpacken, SHA-256 der entpackten Binary nehmen.
  const asset = `${key}.gz`;
  const url = `${FFMPEG_STATIC_BASE_URL}/${asset}`;
  const expectedGzSha = FFMPEG_SHA256_GZ[key];
  if (!expectedGzSha) throw new Error(`Keine gepinnte Prüfsumme für ${key}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-ffmpeg-sha-'));
  try {
    const gzPath = path.join(tmpDir, asset);
    await downloadFile(url, gzPath);
    const actualGzSha = sha256File(gzPath);
    if (actualGzSha !== expectedGzSha) {
      throw new Error(`Prüfsummen-Fehler für ${asset}: erwartet ${expectedGzSha}, erhalten ${actualGzSha}`);
    }
    require('child_process').execFileSync('gunzip', ['-kf', gzPath], { timeout: 60000 });
    const sha = sha256File(gzPath.replace(/\.gz$/, ''));
    UNPACKED_SHA256_CACHE.set(key, sha);
    return sha;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function binaryKey(tool) {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return `${tool}-${platform}-${arch}`;
}

function binaryDir(appRoot) {
  return appRoot || path.join(__dirname, '..');
}

/**
 * Entpackt ein Zip-Archiv mit genau einer Datei in destDir und liefert den
 * Pfad dieser Datei (darwin-Pfad; `unzip` ist auf macOS systemseitig
 * vorhanden — /usr/bin/unzip).
 */
function unzipSingleFile(zipPath, destDir) {
  require('child_process').execFileSync('unzip', ['-o', zipPath, '-d', destDir], {
    timeout: 60000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const entries = fs.readdirSync(destDir).filter(name => !name.endsWith('.zip'));
  if (entries.length !== 1) {
    throw new Error(`Unerwarteter Zip-Inhalt in ${path.basename(zipPath)}: ${entries.join(', ') || 'leer'}`);
  }
  return path.join(destDir, entries[0]);
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
  const got = binaryVersion(tool, appRoot);
  if (!got) return false;
  for (let i = 0; i < MIN_FFMPEG_VERSION.length; i++) {
    if (got[i] !== (MIN_FFMPEG_VERSION[i] || 0)) return got[i] > (MIN_FFMPEG_VERSION[i] || 0);
  }
  return true;
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
  const key = binaryKey(tool);
  const isDarwin = key.includes('-darwin-');
  const pinTag = isDarwin ? DARWIN_PIN_TAG : FFMPEG_STATIC_RELEASE;

  // Gepinnte Integritätsreferenz je Quelle: linux = SHA der .gz-Assets,
  // darwin = SHA der entpackten Binary (evermeet-Zips, siehe oben).
  const pinnedSha = isDarwin ? FFMPEG_SHA256_DARWIN[key] || null : FFMPEG_SHA256_GZ[key] || null;
  if (!pinnedSha) {
    throw new Error(`Keine gepinnte Prüfsumme für ${key} (Plattform nicht unterstützt)`);
  }

  const markerTag = (() => {
    try {
      return fs.readFileSync(versionFile, 'utf-8').trim();
    } catch (_) {
      return null;
    }
  })();
  // isBinaryHealthy enthält bereits die Mindestversionsprüfung (≥ 7.0.0).
  const healthy = isBinaryHealthy(tool, appRoot);

  // 1) Gesunder Bestand ohne Download (schneller Pfad) — NUR wenn Version UND
  //    Integrität dem gepinnten Bundle entsprechen (QA F-FB-03: früher reichte
  //    „Binary vorhanden + Marker-Tag passt", wodurch eine abweichende Binary
  //    — z. B. ffmpeg 6.0 mit passendem Marker — dauerhaft stehen blieb).
  if (!force && healthy) {
    if (markerTag !== pinTag) {
      // Bestand gesund, aber aus anderem Release: Binaries im Bundle-Verzeichnis
      // sind über den Update-Checkout versioniert — hier gilt der Release-Tag
      // der laufenden App als Quelle der Wahrheit und die Binary wird erneuert.
      log('info', `${tool}: Release-Wechsel ${markerTag || 'unbekannt'} → ${pinTag}, erneuere`);
    } else {
      const actualSha = sha256File(bin);
      let expectedUnpackedSha;
      if (isDarwin) {
        // Der darwin-Pin GILT für die entpackte Binary — keine Ableitung nötig.
        // Fix (Fix-Set 4b, ffmpeg-Test t_141 „pin-identischer Bestand"): zusätzlich
        // akzeptiert wird die lokal persistierte Installations-Referenz
        // (writeSha256Reference — wird nach jeder verifizierten Installation
        // geschrieben). Sonst scheitert der Schnellpfad auf darwin deterministisch
        // an Test-/Mock-Beständen, deren SHA nicht der evermeet-Pin ist; der
        // F-FB-03-Schutz bleibt intakt (abweichende Binary hat weder Pin-SHA
        // noch Referenz-SHA → wird erneuert).
        expectedUnpackedSha = readSha256References(appRoot)[key] || pinnedSha;
      } else {
        expectedUnpackedSha = readSha256References(appRoot)[key] || null;
        if (!expectedUnpackedSha) {
          // Referenz noch nicht lokal vorhanden (Update von < 0.5.10 oder
          // manuell beigefügte Binaries): einmalig aus dem gepinnten Asset
          // ableiten und persistieren — danach läuft die Prüfung offline.
          expectedUnpackedSha = await deriveUnpackedSha256(tool);
          writeSha256Reference(appRoot, tool, expectedUnpackedSha);
        }
      }
      if (actualSha === expectedUnpackedSha) {
        const version = binaryVersion(tool, appRoot);
        log(
          'info',
          `${tool}: vorhandene Binary OK (${version ? `v${version.join('.')}` : 'Version unbekannt'}, sha256 ${actualSha.slice(0, 12)}…)`,
        );
        return { tool, path: bin, action: 'ok', version, sha256: actualSha };
      }
      log('warn', `${tool}: Binary weicht vom gepinnten Bundle ab (sha256 ${actualSha.slice(0, 12)}…) — erneuere`);
    }
  }

  // 2) Download in temporäres Verzeichnis, Prüfsumme, dann atomar einspielen.
  //    linux: .gz-Asset vom ffmpeg-static-Release, SHA des Archivs gegen den
  //    Pin, entpacken. darwin: versioniertes Zip von evermeet.cx, SHA der
  //    ENTPACKTEN Binary gegen den Pin (das Zip selbst ist nicht gepinnt).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-ffmpeg-'));
  try {
    let stagedBinary;
    if (testDownloadOverride) {
      stagedBinary = testDownloadOverride(tool, tmpDir);
    } else if (isDarwin) {
      const asset = `${tool}.zip`;
      const url = `${DARWIN_BASE_URL}/${tool}-${DARWIN_FFMPEG_VERSION}.zip`;
      const zipPath = path.join(tmpDir, asset);
      log('info', `${tool}: lade ${url} …`);
      if (logProgress) logProgress(`ffmpeg wird geladen (${tool}) …`);
      await downloadFile(url, zipPath);
      stagedBinary = unzipSingleFile(zipPath, tmpDir);
      const stagedSha = sha256File(stagedBinary);
      if (stagedSha !== pinnedSha) {
        throw new Error(
          `Prüfsummen-Fehler für ${asset}: erwartet ${pinnedSha}, erhalten ${stagedSha} — Download wird verworfen`,
        );
      }
    } else {
      const asset = `${key}.gz`;
      const url = `${FFMPEG_STATIC_BASE_URL}/${asset}`;
      const gzPath = path.join(tmpDir, asset);
      log('info', `${tool}: lade ${url} …`);
      if (logProgress) logProgress(`ffmpeg wird geladen (${tool}) …`);
      await downloadFile(url, gzPath);

      const actual = sha256File(gzPath);
      if (actual !== pinnedSha) {
        throw new Error(
          `Prüfsummen-Fehler für ${asset}: erwartet ${pinnedSha}, erhalten ${actual} — Download wird verworfen`,
        );
      }

      require('child_process').execFileSync('gunzip', ['-kf', gzPath], { timeout: 60000 });
      stagedBinary = gzPath.replace(/\.gz$/, '');
    }
    fs.chmodSync(stagedBinary, 0o755);

    // Ausführlichkeit der frischen Binary beweisen, bevor sie eingesetzt wird.
    const smoke = require('child_process').execFileSync(stagedBinary, ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!/version\s+\d+\.\d+/.test(String(smoke))) {
      throw new Error(`${tool}: frische Binary liefert keine Versionsausgabe`);
    }

    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(stagedBinary, bin);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(versionFile, `${pinTag}\n`, 'utf-8');
    // SHA-256-Referenz der installierten (prüfsummenverifizierten) Binary
    // persistieren — Basis für den Ensure-Schnellpfad ohne Netzwerk.
    const installedSha = sha256File(bin);
    writeSha256Reference(appRoot, tool, installedSha);
    UNPACKED_SHA256_CACHE.set(key, installedSha);
    const version = binaryVersion(tool, appRoot);
    log(
      'info',
      `${tool}: installiert (${pinTag}, ${version ? `v${version.join('.')}` : 'Version unbekannt'}, sha256 ${installedSha.slice(0, 12)}…) nach ${bin}`,
    );
    return { tool, path: bin, action: 'downloaded', version, sha256: installedSha };
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
  binaryVersion,
  ffmpegReleaseTag,
  sha256File,
  FFMPEG_STATIC_RELEASE,
  FFMPEG_SHA256_GZ,
  FFMPEG_SHA256_DARWIN,
  // Für Tests: gepinnte SHA-Referenz der entpackten Binaries einspielen,
  // ohne den Ableitungs-Download anzustoßen.
  sha256ReferenceFilePath,
  readSha256References,
  writeSha256Reference,
  __setUnpackedSha256CacheForTests: (key, sha) => UNPACKED_SHA256_CACHE.set(key, sha),
  __clearUnpackedSha256CacheForTests: () => UNPACKED_SHA256_CACHE.clear(),
  __setDownloadOverrideForTests: fn => {
    testDownloadOverride = fn;
  },
};
