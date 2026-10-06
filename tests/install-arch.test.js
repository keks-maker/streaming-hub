'use strict';
/**
 * install.sh: Architektur-Erkennung und Release-Auswahl je Plattform.
 * Die Helfer zwischen den arch-helpers-Markern werden extrahiert und in bash ausgefuehrt
 * (uname/sysctl/file per Funktion gefaelscht); der Release-Pfad laeuft gegen eine lokale
 * gefaelschte Releases-API (STREAMING_HUB_RELEASES_API_URL) und STREAMING_HUB_ARCH.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const installSh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const helpers = installSh.slice(installSh.indexOf('# >>> arch-helpers'), installSh.indexOf('# <<< arch-helpers'));
const isMac = process.platform === 'darwin';

function bash(script, env = {}) {
  const r = spawnSync('bash', ['-c', `${helpers}\n${script}`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('strukturell: Arch-Erkennung, Kategorie-Auswahl und Mach-O-Pruefung sind verdrahtet', () => {
  assert.ok(helpers.includes('detect_mac_arch'));
  assert.match(installSh, /ELECTRON_ARCH="\$\(detect_mac_arch\)"/);
  assert.match(installSh, /RELEASE_TARGET="darwin-\$ELECTRON_ARCH"/);
  assert.match(installSh, /"\$RELEASE_HELPER" "\$RELEASE_LIB" "\$RELEASES_API_URL" "\$RELEASE_TARGET"/);
  assert.ok(installSh.indexOf('macho_matches_arch "$RELEASE_EXEC"') < installSh.indexOf('mkdir -p "$RELEASE_INSTALL_STAGE"'), 'Mach-O-Pruefung vor dem Staging');
  assert.match(installSh, /Für Intel-Macs \(x64\) gibt es noch kein Release/);
  assert.doesNotMatch(installSh, /Streaming\.Hub-\$\{RELEASE_VERSION\}-mac\.zip/, 'Asset-Name kommt aus dem Release, nicht hartkodiert');
});

test('detect_mac_arch: uname-Werte, Rosetta-Korrektur, Overrides', () => {
  const uname = m => `uname() { echo ${m}; }; sysctl() { return 1; };`;
  assert.equal(bash(`${uname('arm64')} detect_mac_arch`).out, 'arm64');
  assert.equal(bash(`${uname('x86_64')} detect_mac_arch`).out, 'x64', 'echter Intel-Mac: kein hw.optional.arm64');
  // Rosetta-Shell auf Apple Silicon: uname meldet x86_64, hw.optional.arm64 ist 1
  assert.equal(bash(`uname() { echo x86_64; }; sysctl() { echo 1; }; detect_mac_arch`).out, 'arm64');
  // Intel-Mac, sysctl-Key vorhanden aber 0
  assert.equal(bash(`uname() { echo x86_64; }; sysctl() { echo 0; }; detect_mac_arch`).out, 'x64');
  assert.equal(bash(`${uname('arm64')} detect_mac_arch`, { STREAMING_HUB_ARCH: 'x64' }).out, 'x64');
  assert.equal(bash(`${uname('x86_64')} detect_mac_arch`, { STREAMING_HUB_ARCH: 'aarch64' }).out, 'arm64');
  assert.notEqual(bash(`${uname('arm64')} detect_mac_arch`, { STREAMING_HUB_ARCH: 'ppc' }).code, 0);
  assert.notEqual(bash(`${uname('i386')} detect_mac_arch`).code, 0);
});

test('macho_matches_arch: thin, universal, falsche Arch, kein Mach-O', () => {
  const fake = info => `file() { echo "${info}"; }; f=$(mktemp); `;
  const thin = (info, arch) => bash(`${fake(info)} macho_matches_arch "$f" ${arch}`).code;
  assert.equal(thin('Mach-O 64-bit executable arm64', 'arm64'), 0);
  assert.notEqual(thin('Mach-O 64-bit executable arm64', 'x64'), 0);
  assert.equal(thin('Mach-O 64-bit executable x86_64', 'x64'), 0);
  assert.notEqual(thin('Mach-O 64-bit executable x86_64', 'arm64'), 0);
  assert.equal(thin('Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64]', 'x64'), 0);
  assert.notEqual(thin('ASCII text', 'arm64'), 0);
  assert.notEqual(bash('macho_matches_arch /nonexistent arm64').code, 0);
  assert.notEqual(bash('f=$(mktemp); macho_matches_arch "$f" riscv').code, 0);
});

test('macho_matches_arch: echtes Systembinary (nur macOS)', { skip: !isMac }, () => {
  const host = os.arch() === 'arm64' ? 'arm64' : 'x64';
  assert.equal(bash(`macho_matches_arch /bin/ls ${host}`).code, 0);
});

// Der Release-Pfad scheitert bewusst vor jeder Installation (keine passende Release-Kategorie).
function runInstaller(releases, arch) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(new URL(req.url, 'http://x').searchParams.get('page') === '1' ? releases : []));
    });
    server.listen(0, '127.0.0.1', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-arch-'));
      const child = spawn('bash', [path.join(root, 'install.sh')], {
        env: {
          ...process.env,
          HOME: tmp, TMPDIR: tmp, INSTALL_DIR: path.join(tmp, 'inst'),
          STREAMING_HUB_ARCH: arch,
          STREAMING_HUB_RAW_BASE: `file://${root}`,
          STREAMING_HUB_RELEASES_API_URL: `http://127.0.0.1:${server.address().port}/releases`,
        },
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('close', code => { server.close(); const installed = fs.existsSync(path.join(tmp, 'inst')); fs.rmSync(tmp, { recursive: true, force: true }); resolve({ code, out, installed }); });
    });
  });
}
const rel = (tag, name) => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name, browser_download_url: `https://example.test/${tag}/${name}` }] });

test('Installer x64 ohne x64-Release: klare Meldung, kein arm64-Fallback, nichts installiert', { skip: !isMac }, async () => {
  const r = await runInstaller([rel('v0.9.4', 'Streaming.Hub-0.9.4-mac.zip')], 'x64');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Für Intel-Macs \(x64\) gibt es noch kein Release/);
  assert.doesNotMatch(r.out, /Installiere GitHub-Release/);
  assert.equal(r.installed, false);
});

test('Installer arm64 ohne arm64-Release (nur x64 vorhanden): Fehler statt falschem Asset', { skip: !isMac }, async () => {
  const r = await runInstaller([rel('v0.9.5-x64', 'Streaming.Hub-0.9.5-mac-x64.zip')], 'arm64');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Kein gültiges GitHub-Release für macOS arm64/);
  assert.doesNotMatch(r.out, /Installiere GitHub-Release/);
});

test('Installer x64 waehlt das x64-Release (Download-Schritt beginnt mit x64-Version)', { skip: !isMac }, async () => {
  const r = await runInstaller([rel('v0.9.4', 'Streaming.Hub-0.9.4-mac.zip'), rel('v0.9.5-x64', 'Streaming.Hub-0.9.5-mac-x64.zip')], 'x64');
  assert.match(r.out, /Installiere GitHub-Release v0\.9\.5 \(macOS x64\)/);
  assert.match(r.out, /Release-Asset konnte nicht geladen werden/, 'Download der Fake-URL scheitert erwartungsgemaess');
});
