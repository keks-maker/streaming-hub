#!/usr/bin/env node
// Erzeugt die Tray-Icons im A3-Stil (Glas/3D), Vorlagen:
//   docs/icon-vorschlaege/a-varianten/tray-idle-farbig.svg   -> assets/tray/tray-idle.png
//   docs/icon-vorschlaege/a-varianten/tray-rec-punkt-rot.svg -> assets/tray/tray-rec.png
//
// Reines Node (zlib, kein natives Dep): ein kleiner Scanline-Rasterizer mit
// 8x8-Supersampling rendert die SVG-Motive (Bezier-Pfad, Verlauf, Kontur,
// Kreise) auf 32x32 RGBA mit transparentem Hintergrund und schreibt ein
// minimales PNG. nativeImage kann SVG nicht dekodieren, deshalb
// kompilierte PNGs zur Build-Zeit. Farbig, kein Template-Icon.
//
// Aufruf: node scripts/generate-tray-icons.js  (Teil von npm run build:all)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const SS = 8; // Supersampling pro Achse

// Play-Form aus den SVG-Vorlagen: M12.5,7 Q9,5 9,9 L9,23 Q9,27 12.5,25 L24.5,18 Q28,16 24.5,14 Z
const PLAY = [
  ['M', 12.5, 7],
  ['Q', 9, 5, 9, 9],
  ['L', 9, 23],
  ['Q', 9, 27, 12.5, 25],
  ['L', 24.5, 18],
  ['Q', 28, 16, 24.5, 14],
];

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/** Flacht den Pfad zu einem Polygon (geschlossen) ab, optional um dy verschoben. */
function flatten(cmds, dy) {
  const pts = [];
  let cur = null;
  for (const c of cmds) {
    if (c[0] === 'M' || c[0] === 'L') {
      cur = [c[1], c[2] + dy];
      pts.push(cur);
    } else {
      const [x0, y0] = cur;
      const x1 = c[1], y1 = c[2] + dy, x2 = c[3], y2 = c[4] + dy;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16, u = 1 - t;
        pts.push([u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2]);
      }
      cur = [x2, y2];
    }
  }
  return pts;
}

function insidePoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Form-Konstruktoren: liefern coverage(x, y) -> bool im SVG-Koordinatenraum. */
function polyShape(poly) {
  return (x, y) => insidePoly(poly, x, y);
}
function strokeShape(poly, width) {
  const h = width / 2;
  return (x, y) => {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (distToSegment(x, y, poly[j], poly[i]) <= h) return true;
    }
    return false;
  };
}
function circleShape(cx, cy, r) {
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

/** Ebene: { shape, color: [r,g,b] | fn(x,y)->[r,g,b], alpha } */
function motif(mode) {
  const rec = mode === 'rec';
  const layers = [];
  const dark = hex(rec ? '#8a0f1f' : '#ff5fb0');
  const mid = hex(rec ? '#e5334a' : '#7b5cff');
  const top = rec ? [hex('#ff8a8a'), hex('#e5334a')] : [hex('#b9acff'), hex('#6a4df0')];
  // Tiefe: Extrusion von unten nach oben (translate 3.5 ... 0.7), wie in der Vorlage
  [[3.5, dark], [2.8, dark], [2.1, dark], [1.4, mid], [0.7, mid]].forEach(([dy, color]) =>
    layers.push({ shape: polyShape(flatten(PLAY, dy)), color, alpha: 1 })
  );
  const face = flatten(PLAY, 0);
  layers.push({
    shape: polyShape(face),
    // vertikaler Verlauf ueber die Bounding-Box (objectBoundingBox: y 5.6..26.4 grob 7..25.. exakt min/max der Flaeche)
    color: (x, y) => {
      const t = Math.max(0, Math.min(1, (y - 6.0) / (25.9 - 6.0)));
      return top[0].map((v, i) => Math.round(v + (top[1][i] - v) * t));
    },
    alpha: 1,
  });
  layers.push({ shape: strokeShape(face, 0.8), color: [255, 255, 255], alpha: 0.7 });
  if (rec) {
    layers.push({ shape: circleShape(25, 25, 7.5), color: [255, 255, 255], alpha: 0.95 });
    layers.push({ shape: circleShape(25, 25, 5.5), color: hex('#ff2d3f'), alpha: 1 });
    layers.push({ shape: circleShape(23.3, 23.2, 1.6), color: [255, 255, 255], alpha: 0.7 });
  }
  return layers;
}

/** Rendert 32x32 RGBA (nicht-prämultipliziert) mit Supersampling. */
function renderIcon(mode) {
  const layers = motif(mode);
  const px = new Uint8Array(SIZE * SIZE * 4);
  const n = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0; // prämultipliziert, aufsummiert
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let r = 0, g = 0, b = 0, a = 0;
          for (const l of layers) {
            if (!l.shape(fx, fy)) continue;
            const c = typeof l.color === 'function' ? l.color(fx, fy) : l.color;
            const la = l.alpha;
            const oa = la + a * (1 - la);
            r = (c[0] * la + r * a * (1 - la)) / oa;
            g = (c[1] * la + g * a * (1 - la)) / oa;
            b = (c[2] * la + b * a * (1 - la)) / oa;
            a = oa;
          }
          ar += r * a; ag += g * a; ab += b * a; aa += a;
        }
      }
      const idx = (y * SIZE + x) * 4;
      if (aa > 0) {
        px[idx] = Math.round(ar / aa);
        px[idx + 1] = Math.round(ag / aa);
        px[idx + 2] = Math.round(ab / aa);
      }
      px[idx + 3] = Math.round((aa / n) * 255);
    }
  }
  return px;
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
