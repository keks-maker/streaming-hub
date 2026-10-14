'use strict';

// Logo-Cache für Menü-Icons (Tray-Menü, Favoriten): lädt die Senderlogos im Hintergrund, prüft sie wie die Logo-Suche
// (nur https, Content-Type image/*, Dateikopf, Größenlimit), skaliert auf 16 px (@2x 32 px) und legt sie in
// <dir>/<sha256(url)>.png und <hash>@2x.png ab (Alterslimit, Dateianzahl begrenzt). Netzwerk (net.get), nativeImage und
// Dateisystem sind injizierbar. Fehler führen nur dazu, dass der Eintrag kein Icon bekommt.

const crypto = require('node:crypto');
const nodeFs = require('node:fs/promises');
const nodePath = require('node:path');
const { imageInfo, toHttps } = require('./radio-logo-finder.js');

const ICON_SIZE = 16;
const MAX_BYTES = 512 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FILES = 200;
const CONCURRENCY = 3;
const UNSUPPORTED_TYPES = new Set(['svg', 'ico']); // nativeImage dekodiert beides nicht zuverlässig

function fileBase(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/**
 * options:
 * - dir: Cache-Verzeichnis (userData/radio-logo-cache)
 * - net: { get(url, { maxBytes }) } wie in radio-logo-finder.js (createNet)
 * - nativeImage: Electron-nativeImage (createFromBuffer)
 * - fs: Dateisystem (fs/promises-kompatibel: mkdir, readFile, writeFile, readdir, stat, unlink)
 * - onChange(): einmal je Ladewelle, wenn neue Icons verfügbar wurden
 * - now, maxAgeMs, maxFiles, logger
 */
function createRadioLogoCache({ dir, net, nativeImage, fs = nodeFs, onChange = () => {}, now = () => Date.now(), maxAgeMs = MAX_AGE_MS, maxFiles = MAX_FILES, logger = null } = {}) {
  const images = new Map(); // https-URL -> nativeImage
  const failed = new Set(); // in dieser Sitzung nicht ladbar: nicht erneut versuchen
  const pending = new Set();
  let running = null;
  let gained = false;
  const path = nodePath;

  function build(buf1, buf2) {
    const image = nativeImage.createFromBuffer(buf1, { scaleFactor: 1 });
    if (!image || image.isEmpty()) return null;
    if (buf2 && typeof image.addRepresentation === 'function') image.addRepresentation({ scaleFactor: 2, buffer: buf2 });
    return image;
  }

  function scaled(source, edge) {
    const { width, height } = source.getSize();
    if (!width || !height) return null;
    const factor = edge / Math.max(width, height);
    const out = source.resize({ width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), quality: 'best' });
    return out.isEmpty() ? null : out.toPNG();
  }

  async function fromDisk(base) {
    const file1 = path.join(dir, `${base}.png`);
    const file2 = path.join(dir, `${base}@2x.png`);
    try {
      const stat = await fs.stat(file1);
      if (now() - stat.mtimeMs > maxAgeMs) return null;
      const buf1 = await fs.readFile(file1);
      let buf2 = null;
      try {
        buf2 = await fs.readFile(file2);
      } catch {
        // ohne @2x weiter
      }
      return build(buf1, buf2);
    } catch {
      return null;
    }
  }

  async function download(url, base) {
    const reply = await net.get(url, { maxBytes: MAX_BYTES });
    if (reply.status !== 200 || reply.truncated) return null;
    if (!/^image\//i.test(String(reply.contentType || ''))) return null;
    if (reply.finalUrl && !/^https:/i.test(reply.finalUrl)) return null;
    const info = imageInfo(reply.buffer);
    if (!info || UNSUPPORTED_TYPES.has(info.type)) return null;
    const source = nativeImage.createFromBuffer(reply.buffer);
    if (!source || source.isEmpty()) return null;
    const buf1 = scaled(source, ICON_SIZE);
    const buf2 = scaled(source, ICON_SIZE * 2);
    if (!buf1) return null;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${base}.png`), buf1);
      if (buf2) await fs.writeFile(path.join(dir, `${base}@2x.png`), buf2);
    } catch (error) {
      if (logger) logger.warn('[radio-logo-cache] Schreiben fehlgeschlagen:', error.message);
    }
    return build(buf1, buf2);
  }

  async function load(url) {
    const base = fileBase(url);
    try {
      const image = (await fromDisk(base)) || (await download(url, base));
      if (image) {
        images.set(url, image);
        gained = true;
        return;
      }
    } catch (error) {
      if (logger) logger.warn('[radio-logo-cache] Logo nicht ladbar:', error.message);
    }
    failed.add(url);
  }

  async function drain() {
    const worker = async () => {
      while (pending.size) {
        const [url] = pending;
        pending.delete(url);
        await load(url);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await prune().catch(() => {});
    if (gained) {
      gained = false;
      try {
        onChange();
      } catch (error) {
        if (logger) logger.warn('[radio-logo-cache] onChange fehlgeschlagen:', error.message);
      }
    }
  }

  /** Alte Dateien (Alterslimit) und Überhang (> maxFiles, älteste zuerst) löschen. Ein Bild = .png + @2x.png (zählt als eine Datei). */
  async function prune() {
    let names;
    try {
      names = (await fs.readdir(dir)).filter(name => /^[0-9a-f]{32}(@2x)?\.png$/.test(name));
    } catch {
      return;
    }
    const entries = [];
    for (const name of names) {
      try {
        entries.push({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs });
      } catch {
        // schon weg
      }
    }
    const byBase = new Map();
    for (const entry of entries) {
      const base = entry.name.replace(/(@2x)?\.png$/, '');
      const group = byBase.get(base) || { base, names: [], mtimeMs: 0 };
      group.names.push(entry.name);
      group.mtimeMs = Math.max(group.mtimeMs, entry.mtimeMs);
      byBase.set(base, group);
    }
    const groups = [...byBase.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const doomed = groups.filter((group, index) => index >= maxFiles || now() - group.mtimeMs > maxAgeMs);
    for (const group of doomed) {
      for (const name of group.names) await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  }

  const api = {
    /** Fertiges Icon (nativeImage) oder null. */
    peek: url => images.get(url) || null,
    /** Logos im Hintergrund laden (nur https; bereits bekannte/gescheiterte werden übersprungen). */
    request(urls) {
      for (const raw of urls || []) {
        if (typeof raw !== 'string' || !/^https:\/\//i.test(raw) || !toHttps(raw) || images.has(raw) || failed.has(raw)) continue;
        pending.add(raw);
      }
      if (!pending.size || running) return running || Promise.resolve();
      running = drain().finally(() => {
        running = null;
        if (pending.size) api.request([]); // während des Laufs hinzugekommen
      });
      return running;
    },
    prune,
    idle: () => running || Promise.resolve(),
  };
  return api;
}

module.exports = { createRadioLogoCache, ICON_SIZE, MAX_BYTES, MAX_AGE_MS, MAX_FILES, fileBase };
