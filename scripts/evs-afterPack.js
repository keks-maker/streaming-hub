const path = require('path');

// Die macOS-ffmpeg-Binaries aus bin/ (git-ignoriert, lokal fuer den Mac-Build geladen) gehoeren nicht ins
// Linux-Paket: falsche Architektur. Linux nutzt ein System-ffmpeg oder laedt die gepinnte Binary beim Start
// (lib/ffmpeg.js ensureBinaries); der Updater uebernimmt vorhandene Binaries der alten Installation.
function stripMacFfmpeg(context) {
  const fs = require('fs');
  const binDir = path.join(context.appOutDir, 'resources', 'app', 'bin');
  for (const name of ['ffmpeg', 'ffprobe', '.ffmpeg-release', '.ffmpeg-sha256.json']) {
    fs.rmSync(path.join(binDir, name), { force: true });
  }
}

exports.default = async function (context) {
  if (context.electronPlatformName === 'linux') stripMacFfmpeg(context);
  // Zielplattform des Pakets (nicht der Build-Host): Linux-/Windows-Cross-Builds vom Mac werden nicht VMP-signiert.
  if (context.electronPlatformName !== 'darwin') return;
  const { execFileSync } = require('child_process');
  const appBundle = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  // Zur Ziel-Architektur passende ffmpeg/ffprobe ins Paket (nicht das Host-bin/ des Entwicklers); vor allen Signaturen.
  const arch = require('builder-util').Arch[context.arch];
  const stagedBin = await require('./stage-mac-ffmpeg').stageMacFfmpeg(path.join(appBundle, 'Contents', 'Resources', 'app'), arch);
  console.log('[ffmpeg] ' + arch + '-Binaries im Paket:', stagedBin);
  // Vor VMP-/Code-Signatur: eigene Mach-O-UUIDs, damit macOS die Freigabe "Lokales Netzwerk" abfragt.
  const patched = require('./macho-uuid').applyUniqueUuids(
    appBundle,
    context.packager.appInfo.productFilename,
    context.packager.appInfo.id
  );
  console.log('[uuid] eindeutige Mach-O-UUID:', patched.length, 'Executables');
  const py = process.env.EVS_PYTHON || 'python3';
  console.log('[EVS] VMP signing (macOS, before code-sign):', context.appOutDir);
  execFileSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });

  // Ohne Apple-Developer-ID: gesamte .app konsistent ad-hoc signieren (Info.plist und
  // Resources gebunden). Muss NACH dem VMP-Signieren laufen; build.mac.identity=null
  // verhindert, dass electron-builder danach erneut (inkonsistent) signiert.
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  console.log('[codesign] ad-hoc Re-Sign:', appPath);
  execFileSync('codesign', ['--force', '--deep', '-s', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
