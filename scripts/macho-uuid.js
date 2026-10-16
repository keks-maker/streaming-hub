// Eindeutige LC_UUID fuer die Electron-Executables des Mac-Pakets.
// Hintergrund: macOS merkt sich die Freigabe "Lokales Netzwerk" anhand der Mach-O-UUID. Die Executables
// des Electron-Pakets tragen die UUID des (bei der Entwicklung genutzten) Electron aus node_modules; die
// gepackte App wird dadurch dem dortigen Eintrag "Electron" zugeordnet, bekommt keine eigene Abfrage und
// Verbindungen ins Heimnetz werden still blockiert (EHOSTUNREACH). Mit eigener UUID erscheint die Abfrage.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;

// Ableitung aus Seed (stabil ueber Updates, damit die Freigabe erhalten bleibt).
function deriveUuid(seed) {
  return crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
}

// Setzt LC_UUID einer thin 64-Bit-Mach-O-Datei (little endian, arm64/x64). Gibt true zurueck, wenn geaendert.
function setMachoUuid(file, uuid) {
  const buf = fs.readFileSync(file);
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error(`Keine thin 64-Bit-Mach-O-Datei: ${file}`);
  }
  const ncmds = buf.readUInt32LE(16);
  let off = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) {
      if (buf.subarray(off + 8, off + 24).equals(uuid)) return false;
      uuid.copy(buf, off + 8);
      fs.writeFileSync(file, buf);
      return true;
    }
    if (size < 8) break;
    off += size;
  }
  throw new Error(`LC_UUID fehlt: ${file}`);
}

// Hauptprogramm und alle Helper-Executables eines .app-Pakets.
function listAppExecutables(appPath, productName) {
  const files = [path.join(appPath, 'Contents', 'MacOS', productName)];
  const fw = path.join(appPath, 'Contents', 'Frameworks');
  for (const entry of fs.readdirSync(fw)) {
    if (!entry.endsWith('.app')) continue;
    const name = entry.slice(0, -'.app'.length);
    files.push(path.join(fw, entry, 'Contents', 'MacOS', name));
  }
  return files;
}

function applyUniqueUuids(appPath, productName, appId) {
  const changed = [];
  for (const file of listAppExecutables(appPath, productName)) {
    if (setMachoUuid(file, deriveUuid(`${appId}:${path.basename(file)}`))) changed.push(file);
  }
  return changed;
}

module.exports = { deriveUuid, setMachoUuid, listAppExecutables, applyUniqueUuids };
