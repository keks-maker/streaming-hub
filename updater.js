const { execSync } = require('child_process');

const appDir = process.argv[2];

function cmpVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

process.on('message', (msg) => {
  if (msg.type === 'check') {
    try {
      const out = execSync('git ls-remote --tags origin', {
        cwd: appDir, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const tags = new Set();
      for (const line of out.split('\n')) {
        const m = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+)/);
        if (m) tags.add(m[1]);
      }
      const sorted = [...tags].sort(cmpVersions);
      const latest = sorted[sorted.length - 1] || null;
      process.send({
        type: 'result',
        latest,
        hasUpdate: latest ? cmpVersions(latest, msg.currentVersion) > 0 : false,
      });
    } catch (e) {
      process.send({ type: 'result', error: e.message });
    }
  } else if (msg.type === 'apply') {
    try {
      execSync('git fetch --tags origin', {
        cwd: appDir, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      execSync(`git checkout v${msg.version}`, {
        cwd: appDir, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      execSync('npm install', {
        cwd: appDir, encoding: 'utf-8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      process.send({ type: 'applied' });
    } catch (e) {
      process.send({ type: 'applied', error: e.message });
    }
  }
});
