#!/usr/bin/env node
// Erzeugt die Tray-Icons aus dem App-Brand (Phase 1c, Karte t_bafa7928):
//   assets/tray/tray-idle.png — violetter Brand-Gradient + weißes Play-Dreieck
//   assets/tray/tray-rec.png  — roter Gradient + weißer REC-Punkt
//
// Reines Node (zlib, kein natives Dep): rendert 32×32 RGBA pro Pixel und
// schreibt ein minimales PNG (IHDR/IDAT/IEND, Filter 0). Nachbau von
// assets/icon.svg (#6c5ce7 → #a78bfa, weißes Dreieck) — nativeImage kann
// SVG nicht dekodieren, deshalb kompilierte PNGs zur Build-Zeit.
//
// Aufruf: node scripts/generate-tray-icons.js  (Teil von npm run build:all)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradientColor(t, from, to) {
  return [
    Math.round(lerp(from[0], to[0], t)),
    Math.round(lerp(from[1], to[1], t)),
    Math.round(lerp(from[2], to[2], t)),
  ];
}

/**
 * Rendert das Tray-Icon:
 * - rounded-rect Brand-Fläche (Gradient oben-links → unten-rechts wie icon.svg)
 * - mode 'idle': weißes Play-Dreieck (28,8 → 28,68 → 68,28 skaliert auf 32)
 * - mode 'rec':  weißer REC-Punkt (Kreis, Mitte, r≈5px)
 */
function renderIcon(mode) {
  const brand = {
    from: [0x6c, 0x5c, 0xe7],
    to: [0xa7, 0x8b, 0xfa],
  };
  const rec = {
    from: [0xdc, 0x26, 0x26],
    to: [0xef, 0x44, 0x44],
  };
  const colors = mode === 'rec' ? rec : brand;
  const px = new Uint8Array(SIZE * SIZE * 4);
  const radius = 7; // ~24/96 wie icon.svg
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (y * SIZE + x) * 4;
      // Rounded-rect-Mask mit 0.5px-Falloff (weiche Kante)
      const dx = Math.max(radius - x, x - (SIZE - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (SIZE - 1 - radius), 0);
      const dist = Math.sqrt(dx * dx + dy * dy);
      let inside = dist <= radius - 0.5 ? 1 : dist >= radius + 0.5 ? 0 : radius + 0.5 - dist;
      if (inside <= 0) continue; // transparent
      const t = (x + y) / (2 * (SIZE - 1));
      const [r, g, b] = gradientColor(t, colors.from, colors.to);
      // Vordergrund-Form
      let fg = false;
      if (mode === 'idle') {
        // Play-Dreieck: (9,7) (25,16) (9,25) — Punkt-in-Dreieck via Flanken
        fg = pointInTriangle(x + 0.5, y + 0.5, 9, 7, 25, 16, 9, 25);
      } else {
        // REC-Punkt: Kreis Mitte r=5.5
        const cx = x + 0.5 - SIZE / 2;
        const cy = y + 0.5 - SIZE / 2;
        fg = cx * cx + cy * cy <= 5.5 * 5.5;
      }
      const [fr, fgc, fb] = fg ? [255, 255, 255] : [r, g, b];
      px[idx] = fr;
      px[idx + 1] = fgc;
      px[idx + 2] = fb;
      px[idx + 3] = Math.round(inside * 255);
    }
  }
  return px;
}

function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
  const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ── Minimaler PNG-Encoder (RGBA8, Filter 0, keine Interlace) ──

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Rohdaten mit Filter-Byte 0 je Scanline
  const raw = Buffer.alloc(height * (1 + width * 4));
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    src.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Main ──

const outDir = path.join(__dirname, '..', 'assets', 'tray');
fs.mkdirSync(outDir, { recursive: true });
for (const mode of ['idle', 'rec']) {
  const rgba = renderIcon(mode);
  const png = encodePng(rgba, SIZE, SIZE);
  const file = path.join(outDir, mode === 'rec' ? 'tray-rec.png' : 'tray-idle.png');
  fs.writeFileSync(file, png);
  console.log(`✓ ${file} (${png.length} bytes)`);
}
