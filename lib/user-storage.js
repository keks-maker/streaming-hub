'use strict';

const fs = require('fs');
const path = require('path');

const STORAGE_FILES = {
  services: 'services.json',
  history: 'history.json',
  tvSources: 'tvsources.json',
};

function createUserStorage({ userDataPath, bundlePath }) {
  if (!userDataPath || !bundlePath) throw new Error('Storage-Pfade fehlen');

  function ensureDirectory() {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  function userPath(kind) {
    const filename = STORAGE_FILES[kind];
    if (!filename) throw new Error(`Unbekannter Storage-Typ: ${kind}`);
    return path.join(userDataPath, filename);
  }

  function bundleFile(kind) {
    const filename = STORAGE_FILES[kind];
    if (!filename) throw new Error(`Unbekannter Storage-Typ: ${kind}`);
    return path.join(bundlePath, filename);
  }

  function readJson(kind, fallback) {
    ensureDirectory();
    const target = userPath(kind);
    if (!fs.existsSync(target)) {
      const bundled = bundleFile(kind);
      if (fs.existsSync(bundled)) {
        try {
          return JSON.parse(fs.readFileSync(bundled, 'utf8'));
        } catch (error) {
          throw new Error(`${kind} aus Paket konnte nicht gelesen werden: ${error.message}`);
        }
      }
      return fallback;
    }
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`${kind} konnte nicht gelesen werden: ${error.message}`);
    }
  }

  function writeJson(kind, value) {
    ensureDirectory();
    const target = userPath(kind);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* preserve write error */ }
      throw new Error(`${kind} konnte nicht gespeichert werden: ${error.message}`);
    }
  }

  function writeJsonBatch(values) {
    const entries = Object.entries(values);
    if (!entries.length) return;
    entries.forEach(([kind]) => userPath(kind));
    ensureDirectory();
    const staged = [];
    const backups = [];
    try {
      for (const [kind, value] of entries) {
        const target = userPath(kind);
        const temporary = `${target}.${process.pid}.${Date.now()}.${staged.length}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
        staged.push({ target, temporary });
      }
      for (const item of staged) {
        if (fs.existsSync(item.target)) {
          const backup = `${item.target}.${process.pid}.${Date.now()}.${backups.length}.bak`;
          fs.renameSync(item.target, backup);
          backups.push({ target: item.target, backup });
        }
        fs.renameSync(item.temporary, item.target);
      }
      backups.forEach(({ backup }) => fs.rmSync(backup, { force: true }));
    } catch (error) {
      for (const item of staged) {
        try { fs.rmSync(item.temporary, { force: true }); } catch (_) {}
        try { fs.rmSync(item.target, { force: true }); } catch (_) {}
      }
      for (const { target, backup } of backups) {
        try { fs.renameSync(backup, target); } catch (_) {}
      }
      throw new Error(`Backup konnte nicht gespeichert werden: ${error.message}`);
    }
  }

  function exportData() {
    return {
      services: readJson('services', []),
      tvsources: readJson('tvSources', []),
      history: readJson('history', []),
    };
  }

  return {
    paths: {
      services: userPath('services'),
      history: userPath('history'),
      tvSources: userPath('tvSources'),
    },
    readJson,
    writeJson,
    writeJsonBatch,
    exportData,
  };
}

module.exports = { createUserStorage, STORAGE_FILES };
