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
          const value = JSON.parse(fs.readFileSync(bundled, 'utf8'));
          return value;
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
    const content = JSON.stringify(value, null, 2) + '\n';
    try {
      fs.writeFileSync(temporary, content, 'utf8');
      fs.renameSync(temporary, target);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (_) {
        // Preserve the original write error.
      }
      throw new Error(`${kind} konnte nicht gespeichert werden: ${error.message}`);
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
    exportData,
  };
}

module.exports = { createUserStorage, STORAGE_FILES };
