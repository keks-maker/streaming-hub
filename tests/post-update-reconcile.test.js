// Integrationstests für die Nach-Update-Reconciliation (lib/post-update-reconcile.js).
// Läuft in einer echten Git-Sandbox in tmp — kein Electron, keine Mocks für fs/git.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { reconcilePostUpdate } = require('../lib/post-update-reconcile');

let tmpRoot;
let gitEnv;

function sh(cmd, cwd) {
  execSync(cmd, { cwd, env: gitEnv, stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  // Git braucht eine Identität in der Sandbox:
  gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example',
  };
});

test.afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Legt ein App-Verzeichnis mit tvsources-Historie vOld/vNew an. */
function makeApp({ vOldSources, deviceSources, vNewSources, installedVersion, stateVersion, withBackup }) {
  const appDir = path.join(tmpRoot, 'app');
  fs.mkdirSync(appDir);
  sh('git init --quiet', appDir);

  // v0.4.82: committeter alter Stand
  writeJson(path.join(appDir, 'tvsources.json'), vOldSources);
  sh('git add -A', appDir);
  sh('git commit --quiet -m v0.4.82', appDir);
  sh('git tag v0.4.82', appDir);

  // v0.4.83: neuer Stand (simulierter Checkout des neuen Tags)
  writeJson(path.join(appDir, 'tvsources.json'), vNewSources);
  sh('git add -A', appDir);
  sh('git commit --quiet -m v0.4.83', appDir);
  sh('git tag v0.4.83', appDir);

  if (installedVersion === '0.4.83') {
    sh('git checkout --quiet --force v0.4.83', appDir); // detached wie beim Update
  } else {
    sh('git checkout --quiet --force v0.4.82', appDir);
  }

  // Geräte-Stand vor dem Update (Legacy-Overwrite-Simulation):
  if (deviceSources) writeJson(path.join(appDir, 'tvsources.json'), deviceSources);

  if (stateVersion) writeJson(path.join(appDir, '.update-state.json'), { lastVersion: stateVersion });

  if (withBackup) {
    const bdir = path.join(appDir, '.update-backup');
    fs.mkdirSync(bdir);
    writeJson(path.join(bdir, 'tvsources.json'), deviceSources || vOldSources);
  }
  return appDir;
}

// Fixtures
// OLD_SOURCES = committeter Stand von v0.4.82 (= merge-base).
// DEVICE_82   = Geräte-Stand VOR dem Update: User hat per App-UI einen Favoriten
//               ergänzt, die Sortierung umgestellt und den ZDF-Override geändert.
// NEW_SOURCES = committeter Stand von v0.4.83 (Release-Fixes, neue Defaults).
const BASE_82 = [
  {
    id: 'src1',
    name: 'Quelle 1',
    favorites: ['ZDF.de@HD'],
    sortOrder: ['ZDF.de@HD', 'DasErste.de@HD'],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://zdf-82.example/master.m3u8' },
    },
  },
];

const DEVICE_82 = [
  {
    ...BASE_82[0],
    favorites: ['ZDF.de@HD', 'DasErste.de@HD'],
    sortOrder: ['DasErste.de@HD', 'ZDF.de@HD'],
    channelOverrides: {
      'ZDF.de@HD': { url: 'https://zdf-user.example/master.m3u8' },
    },
  },
];

const NEW_SOURCES = [
  {
    id: 'src1',
    name: 'Quelle 1',
    favorites: ['ZDF.de@HD'],
    sortOrder: ['ZDF.de@HD'],
    channelOverrides: {
      'MDRFernsehen.de@Thuringen': { url: 'https://mdr-neu.example/master.m3u8', tvgId: 'MDRThuringen.de' },
      'ZDF.de@HD': { url: 'https://zdf-83.example/master.m3u8' },
    },
  },
];

// ── Legacy-Update (0.4.82 → 0.4.83, alter Updater hat blind überschrieben) ──

test('Legacy-Update: State 0.4.82, kein Backup → Merge stellt Release-Fixes her, User-Daten bleiben', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: DEVICE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    stateVersion: '0.4.82',
  });

  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, true, r.reason);

  const now = JSON.parse(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'));
  // Release-Overrides wieder da (MDR-Fix + ZDF auf Tag-Stand, da User-Override
  // gegen 0.4.82-Base geändert war... Achtung: User-Override gewinnt bewusst!):
  assert.deepEqual(now[0].channelOverrides['MDRFernsehen.de@Thuringen'],
    { url: 'https://mdr-neu.example/master.m3u8', tvgId: 'MDRThuringen.de' });
  // User-Daten bewahrt:
  assert.deepEqual(now[0].favorites, DEVICE_82[0].favorites);
  assert.deepEqual(now[0].sortOrder, DEVICE_82[0].sortOrder);
  assert.deepEqual(now[0].channelOverrides['ZDF.de@HD'], { url: 'https://zdf-user.example/master.m3u8' });
  // State aktualisiert:
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, '.update-state.json'), 'utf-8')).lastVersion, '0.4.83');
});

test('Legacy-Update ohne User-Änderungen: Datei entspricht exakt dem neuen Tag', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: BASE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    stateVersion: '0.4.82',
  });
  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, true, r.reason);
  const now = JSON.parse(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'));
  assert.deepEqual(now, NEW_SOURCES);
});

test('Legacy-Update mit Backup (abgebrochener Apply): Backup-Old hat Vorrang, Backup wird aufgeräumt', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: DEVICE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    withBackup: true,
  });

  // Geräte-Datei = neuer committeter Stand (Apply brach NACH dem Checkout ab)
  writeJson(path.join(appDir, 'tvsources.json'), NEW_SOURCES);

  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, true, r.reason);

  const now = JSON.parse(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'));
  assert.deepEqual(now[0].channelOverrides['MDRFernsehen.de@Thuringen'].url, 'https://mdr-neu.example/master.m3u8');
  assert.deepEqual(now[0].favorites, DEVICE_82[0].favorites);
  assert.ok(!fs.existsSync(path.join(appDir, '.update-backup')), 'Backup soll aufgeräumt sein');
});

test('Zweiter Start nach erfolgreichem Merge: idempotent, nichts ändert sich', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: DEVICE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    stateVersion: '0.4.82',
  });

  reconcilePostUpdate(appDir, '0.4.83');
  const after1 = fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8');

  const r2 = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r2.merged, false);
  const after2 = fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8');
  assert.equal(after2, after1);
});

// ── Kein Update ─────────────────────────────────────────────────────────────

test('Normaler Start ohne Update: keine Änderung, State wird geschrieben', () => {
  const appDir = makeApp({ vOldSources: BASE_82, deviceSources: DEVICE_82, vNewSources: NEW_SOURCES, installedVersion: '0.4.83' });
  const before = fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8');

  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, false);
  assert.equal(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, '.update-state.json'), 'utf-8')).lastVersion, '0.4.83');
});

test('Erster Start überhaupt (kein State): noop ohne Fehler', () => {
  const appDir = makeApp({ vOldSources: BASE_82, deviceSources: DEVICE_82, vNewSources: NEW_SOURCES, installedVersion: '0.4.83' });
  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, false);
});

// ── Fehlerfälle: NIE Datenverlust, Retry beim nächsten Start ────────────────

test('Merge-Fehler (Nicht-Array): Geräte-Datei bleibt unverändert, State/Backup bleiben für Retry', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: DEVICE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    stateVersion: '0.4.82',
  });
  writeJson(path.join(appDir, 'tvsources.json'), 'kein-array');
  const before = fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8');

  const r = reconcilePostUpdate(appDir, '0.4.83');
  assert.equal(r.merged, false);
  assert.equal(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'), before);
  // State bleibt auf 0.4.82 → Retry beim nächsten Start:
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, '.update-state.json'), 'utf-8')).lastVersion, '0.4.82');
});

test('Backup vorhanden, aber unlesbar → Merge mit Datei-Stand läuft trotzdem (kein Crash)', () => {
  const appDir = makeApp({
    vOldSources: BASE_82,
    deviceSources: DEVICE_82,
    vNewSources: NEW_SOURCES,
    installedVersion: '0.4.83',
    stateVersion: '0.4.82',
    withBackup: true,
  });
  fs.writeFileSync(path.join(appDir, '.update-backup', 'tvsources.json'), 'KEIN JSON');
  writeJson(path.join(appDir, 'tvsources.json'), DEVICE_82);

  const r = reconcilePostUpdate(appDir, '0.4.83');
  // Backup-Kopie unlesbar → old = aktuelle Datei (User-Stand) → Merge läuft:
  assert.equal(r.merged, true, r.reason);
  const now = JSON.parse(fs.readFileSync(path.join(appDir, 'tvsources.json'), 'utf-8'));
  assert.deepEqual(now[0].channelOverrides['MDRFernsehen.de@Thuringen'].url, 'https://mdr-neu.example/master.m3u8');
  assert.deepEqual(now[0].favorites, DEVICE_82[0].favorites);
});
