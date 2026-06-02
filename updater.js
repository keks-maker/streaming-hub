// v0.3.6.
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

function getCurrentVersion() {
  try {
    const raw = execSync('git describe --tags --abbrev=0', {
      cwd: appDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return raw.replace(/^v/i, '');
  } catch (e) {
    return null;
  }
}

process.on('message', (msg) => {
  if (msg.type === 'check') {
    try {
      const currentVersion = getCurrentVersion() || msg.currentVersion;
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
        hasUpdate: latest ? cmpVersions(latest, currentVersion) > 0 : false,
      });
    } catch (e) {
      process.send({ type: 'result', error: e.message });
    }
  } else if (msg.type === 'apply') {
    try {
      process.send({ type: 'progress', step: 'Aktualisierungen abrufen…', percent: 10 });
      execSync('git fetch --tags --force origin', {
        cwd: appDir, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      process.send({ type: 'progress', step: `Version v${msg.version} wird angewendet…`, percent: 40 });
      try {
        execSync('git stash --include-untracked', {
          cwd: appDir, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) { /* nothing to stash */ }
      execSync(`git checkout --force v${msg.version}`, {
        cwd: appDir, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        execSync('git stash pop', {
          cwd: appDir, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) { /* stash pop may conflict – user config preserved */ }
      process.send({ type: 'progress', step: 'Abhängigkeiten werden installiert…', percent: 65 });
      execSync('npm install --ignore-scripts', {
        cwd: appDir, encoding: 'utf-8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      process.send({ type: 'progress', step: 'Fertig – Neustart…', percent: 100 });
      process.send({ type: 'applied' });
    } catch (e) {
      process.send({ type: 'applied', error: e.message });
    }
  }
});
