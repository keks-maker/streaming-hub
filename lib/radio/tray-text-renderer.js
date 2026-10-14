'use strict';

// Rendert den Lauftext einmal pro Titel als Bild: im vorhandenen unsichtbaren Radio-Player-Fenster (Chromium-Canvas,
// Systemschrift wie die Menüleiste), ohne zusätzliches Fenster und ohne Änderung an Sandbox/Preload. Der Aufruf geht
// per webContents.executeJavaScript mit einem festen Skript; der Text wird als JSON-Literal eingesetzt, nie als Code.
// Rückgabe: Bitmap in Gerätepixeln (Faktor 2) im Format des Betriebssystems, bereit für tray-frame.js.

const RENDER_TIMEOUT_MS = 3000;
const MAX_TEXT_PX = 16000; // Canvas-Grenze mit Sicherheitsabstand

function renderScript(text, { dark, scale, heightPt }) {
  // fillStyle: Menüleistentext ist im Hellmodus fast schwarz, im Dunkelmodus weiß
  return `(() => {
    const text = ${JSON.stringify(String(text))};
    const scale = ${Number(scale)};
    const heightPt = ${Number(heightPt)};
    const font = '13px -apple-system, system-ui, sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const widthPt = Math.ceil(probe.measureText(text).width) + 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(${MAX_TEXT_PX}, widthPt * scale);
    canvas.height = heightPt * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ${JSON.stringify(dark ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.88)')};
    ctx.fillText(text, 0, Math.round(heightPt / 2 + 4.5));
    return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  })()`;
}

/**
 * getWebContents: () => webContents des Player-Fensters | null. nativeImage: Electron-nativeImage.
 * Rückgabe: render(text, { dark }) → Promise<{ buffer, width, height } | null> (null: Player nicht erreichbar/Fehler).
 */
function createTrayTextRenderer({ getWebContents, nativeImage, scale = 2, heightPt = 32, timeoutMs = RENDER_TIMEOUT_MS }) {
  return async function render(text, { dark = false } = {}) {
    const wc = getWebContents();
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Rendern')), timeoutMs);
    });
    try {
      const result = await Promise.race([wc.executeJavaScript(renderScript(text, { dark, scale, heightPt })), timeout]);
      if (!result || typeof result.url !== 'string' || !result.url.startsWith('data:image/png;base64,')) return null;
      const image = nativeImage.createFromDataURL(result.url);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      return { buffer: image.toBitmap(), width: size.width, height: size.height };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createTrayTextRenderer, renderScript };
