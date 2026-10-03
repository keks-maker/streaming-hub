const path = require('path');

exports.default = function (context) {
  if (process.platform !== 'darwin') return;
  const { execFileSync } = require('child_process');
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
