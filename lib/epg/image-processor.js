// Bildverarbeitung für den EPG-Bild-Cache (nur Electron-Main): verkleinert auf doppelte Kachelbreite, JPEG.

'use strict';

const TARGET_WIDTH = 560; // doppelte Kachelbreite (Kachel 190-280 px)
const JPEG_QUALITY = 80;

function createImageProcessor(nativeImage) {
  return function processImage(buffer) {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('Bild nicht lesbar');
    const { width } = image.getSize();
    const scaled = width > TARGET_WIDTH ? image.resize({ width: TARGET_WIDTH, quality: 'good' }) : image;
    return scaled.toJPEG(JPEG_QUALITY);
  };
}

module.exports = { createImageProcessor, TARGET_WIDTH };
