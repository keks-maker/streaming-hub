exports.default = function (context) {
  if (process.platform !== 'darwin') return;
  const { execSync } = require('child_process');
  const py = process.env.EVS_PYTHON || 'python3';
  console.log('[EVS] VMP signing (macOS, before code-sign):', context.appOutDir);
  execSync(py + ' -m castlabs_evs.vmp sign-pkg "' + context.appOutDir + '"', { stdio: 'inherit' });
};
