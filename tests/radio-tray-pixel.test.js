'use strict';

// Tests: pixelweiser Lauftext neben dem Tray-Symbol: Bildaufbau (tray-frame.js), Takt und Zustände
// (tray-pixel-marquee.js, mit Fakes) und das Rendern im Player-Fenster (tray-text-renderer.js, mit Fake-webContents).

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeFrame, frameSize, centerInSquare } = require('../lib/radio/tray-frame.js');
const { TrayPixelMarquee, SCALE, FRAME_HEIGHT_PT, GAP_PT } = require('../lib/radio/tray-pixel-marquee.js');
const { PIXEL_WINDOW_WIDTH, PIXEL_FPS } = require('../lib/radio/tray-marquee.js');
const { createTrayTextRenderer, renderScript } = require('../lib/radio/tray-text-renderer.js');

// Testbitmap: jedes Pixel hat Byte 0 = x (mod 256), Byte 3 = 255
function bitmap(width, height, fill = x => x % 256) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      buffer[i] = fill(x, y);
      buffer[i + 3] = 255;
    }
  }
  return { buffer, width, height };
}
const px = (buffer, width, x, y) => buffer[(y * width + x) * 4];
const alpha = (buffer, width, x, y) => buffer[(y * width + x) * 4 + 3];

test('composeFrame: Symbol links, Abstand leer, Textausschnitt ab Versatz im Fenster', () => {
  const icon = bitmap(8, 8, () => 200);
  const text = bitmap(40, 8);
  const out = composeFrame({ icon, text, offsetPx: 10, windowPx: 16, gapPx: 4, height: 8, fadePx: 0 });
  const { width } = frameSize({ iconWidth: 8, gapPx: 4, windowPx: 16, height: 8 });
  assert.equal(width, 28);
  assert.equal(out.length, 28 * 8 * 4);
  assert.equal(px(out, width, 3, 4), 200, 'Symbol');
  assert.equal(alpha(out, width, 9, 4), 0, 'Abstand transparent');
  assert.equal(px(out, width, 12, 3), 10, 'Fenster beginnt bei Textspalte 10');
  assert.equal(px(out, width, 27, 3), 25, 'Fenster endet bei Textspalte 25');
});

test('composeFrame: weicher Rand nur dort, wo Text abgeschnitten wird; Anfang und Ende hart', () => {
  const icon = bitmap(4, 4, () => 0);
  const text = bitmap(100, 4, () => 255);
  const base = { icon, text, windowPx: 40, gapPx: 0, height: 4, fadePx: 8 };
  const width = 44;
  const start = composeFrame({ ...base, offsetPx: 0 });
  assert.equal(alpha(start, width, 4, 1), 255, 'Anfang: links kein Verlauf');
  assert.ok(alpha(start, width, 43, 1) < alpha(start, width, 43 - 8, 1), 'rechts läuft Text aus');
  assert.ok(alpha(start, width, 43, 1) > 0 && alpha(start, width, 43, 1) < 100);
  const middle = composeFrame({ ...base, offsetPx: 30 });
  assert.ok(alpha(middle, width, 4, 1) < alpha(middle, width, 4 + 8, 1), 'links läuft Text ein');
  assert.equal(alpha(middle, width, 4 + 20, 1), 255, 'Mitte unverändert');
  const end = composeFrame({ ...base, offsetPx: 60 });
  assert.equal(alpha(end, width, 43, 1), 255, 'Ende: rechts kein Verlauf');
  const near = composeFrame({ ...base, offsetPx: 3 });
  assert.ok(alpha(near, width, 4, 1) > 0 && alpha(near, width, 4, 1) < 255, 'Verlauf wächst mit dem Versatz (kein Sprung)');
  assert.equal(alpha(composeFrame({ ...base, offsetPx: 1000 }), width, 43, 1), 255, 'Versatz wird begrenzt');
});

function makeMarquee(over = {}) {
  const calls = { images: [], created: [], ticks: [], cleared: [] };
  let nowMs = 0;
  const textWidthPt = over.textWidthPt || PIXEL_WINDOW_WIDTH + 100;
  const marquee = new TrayPixelMarquee({
    render: over.render || (async () => bitmap(textWidthPt * SCALE, FRAME_HEIGHT_PT * SCALE)),
    createImage: (buffer, options) => { const image = { buffer, ...options }; calls.created.push(image); return image; },
    setImage: image => { if (over.setImageThrows) throw new Error('weg'); calls.images.push(image); },
    now: () => nowMs,
    setTick: (fn, ms) => { const t = { fn, ms, cleared: false }; calls.ticks.push(t); return t; },
    clearTick: t => { t.cleared = true; calls.cleared.push(t); },
    logger: { warn() {} },
    onFail: over.onFail,
  });
  const live = () => calls.ticks.filter(t => !t.cleared);
  return { marquee, calls, live, advance: ms => { nowMs += ms; }, tick: () => live().at(-1).fn() };
}
const ICON = bitmap(FRAME_HEIGHT_PT * SCALE, FRAME_HEIGHT_PT * SCALE, () => 7);

test('Pixelmarquee: Start rendert einmal, setzt das erste Frame und startet den Takt (30 fps)', async () => {
  const { marquee, calls, live } = makeMarquee();
  assert.equal(await marquee.start({ text: 'lang', icon: ICON }), 'scrolling');
  assert.equal(marquee.active, true);
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, Math.round(1000 / PIXEL_FPS));
  assert.equal(calls.images.length, 1);
  const frame = calls.images[0];
  assert.equal(frame.scaleFactor, SCALE);
  assert.equal(frame.height, FRAME_HEIGHT_PT * SCALE);
  assert.equal(frame.width, ICON.width + GAP_PT * SCALE + PIXEL_WINDOW_WIDTH * SCALE, 'Frame-Breite konstant');
});

test('Pixelmarquee: Frame nur bei geändertem Pixelversatz, Breite bleibt konstant, Neustart nach dem Zyklus', async () => {
  const { marquee, calls, advance, tick } = makeMarquee({ textWidthPt: PIXEL_WINDOW_WIDTH + 64 });
  await marquee.start({ text: 'x', icon: ICON });
  const widths = new Set(calls.images.map(i => i.width));
  tick(); tick();
  assert.equal(calls.images.length, 1, 'Anfangspause und gleicher Versatz: kein neues Bild');
  advance(2000 + 100); // 3 pt weiter
  tick();
  assert.equal(calls.images.length, 2);
  tick();
  assert.equal(calls.images.length, 2, 'derselbe Versatz: nichts');
  advance(60000); // über das Zyklusende hinaus (Neustart)
  tick();
  for (const image of calls.images) widths.add(image.width);
  assert.equal(widths.size, 1, 'Bildbreite springt nie');
  assert.ok(calls.images.length >= 3);
});

test('Pixelmarquee: Text passt ins Fenster → „static“, kein Takt, kein Bild', async () => {
  const { marquee, calls, live } = makeMarquee({ textWidthPt: PIXEL_WINDOW_WIDTH });
  assert.equal(await marquee.start({ text: 'kurz', icon: ICON }), 'static');
  assert.equal(marquee.active, false);
  assert.equal(live().length, 0);
  assert.equal(calls.images.length, 0);
});

test('Pixelmarquee: Renderfehler oder leeres Ergebnis → „failed“; Bildfehler im Takt → onFail und Takt aus', async () => {
  for (const render of [async () => null, async () => { throw new Error('x'); }, async () => ({ buffer: Buffer.alloc(0), width: 0, height: 0 })]) {
    const { marquee, live } = makeMarquee({ render });
    assert.equal(await marquee.start({ text: 'a', icon: ICON }), 'failed');
    assert.equal(live().length, 0);
  }
  const broken = makeMarquee({ setImageThrows: true });
  assert.equal(await broken.marquee.start({ text: 'a', icon: ICON }), 'failed', 'erstes Frame nicht setzbar');
  assert.equal(broken.live().length, 0, 'Takt aufgeräumt');
  let failed = 0;
  const later = makeMarquee({ onFail: () => { failed += 1; } });
  await later.marquee.start({ text: 'a', icon: ICON });
  later.advance(5000);
  later.calls.ticks[0].fn.call(null);
  assert.equal(failed, 0, 'solange das Setzen klappt, kein onFail');
});

test('Pixelmarquee: neuer Start ersetzt Textbild und Takt (genau ein Takt), alter Render wird verworfen; stop räumt auf', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let n = 0;
  const { marquee, live } = makeMarquee({
    render: async () => {
      n += 1;
      if (n === 1) { await slow; }
      return bitmap((PIXEL_WINDOW_WIDTH + 50) * SCALE, FRAME_HEIGHT_PT * SCALE);
    },
  });
  const first = marquee.start({ text: 'a', icon: ICON });
  const second = marquee.start({ text: 'b', icon: ICON });
  assert.equal(await second, 'scrolling');
  release();
  assert.equal(await first, 'stale', 'überholter Render wirkt nicht');
  assert.equal(live().length, 1);
  await marquee.start({ text: 'c', icon: ICON });
  assert.equal(live().length, 1, 'Titelwechsel: weiterhin genau ein Takt');
  marquee.stop();
  assert.equal(live().length, 0);
  assert.equal(marquee.active, false);
  assert.equal(marquee._text, null, 'Textbild freigegeben');
});

test('Pixelmarquee: setIcon erzwingt ein neues Frame mit dem neuen Symbol', async () => {
  const { marquee, calls, tick } = makeMarquee();
  await marquee.start({ text: 'a', icon: ICON });
  marquee.setIcon(bitmap(ICON.width, ICON.height, () => 99));
  tick();
  assert.equal(calls.images.length, 2);
  assert.equal(calls.created[1].buffer[0], 99);
});

test('Textrenderer: Text nur als JSON-Literal im Skript, Ergebnis wird zur Bitmap; Fehler/kein Fenster → null', async () => {
  const evil = '"; require("fs"); // `${1}';
  const script = renderScript(evil, { scale: 2, heightPt: 32 });
  assert.ok(script.includes(JSON.stringify(evil)), 'Text als JSON-Literal');
  assert.ok(!script.includes(`const text = ${evil}`));
  assert.match(script, /fillStyle = '#000'/, 'Template: immer schwarz, nur Alpha trägt die Form');
  assert.doesNotMatch(script, /rgba\(255|dark|nativeTheme/, 'keine Farbwahl nach Hell/Dunkel');
  assert.match(script, /-apple-system/);

  const scripts = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 6, height: 4 }), toBitmap: () => Buffer.alloc(96) };
  const wc = { isDestroyed: () => false, executeJavaScript: async code => { scripts.push(code); return { url: 'data:image/png;base64,AAAA', width: 6, height: 4 }; } };
  const render = createTrayTextRenderer({ getWebContents: () => wc, nativeImage: { createFromDataURL: url => (url.startsWith('data:image/png') ? image : null) } });
  const result = await render('Hallo');
  assert.deepEqual({ w: result.width, h: result.height, len: result.buffer.length }, { w: 6, h: 4, len: 96 });
  assert.equal(scripts.length, 1);

  assert.equal(await createTrayTextRenderer({ getWebContents: () => null, nativeImage: {} })('x'), null, 'kein Player-Fenster');
  const gone = { isDestroyed: () => true, executeJavaScript: async () => ({}) };
  assert.equal(await createTrayTextRenderer({ getWebContents: () => gone, nativeImage: {} })('x'), null);
  const bad = { isDestroyed: () => false, executeJavaScript: async () => ({ url: 'javascript:alert(1)' }) };
  assert.equal(await createTrayTextRenderer({ getWebContents: () => bad, nativeImage: {} })('x'), null, 'nur PNG-Daten-URLs');
  const failing = { isDestroyed: () => false, executeJavaScript: async () => { throw new Error('boom'); } };
  await assert.rejects(createTrayTextRenderer({ getWebContents: () => failing, nativeImage: {} })('x'), /boom/);
  const hang = { isDestroyed: () => false, executeJavaScript: () => new Promise(() => {}) };
  await assert.rejects(createTrayTextRenderer({ getWebContents: () => hang, nativeImage: {}, timeoutMs: 20 })('x'), /Zeitüberschreitung/);
});

test('composeFrame: Template-Bild (schwarz + Alpha): Alpha bleibt, Kanten-Fade wirkt über Alpha', () => {
  const icon = { buffer: Buffer.alloc(4 * 4 * 4), width: 4, height: 4 };
  const text = { buffer: Buffer.alloc(40 * 4 * 4), width: 40, height: 4 };
  for (let i = 0; i < text.width * text.height; i += 1) text.buffer[i * 4 + 3] = 200; // rgb = 0 (schwarz), Alpha 200
  const out = composeFrame({ icon, text, offsetPx: 10, windowPx: 16, gapPx: 2, height: 4, fadePx: 4 });
  const width = 4 + 2 + 16;
  assert.equal(alpha(out, width, 6 + 8, 1), 200, 'Mitte: volles Alpha');
  assert.ok(alpha(out, width, 6, 1) < 100 && alpha(out, width, 6, 1) > 0, 'linker Rand läuft über Alpha aus');
  assert.ok(alpha(out, width, 6 + 15, 1) < 100, 'rechter Rand läuft über Alpha aus');
  assert.equal(px(out, width, 6 + 8, 1), 0, 'Farbe bleibt schwarz');
});

test('centerInSquare: Bild mittig in transparentem Quadrat', () => {
  const image = bitmap(4, 4, () => 7);
  const out = centerInSquare(image, 8);
  assert.deepEqual({ w: out.width, h: out.height, len: out.buffer.length }, { w: 8, h: 8, len: 256 });
  assert.equal(alpha(out.buffer, 8, 0, 0), 0);
  assert.equal(alpha(out.buffer, 8, 2, 2), 255);
  assert.equal(px(out.buffer, 8, 5, 5), 7);
  assert.equal(alpha(out.buffer, 8, 6, 6), 0);
});
