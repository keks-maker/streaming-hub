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
// - darwin-x64 (Intel): versionierte Zips von evermeet.cx (ffmpeg-7.0.2.zip,
//   statisch, x86_64), gepinnt über die SHA-256 der ENTPACKTEN Binaries.
//   Hintergrund (QA F-FB-03, 30.09.2026): der ffmpeg-static-darwin-Build des
//   Tags b6.1.1 meldet ffmpeg 6.0 — der Tag-Name pinnt die macOS-Version
//   NICHT (ffmpeg-static Issue #151).
// - darwin-arm64 (Apple Silicon): NATIVE arm64-Binaries (ffmpeg/ffprobe 7.1)
//   von osxexperts.net (ffmpeg71arm.zip / ffprobe71arm.zip, statisch,
//   Oktober 2024), gepinnt über die SHA-256 der entpackten Binaries. Vorher
//   lief hier der x86_64-Build über Rosetta 2; macOS 28 entfernt Rosetta
//   (Start-Meldung „App-Update erforderlich“). Lizenz: GPL (configure mit
//   --enable-gpl, u. a. libx264/libx265); die App ruft die Binaries nur als
//   eigenen Prozess auf (Stream-Copy, kein Linken) und liefert den Quelltext-
//   Verweis über den Upstream (ffmpeg.org, Build-Skript osxexperts.net). Die
//   URL ist nicht versioniert-unveränderlich wie bei evermeet — die gepinnte
//   SHA-256 erzwingt trotzdem exakt dieses Artefakt (bei Änderung am Host
//   schlägt der Download fehl statt eine andere Binary zu installieren).
//   Ein vorhandenes x86_64-Mach-O gilt auf arm64 NICHT mehr als gesund
//   (machoArchs) und wird beim Start/Update durch arm64 ersetzt.
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

// darwin-Quellen je Architektur (Download-URL je Tool, Marker-Tag des Pin-Satzes).
const DARWIN_SOURCES = {
  // Intel: evermeet.cx, versionierte Zips (ffmpeg 7.0.2, statisch, x86_64).
  x64: {
    version: '7.0.2',
    tag: 'evermeet-7.0.2',
    url: tool => `https://evermeet.cx/ffmpeg/${tool}-7.0.2.zip`,
  },
  // Apple Silicon: osxexperts.net, native arm64-Builds (ffmpeg 7.1, GPL).
  arm64: {
    version: '7.1',
    tag: 'osxexperts-7.1-arm64',
    url: tool => `https://www.osxexperts.net/${tool}71arm.zip`,
  },
};

// SHA-256 der .gz-Release-Assets (einmalig aus dem Release b6.1.1 berechnet;
// GitHub-Release-Assets sind immutable). Nur linux — die darwin-Assets des
// Tags melden ffmpeg 6.0 (siehe Kommentar oben) und werden nicht genutzt.
// Schlüssel: "<tool>-<platform>-<arch>".
const FFMPEG_SHA256_GZ = {
  'ffmpeg-linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'ffprobe-linux-x64': '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
};

// darwin: SHA-256 der ENTPACKTEN Binaries. x64 = evermeet 7.0.2 (x86_64),
// arm64 = osxexperts 7.1 (arm64, nativ). Einmalig aus den Zips berechnet.
const FFMPEG_SHA256_DARWIN = {
  'ffmpeg-darwin-arm64': '6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617',
  'ffprobe-darwin-arm64': 'df2684842eca145bd72f4724ce9cecbf38558a4d64b2aef7846680f877702baa',
  'ffmpeg-darwin-x64': '963c2a860d7da397858be2dc6e15cd1ce07581b1d740566983f2754e61b6cfd5',
  'ffprobe-darwin-x64': '974da255767e9805b8922f27bfdf98f7e47863b3748da9f094b145118d56f49c',
};

const MIN_FFMPEG_VERSION = [7, 0, 0];

function log(level, message) {
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[fn](`[ffmpeg] ${message}`);
}

function darwinSource(arch) {
  return DARWIN_SOURCES[arch === 'arm64' ? 'arm64' : 'x64'];
}

function ffmpegReleaseTag(arch = process.arch) {
  // Pin-Tag je Plattform/Arch: darwin-x64 = evermeet-7.0.2, darwin-arm64 =
  // osxexperts-7.1-arm64, linux = ffmpeg-static b6.1.1.
  return process.platform === 'darwin' ? darwinSource(arch).tag : FFMPEG_STATIC_RELEASE;
}

// ── Mach-O-Architektur (darwin) ──
// Eine x86_64-Binary läuft auf Apple Silicon nur über Rosetta 2 (ab macOS 28
// entfernt). Der Health-Check liest darum den Mach-O-Header, statt nur
// `-version` auszuführen.
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' };

/**
 * Architekturen einer Mach-O-Datei als Array ('x64' | 'arm64' | 'other'),
 * Fat-Binaries liefern alle Slices. null = keine Mach-O-Datei (z. B. Skript)
 * oder nicht lesbar.
 */
function machoArchs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8 + 20 * 8);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 8) return null;
    const be = head.readUInt32BE(0);
    if (be === 0xcafebabe) {
      const count = Math.min(head.readUInt32BE(4), 8);
      const archs = [];
      for (let i = 0; i < count && 8 + i * 20 + 4 <= n; i++) {
        archs.push(MACHO_CPU[head.readUInt32BE(8 + i * 20)] || 'other');
      }
      return archs;
    }
    if (head.readUInt32LE(0) === 0xfeedfacf) return [MACHO_CPU[head.readUInt32LE(4)] || 'other'];
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

/** Passt die Architektur der Binary zur Ziel-Architektur? Nicht-Mach-O (Skript) gilt als passend. */
function archMatches(file, arch) {
  if (process.platform !== 'darwin') return true;
  const archs = machoArchs(file);
  return archs === null || archs.includes(arch === 'arm64' ? 'arm64' : 'x64');
}

/**
 * Gemeldete Version einer Binary als Array [major, minor, patch] oder null.
 */
function parseVersion(out) {
  // „version 7.0.2-static" (Bundle) ebenso wie „version n9.0.2" (Distro-/Git-Tag-Builds).
  // Release-Builds ohne Patchstufe („ffmpeg version 7.1 Copyright …“) ergeben [7, 1, 0]; die Zeile
  // „built with Apple clang version 13.1.6“ darf nie als ffmpeg-Version gelten.
  const text = String(out);
  const match =
    /\bff(?:mpeg|probe)\s+version\s+n?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text) ||
    /version\s+n?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function versionAtLeastMin(got) {
  for (let i = 0; i < MIN_FFMPEG_VERSION.length; i++) {
    if (got[i] !== (MIN_FFMPEG_VERSION[i] || 0)) return got[i] > (MIN_FFMPEG_VERSION[i] || 0);
  }
  return true;
}

function versionOfFile(file) {
  try {
    const out = require('child_process').execFileSync(file, ['-version'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseVersion(out);
  } catch (_) {
    return null;
  }
}

function binaryVersion(tool, appRoot, arch = process.arch) {
  // Fremde Architektur (Cross-Build) ist auf diesem Host nicht ausführbar.
  if (arch !== process.arch) return null;
  return versionOfFile(binaryPath(tool, appRoot));
}

// ── System-Binary bevorzugen (Linux) ──
// Das gebündelte statische ffmpeg (johnvansickle) stürzt auf Systemen mit sehr
// neuer glibc bei jeder Hostnamen-Auflösung mit SIGSEGV ab (statisch gelinktes
// getaddrinfo/NSS) — `-version` läuft trotzdem, der Health-Check allein merkt
// es nie. Darum: auf Linux ein System-ffmpeg/-ffprobe (≥ MIN_FFMPEG_VERSION)
// nutzen, sofern es den Auflösungs-Probe übersteht; sonst Bundle.
// STREAMING_HUB_FFMPEG=bundled schaltet die Systempräferenz aus.
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL']);
const PROBE_URL = 'http://localhost:1/probe.m3u8';
const resolvedBinaryCache = new Map(); // `${appRoot}|${tool}` → Pfad

/**
 * Läuft die Binary ohne Absturz durch eine Hostnamen-Auflösung?
 * localhost:1 wird verweigert → reguläres Exit ≠ 0 ist „ok", ein Signal-Tod
 * (SEGV/ABRT/BUS/ILL) oder Startfehler nicht.
 */
function probeNetworkResolution(tool, file) {
  const args =
    tool === 'ffprobe'
      ? ['-v', 'error', PROBE_URL]
      : ['-nostdin', '-v', 'error', '-i', PROBE_URL, '-f', 'null', '-'];
  const r = require('child_process').spawnSync(file, args, { timeout: 10000, stdio: 'ignore' });
  if (r.error && r.error.code !== 'ETIMEDOUT') return false;
  return !(r.signal && CRASH_SIGNALS.has(r.signal));
}

function findSystemBinary(tool, appRoot) {
  const bundled = (() => {
    try {
      return fs.realpathSync(binaryPath(tool, appRoot));
    } catch (_) {
      return null;
    }
  })();
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (real === bundled || !fs.statSync(real).isFile()) continue;
      return candidate;
    } catch (_) {}
  }
  return null;
}

function systemBinaryPath(tool, appRoot) {
  if (process.platform !== 'linux' || process.env.STREAMING_HUB_FFMPEG === 'bundled') return null;
  const candidate = findSystemBinary(tool, appRoot);
  if (!candidate) return null;
  const version = versionOfFile(candidate);
  if (!version || !versionAtLeastMin(version)) return null;
  if (!probeNetworkResolution(tool, candidate)) return null;
  return candidate;
}

/**
 * Der tatsächlich zu startende Pfad: brauchbares System-Binary (Linux) vor
 * dem Bundle. Ergebnis wird pro Prozess gecacht (Probe spawnt einen Prozess).
 */
function resolveBinaryPath(tool, appRoot) {
  const key = `${binaryDir(appRoot)}|${tool}`;
  const cached = resolvedBinaryCache.get(key);
  if (cached) return cached;
  const system = systemBinaryPath(tool, appRoot);
  let chosen = system;
  if (system) {
    log('info', `${tool}: nutze System-Binary ${system}`);
  } else {
    chosen = binaryPath(tool, appRoot);
    if (
      process.platform === 'linux' &&
      fs.existsSync(chosen) &&
      !probeNetworkResolution(tool, chosen)
    ) {
      log(
        'warn',
        `${tool}: gebündelte Binary stürzt bei der Hostnamen-Auflösung ab und es gibt kein brauchbares ` +
          `System-Binary (≥ ${MIN_FFMPEG_VERSION.join('.')}) — bitte ffmpeg über den Paketmanager installieren`,
      );
    }
  }
  resolvedBinaryCache.set(key, chosen);
  return chosen;
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

function writeSha256Reference(appRoot, tool, sha, arch = process.arch) {
  const refs = readSha256References(appRoot);
  refs[binaryKey(tool, arch)] = sha;
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

function binaryKey(tool, targetArch = process.arch) {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
  const arch = targetArch === 'x64' ? 'x64' : targetArch === 'arm64' ? 'arm64' : targetArch;
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
  // „__MACOSX“ (AppleDouble-Metadaten, z. B. osxexperts) und Dotfiles sind kein Nutzinhalt.
  const entries = fs
    .readdirSync(destDir)
    .filter(name => !name.endsWith('.zip') && name !== '__MACOSX' && !name.startsWith('.'));
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
function isBinaryHealthy(tool, appRoot, arch = process.arch) {
  const bin = binaryPath(tool, appRoot);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch (_) {
    return false;
  }
  // Falsche Mach-O-Architektur (x86_64 auf Apple Silicon) ist nie „ok“, auch
  // wenn Rosetta sie noch ausführen würde.
  if (!archMatches(bin, arch)) return false;
  // Cross-Build (Ziel-Arch ≠ Host): nicht ausführbar, Header + SHA genügen.
  if (arch !== process.arch) return true;
  const got = binaryVersion(tool, appRoot, arch);
  if (!got) return false;
  return versionAtLeastMin(got);
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

async function ensureBinary(tool, appRoot, { force = false, logProgress = null, arch = process.arch } = {}) {
  const bin = binaryPath(tool, appRoot);
  const versionFile = versionFilePath(appRoot);
  const key = binaryKey(tool, arch);
  const isDarwin = key.includes('-darwin-');
  const pinTag = isDarwin ? darwinSource(arch).tag : FFMPEG_STATIC_RELEASE;

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
  const healthy = isBinaryHealthy(tool, appRoot, arch);

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
        const version = binaryVersion(tool, appRoot, arch);
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
      const url = darwinSource(arch).url(tool);
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
    if (isDarwin && !archMatches(stagedBinary, arch)) {
      throw new Error(`${tool}: heruntergeladene Binary hat nicht die Architektur ${arch}`);
    }
    if (arch === process.arch) {
      const smoke = require('child_process').execFileSync(stagedBinary, ['-version'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!/version\s+\d+\.\d+/.test(String(smoke))) {
        throw new Error(`${tool}: frische Binary liefert keine Versionsausgabe`);
      }
    }

    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(stagedBinary, bin);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(versionFile, `${pinTag}\n`, 'utf-8');
    // SHA-256-Referenz der installierten (prüfsummenverifizierten) Binary
    // persistieren — Basis für den Ensure-Schnellpfad ohne Netzwerk.
    const installedSha = sha256File(bin);
    writeSha256Reference(appRoot, tool, installedSha, arch);
    UNPACKED_SHA256_CACHE.set(key, installedSha);
    const version = binaryVersion(tool, appRoot, arch);
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

// Brauchbares System-Binary (Linux) ersetzt den Bundle-Download.
async function ensureOrSystem(tool, root, options) {
  const system = options && options.arch && options.arch !== process.arch ? null : systemBinaryPath(tool, root);
  if (system) {
    return { tool, path: system, action: 'system', version: versionOfFile(system), sha256: null };
  }
  return ensureBinary(tool, root, options);
}

/**
 * Stellt ffmpeg + ffprobe bereit (idempotent).
 * Rückgabe: { ffmpeg: {path, action}, ffprobe: {path, action}, ok, error }
 */
async function ensureBinaries(appRoot, options = {}) {
  const root = binaryDir(appRoot);
  const result = { ffmpeg: null, ffprobe: null, ok: false, error: null };
  try {
    result.ffmpeg = await ensureOrSystem('ffmpeg', root, options);
    result.ffprobe = await ensureOrSystem('ffprobe', root, options);
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
    if (!isBinaryHealthy(tool, root) && !systemBinaryPath(tool, root)) missing.push(tool);
  }
  return {
    ok: missing.length === 0,
    missing,
    ffmpegPath: missing.includes('ffmpeg') ? null : resolveBinaryPath('ffmpeg', root),
    ffprobePath: missing.includes('ffprobe') ? null : resolveBinaryPath('ffprobe', root),
    release: ffmpegReleaseTag(),
  };
}

module.exports = {
  ensureBinaries,
  ensureBinary,
  checkHealth,
  isBinaryHealthy,
  binaryPath,
  resolveBinaryPath,
  parseVersion,
  binaryVersion,
  ffmpegReleaseTag,
  machoArchs,
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
  __clearResolveCacheForTests: () => resolvedBinaryCache.clear(),
  __setDownloadOverrideForTests: fn => {
    testDownloadOverride = fn;
  },
};
