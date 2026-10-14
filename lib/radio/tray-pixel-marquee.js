'use strict';

// Pixelweiser Lauftext im eigenen Menüleisten-Eintrag (macOS). Pro Titel wird das Textbild einmal gerendert (render),
// danach setzt ein Takt je geänderten Pixelversatz ein Frame (Textausschnitt, ohne Symbol) als Bild dieses Eintrags.
// Passt der Text ins Fenster, wird genau ein statisches Bild gesetzt (kein Takt).
// Keine Electron-Importe: Rendern, Bildbau und Bildsetzen werden hereingereicht (testbar mit Fakes).

const { pixelMarqueeOffset, PIXEL_WINDOW_WIDTH, PIXEL_FPS, PIXEL_FADE_WIDTH } = require('./tray-marquee.js');
const { composeFrame, frameSize } = require('./tray-frame.js');

const SCALE = 2; // Retina: 1 pt = 2 Gerätepixel
const FRAME_HEIGHT_PT = 32; // Höhe des Frames (wie das Symbol im Nachbar-Eintrag); der Text ist darin zentriert
const GAP_PT = 0; // linker Randabstand des Textes im Bild (die Lücke Symbol–Text kommt gemessen vom Eintragsrand durch macOS)

class TrayPixelMarquee {
  /**
   * render(text) → Promise<{ buffer, width, height } | null> (Gerätepixel, Textbild in Höhe FRAME_HEIGHT_PT*SCALE)
   * createImage(buffer, { width, height, scaleFactor }) → Bild; setImage(Bild); now(); setTick/clearTick wie setInterval.
   */
  constructor({ render, createImage, setImage, now = Date.now, setTick = setInterval, clearTick = clearInterval, logger = console, onFail = null }) {
    this.onFail = typeof onFail === 'function' ? onFail : null;
    this.render = render;
    this.createImage = createImage;
    this.setImage = setImage;
    this.now = now;
    this.setTick = setTick;
    this.clearTick = clearTick;
    this.logger = logger;
    this._token = 0;
    this._timer = null;
    this._text = null; // gerendertes Textbild
    this._startedAt = 0;
    this._lastOffset = -1;
    this._dirty = false;
  }

  /** Läuft ein Bildmodus (Textbild gerendert, Takt aktiv)? */
  get active() {
    return Boolean(this._timer);
  }

  static get heightPx() {
    return FRAME_HEIGHT_PT * SCALE;
  }

  /**
   * Startet (oder ersetzt) den Lauf für `text`. Rückgabe: Promise<'scrolling' | 'static' | 'failed' | 'stale'>.
   * 'static': Text passt ins Fenster, ein statisches Bild wurde gesetzt (kein Takt); 'failed': Rendern oder Bildsetzen schlug
   * fehl; 'stale': inzwischen überholt. Das bisherige Bild bleibt bis zum ersten neuen Frame stehen.
   */
  async start({ text }) {
    const token = this._begin();
    let rendered = null;
    try {
      rendered = await this.render(text);
    } catch (e) {
      this.logger.warn('[tray] Textbild nicht renderbar:', e && e.message);
    }
    if (token !== this._token) return 'stale';
    if (!rendered || !rendered.buffer || !(rendered.width > 0)) return 'failed';
    if (rendered.width / SCALE <= PIXEL_WINDOW_WIDTH) return this._showStatic(rendered) ? 'static' : 'failed';
    this._text = rendered;
    this._startedAt = this.now();
    this._lastOffset = -1;
    this._dirty = true;
    this._timer = this.setTick(() => {
      if (!this._tick() && this.onFail) this.onFail();
    }, Math.round(1000 / PIXEL_FPS));
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    if (this._tick()) return 'scrolling';
    return 'failed';
  }

  /** Statisches Bild für einen Text, der ins Fenster passt (volle Textbreite, ohne Rand-Verlauf). */
  _showStatic(text) {
    try {
      const gapPx = GAP_PT * SCALE;
      const height = FRAME_HEIGHT_PT * SCALE;
      const buffer = composeFrame({ text, offsetPx: 0, windowPx: text.width, gapPx, height, fadePx: 0 });
      const size = frameSize({ gapPx, windowPx: text.width, height });
      this.setImage(this.createImage(buffer, { width: size.width, height: size.height, scaleFactor: SCALE }));
      return true;
    } catch (e) {
      this.logger.warn('[tray] Textbild nicht setzbar:', e && e.message);
      return false;
    }
  }

  stop() {
    this._begin();
  }

  _begin() {
    this._token += 1;
    if (this._timer) this.clearTick(this._timer);
    this._timer = null;
    this._text = null;
    this._lastOffset = -1;
    return this._token;
  }

  /** Ein Takt; false, wenn das Bild nicht gesetzt werden konnte (der Aufrufer fällt dann zurück). */
  _tick() {
    if (!this._text) return true;
    const position = pixelMarqueeOffset(this.now() - this._startedAt, this._text.width / SCALE);
    if (position.offset === this._lastOffset && !this._dirty) return true;
    try {
      const windowPx = PIXEL_WINDOW_WIDTH * SCALE;
      const gapPx = GAP_PT * SCALE;
      const height = FRAME_HEIGHT_PT * SCALE;
      const buffer = composeFrame({ text: this._text, offsetPx: position.offset * SCALE, windowPx, gapPx, height, fadePx: PIXEL_FADE_WIDTH * SCALE });
      const size = frameSize({ gapPx, windowPx, height });
      this.setImage(this.createImage(buffer, { width: size.width, height: size.height, scaleFactor: SCALE }));
      this._lastOffset = position.offset;
      this._dirty = false;
      return true;
    } catch (e) {
      this.logger.warn('[tray] Lauftext-Bild nicht setzbar:', e && e.message);
      this._begin();
      return false;
    }
  }
}

module.exports = { TrayPixelMarquee, SCALE, FRAME_HEIGHT_PT, GAP_PT };
