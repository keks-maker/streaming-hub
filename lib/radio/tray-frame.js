'use strict';

// Bildaufbau für den pixelweisen Lauftext neben dem Tray-Symbol: reine Bitmap-Rechnung ohne Electron.
// Alle Bitmaps sind 4 Byte pro Pixel (in Electron auf macOS BGRA mit vormultipliziertem Alpha); da nur kopiert und
// mit einem Faktor skaliert wird, ist die Kanalreihenfolge egal, solange Symbol und Text im selben Format vorliegen.
//
// Aufbau eines Frames (Gerätepixel): [Symbol][Abstand][Textfenster]. Das Textfenster zeigt einen Ausschnitt des
// vollständigen Textbildes ab `offsetPx`; dort, wo Text abgeschnitten wird, läuft er über `fadePx` weich aus.

const BYTES = 4;

/** Frame-Maße (Gerätepixel) aus Symbolbreite, Abstand und Fensterbreite. */
function frameSize({ iconWidth, gapPx, windowPx, height }) {
  return { width: iconWidth + gapPx + windowPx, height };
}

function scaleRun(buffer, rowStart, fromX, toX, factorAt) {
  for (let x = fromX; x < toX; x += 1) {
    const factor = factorAt(x);
    const i = rowStart + x * BYTES;
    for (let c = 0; c < BYTES; c += 1) buffer[i + c] = Math.round(buffer[i + c] * factor);
  }
}

/**
 * Setzt einen Frame zusammen.
 * icon/text: { buffer, width, height } (Gerätepixel). Rückgabe: Buffer (width*height*4), Maße über frameSize().
 */
function composeFrame({ icon, text, offsetPx, windowPx, gapPx, height, fadePx }) {
  const { width } = frameSize({ iconWidth: icon.width, gapPx, windowPx, height });
  const out = Buffer.alloc(width * height * BYTES);
  const iconTop = Math.max(0, Math.floor((height - icon.height) / 2));
  const iconRows = Math.min(icon.height, height);
  for (let y = 0; y < iconRows; y += 1) {
    icon.buffer.copy(out, ((iconTop + y) * width) * BYTES, y * icon.width * BYTES, (y + 1) * icon.width * BYTES);
  }
  const offset = Math.max(0, Math.min(Math.floor(offsetPx) || 0, Math.max(0, text.width - windowPx)));
  const visible = Math.max(0, Math.min(windowPx, text.width - offset));
  const hiddenRight = Math.max(0, text.width - offset - windowPx);
  const fadeLeft = Math.min(Math.max(0, Math.floor(fadePx) || 0), offset);
  const fadeRight = Math.min(Math.max(0, Math.floor(fadePx) || 0), hiddenRight);
  const textLeft = icon.width + gapPx;
  const rows = Math.min(text.height, height);
  const textTop = Math.max(0, Math.floor((height - text.height) / 2));
  for (let y = 0; y < rows; y += 1) {
    const dst = ((textTop + y) * width + textLeft) * BYTES;
    text.buffer.copy(out, dst, (y * text.width + offset) * BYTES, (y * text.width + offset + visible) * BYTES);
    const rowStart = dst;
    if (fadeLeft > 0) scaleRun(out, rowStart, 0, Math.min(fadeLeft, visible), x => (x + 1) / (fadeLeft + 1));
    if (fadeRight > 0) scaleRun(out, rowStart, Math.max(0, visible - fadeRight), visible, x => (visible - x) / (fadeRight + 1));
  }
  return out;
}

/**
 * Setzt ein quadratisches Bild (Kantenlänge image.width) mittig in ein size x size großes, transparentes Bild.
 * Dient dazu, das Template-Symbol mit demselben Rand wie die farbigen Symbole in den Frame zu legen.
 */
function centerInSquare(image, size) {
  const out = Buffer.alloc(size * size * BYTES);
  const left = Math.max(0, Math.floor((size - image.width) / 2));
  const top = Math.max(0, Math.floor((size - image.height) / 2));
  const rows = Math.min(image.height, size);
  const cols = Math.min(image.width, size);
  for (let y = 0; y < rows; y += 1) {
    image.buffer.copy(out, ((top + y) * size + left) * BYTES, y * image.width * BYTES, (y * image.width + cols) * BYTES);
  }
  return { buffer: out, width: size, height: size };
}

module.exports = { composeFrame, frameSize, centerInSquare, BYTES };
