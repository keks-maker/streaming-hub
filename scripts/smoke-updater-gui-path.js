// Headless-Smoke (S-Klasse t_9f74c461): kompletter updater.js-Apply-Pfad
// unter simuliertem GUI-Start-PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Spiegelt das fork()-Setup aus main.js apply-update: ELECTRON_RUN_AS_NODE=1,
// IPC-message 'apply' → Checkout eines Tags in einer Sandbox-Repo → npm
// install/build übersprungen? NEIN — echtes npm, echte Builds (build:all).
// ffmpeg-Ensure läuft gegen gepinnte Referenzen (Downloads erlaubt).
'use strict';

const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function sh(cmd, opts = {}) {
  return execFileSync('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-smoke-'));
  const appDir = path.join(tmp, 'app');
  console.log('[smoke] sandbox:', appDir);

  // 1) Sandbox-Repo aus dem echten Arbeitsstand bauen (Dateien kopieren + git init)
  fs.mkdirSync(appDir);
  sh(`git init --quiet`, { cwd: appDir });
  sh(`git config user.email t@t && git config user.name t`, { cwd: appDir });
  // Arbeitskopie ohne node_modules/dist/.git kopieren
  sh(`tar -C ${JSON.stringify(REPO)} --exclude=node_modules --exclude=.git --exclude=dist --exclude=packages/typed-core/dist -cf - . | tar -C ${JSON.stringify(appDir)} -xf -`);
  sh(`git add -A && git commit --quiet -m base`, { cwd: appDir });
  sh(`git tag v0.5.12`, { cwd: appDir });
  // Zustand "altes Tag": Datei ändern + commit (HEAD ≠ Tag) + Tag löschen
  fs.writeFileSync(path.join(appDir, 'SMOKE.txt'), 'changed\n');
  sh(`git add -A && git commit --quiet -m after-tag`, { cwd: appDir });
  // origin-Remote auf das echte Repo setzen (updater fetcht gegen origin);
  // der Fetch wird im Test fehlschlagen dürfen? Nein — der Smoke prüft den
  // npm-Pfad, nicht das Netz. origin = Sandbox selbst (hat denselben Stand).
  sh(`git remote add origin ${JSON.stringify(appDir)}`, { cwd: appDir });

  // 2) Fork wie main.js — mit GUI-Mini-PATH (Kern des Tests)
  const child = fork(path.join(REPO, 'updater.js'), [appDir], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PATH: GUI_PATH,
      ELECTRON_RUN_AS_NODE: '1',
      STREAMING_HUB_NODE_DIR: path.dirname(process.execPath),
      STREAMING_HUB_UPDATER_LOG: path.join(tmp, 'updater.log'),
    },
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout nach 240s')), 240000);
    child.on('message', msg => {
      if (msg.type === 'progress') {
        console.log(`[smoke] ${String(msg.percent).padStart(3)}% ${msg.step}`);
      } else if (msg.type === 'applied') {
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.type === 'result') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`updater exit code=${code} signal=${signal}`));
    });
    child.send({ type: 'apply', version: '0.5.12' });
  });

  const log = fs.readFileSync(path.join(tmp, 'updater.log'), 'utf-8');
  console.log('--- updater.log (Tail) ---');
  console.log(log.split('\n').slice(-14).join('\n'));

  if (result.error) {
    console.error('[smoke] APPLY FEHLGESCHLAGEN:', result.error);
    process.exitCode = 1;
  } else {
    console.log('[smoke] APPLY ERFOLGREICH');
    // Beweis: Checkout stand auf dem Tag
    const describe = sh('git describe --tags', { cwd: appDir }).trim();
    console.log('[smoke] sandbox-stand nach apply:', describe);
  }
  child.kill();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

main().catch(e => {
  console.error('[smoke] FEHLER:', e.message);
  process.exit(1);
});
