// Bildmaße aus dem Dateikopf lesen, bevor dekodiert wird (Schutz vor Dekompressionsbomben): JPEG (SOF), PNG (IHDR),
// WebP (VP8, VP8L, VP8X). Unbekanntes oder unlesbares Format → null.

'use strict';

const MAX_EDGE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function pngSize(b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(sig) || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
  return null;
}

/** { width, height } oder null (unbekanntes/unlesbares Format). */
function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  try {
    const size = jpegSize(buffer) || pngSize(buffer) || webpSize(buffer);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch (_) {
    return null;
  }
}

/** Wirft, wenn das Bild unlesbar, zu breit/hoch (> 4096 px Kante) oder zu groß (> 16 MP) ist. */
function assertSafeImageSize(buffer) {
  const size = readImageSize(buffer);
  if (!size) throw new Error('Bildformat unbekannt');
  if (size.width > MAX_EDGE || size.height > MAX_EDGE || size.width * size.height > MAX_PIXELS) throw new Error('Bild ist zu groß (Pixel)');
  return size;
}

module.exports = { readImageSize, assertSafeImageSize, MAX_EDGE, MAX_PIXELS };
