// Senderkachel (docs/DESIGN.md „Senderkachel“): gemeinsame Bausteine für die LiveTV-Favoriten (renderer.js) und
// „Jetzt & Gleich“ im Programmführer (epg-jng-view.js). Medienfläche (Verlauf/Bild, Logo-Platte, Zeitpille),
// Fortschrittslinie, EPG-Vorschaubild (Main-Cache über getEpgImage) und die stumme Hover-/Fokus-Vorschau (eine
// gleichzeitig, 350 ms Verzögerung, Überblendung erst beim ersten Videobild).
//
// Eine Kit-Instanz teilen sich alle Kacheln der Seite: Nur so gibt es höchstens eine Vorschau und einen
// gemeinsamen Bildcache. Texte nur per textContent.

'use strict';

const Icons = require('./icons.js');

const PREVIEW_DELAY_MS = 350;
const PREVIEW_CROSSFADE_MS = 300; // = --motion-crossfade in styles.css
const IMAGE_CACHE_MAX = 60;

/** „noch 29 Min.“ bzw. „noch 1 Std. 15 Min.“ für die verbleibenden Minuten (aufgerundet). */
function formatRemainingMinutes(minutes) {
  const total = Math.max(0, Math.ceil(minutes));
  if (total < 60) return `noch ${total} Min.`;
  const rest = total % 60;
  return `noch ${Math.floor(total / 60)} Std.${rest ? ` ${rest} Min.` : ''}`;
}

/** „noch 29 Min.“ für die laufende Sendung (stop und now in ms). */
function formatRemaining(stop, now) {
  return formatRemainingMinutes((stop - now) / 60000);
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Meldet das erste dekodierte Videobild einer Vorschau (Fallback: Ereignis „playing“). */
function onPreviewFirstFrame(video, callback) {
  if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => callback());
  else video.addEventListener('playing', () => callback(), { once: true });
}

/**
 * deps: safeResourceUrl(url) → sichere URL oder '', getEpgImage(url, stopMs) → Promise<data:-URL|null>,
 * openFullscreen(tile, ch) optional (Vollbild nach dem Start der Vorschau).
 */
function createLiveTvTileKit(deps) {
  const imageCache = new Map(); // Bild-URL -> data:-URL
  let activePreview = null;
  let previewTimer = null;

  // ── Aufbau ──

  /** Medienfläche: Verlauf mit Platzhalter-Icon, Logo-Platte unten links (ohne Logo: fallbackText, Standard erster Buchstabe), Zeitpille unten rechts (nur mit Sendung). */
  function createMedia(ch, { start = 0, stop = 0, logoTag = 'span', fallbackText = '' } = {}) {
    const media = el('span', 'tv-tile-media');
    const still = el('span', 'tv-tile-still');
    still.setAttribute('aria-hidden', 'true');
    still.innerHTML = Icons.iconSvg('tv-minimal');
    const logo = el(logoTag, 'dashboard-tile-icon tv-tile-logo');
    if (logoTag === 'button') logo.type = 'button';
    const fallback = el('span', 'dashboard-tile-fallback', fallbackText || (ch.name || '?').slice(0, 1).toUpperCase());
    fallback.setAttribute('aria-hidden', 'true');
    const image = el('img');
    image.alt = '';
    image.loading = 'lazy';
    logo.append(fallback, image);
    const showFallback = () => {
      image.remove();
      logo.classList.add('has-error');
    };
    const src = deps.safeResourceUrl(ch.logo);
    if (src) image.src = src;
    else showFallback();
    image.addEventListener('error', showFallback);
    media.append(still, logo);
    if (stop) media.appendChild(el('span', 'tv-tile-time', `${formatClock(start)} – ${formatClock(stop)}`));
    return media;
  }

  /** Fortschrittslinie (3 px, area-livetv); percent 0–100. */
  function createProgress(percent = 0) {
    const bar = el('span', 'dashboard-tv-progress');
    const fill = el('span');
    fill.style.width = `${Number(percent).toFixed(1)}%`;
    bar.appendChild(fill);
    return bar;
  }

  // ── Vorschaubild ──

  /** Bild in die Medienfläche setzen; ohne URL oder bei Ladefehler bleibt der Verlauf mit Platzhalter-Icon. */
  function setImage(tile, url) {
    const still = tile.querySelector('.tv-tile-still');
    if (!still) return;
    still.querySelector('.tv-tile-image')?.remove();
    still.classList.remove('has-image');
    const src = deps.safeResourceUrl(url);
    if (!src) return;
    const img = el('img', 'tv-tile-image');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => still.classList.add('has-image'));
    img.addEventListener('error', () => img.remove());
    img.src = src;
    still.appendChild(img);
  }

  /**
   * EPG-Bild der laufenden Sendung nachladen: fragt den Main-Cache asynchron, die Kachel steht sofort mit Verlauf da.
   * Bei Sendungswechsel (andere URL) wechselt das Bild; ohne Bild oder bei Fehler bleibt der Verlauf.
   */
  async function loadImage(tile, url, stopMs) {
    const wanted = typeof url === 'string' ? url : '';
    if (tile.dataset.epgImage === wanted) return;
    tile.dataset.epgImage = wanted;
    if (!wanted) {
      setImage(tile, '');
      return;
    }
    let dataUrl = imageCache.get(wanted);
    if (dataUrl === undefined) {
      try {
        dataUrl = (await deps.getEpgImage(wanted, stopMs)) || null;
      } catch (_) {
        dataUrl = null;
      }
      if (dataUrl) {
        if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
        imageCache.set(wanted, dataUrl);
      }
    }
    if (tile.dataset.epgImage === wanted) setImage(tile, dataUrl || '');
  }

  /**
   * Kleines Vorschaubild (z. B. „Danach“-Zeile) in einen Platzhalter laden: derselbe Main-Cache und Bildcache wie das
   * Kachelbild (kein Fremdhost im Renderer). Ohne Bild oder bei Fehler bleibt der Platzhalter; Klasse has-img zeigt das Bild.
   */
  async function loadThumb(box, url, stopMs) {
    const wanted = typeof url === 'string' ? url : '';
    if (!box || !wanted || box.dataset.epgImage === wanted) return;
    box.dataset.epgImage = wanted;
    let dataUrl = imageCache.get(wanted);
    if (dataUrl === undefined) {
      try {
        dataUrl = (await deps.getEpgImage(wanted, stopMs)) || null;
      } catch (_) {
        dataUrl = null;
      }
      if (dataUrl) {
        if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
        imageCache.set(wanted, dataUrl);
      }
    }
    const src = box.dataset.epgImage === wanted ? deps.safeResourceUrl(dataUrl || '') : '';
    if (!src) return;
    const img = el('img', 'epg-thumb-img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => box.classList.add('has-img'));
    img.addEventListener('error', () => {
      img.remove();
      box.classList.remove('has-img');
    });
    img.src = src;
    box.appendChild(img);
  }

  // ── Vorschau ──

  function startPreview(tile, ch, openAfterStart = false) {
    if (!ch || !ch.url || activePreview?.tile === tile) {
      if (openAfterStart && activePreview?.tile === tile && deps.openFullscreen) deps.openFullscreen(tile, ch);
      return;
    }
    stopPreview();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const media = tile.querySelector('.tv-tile-media');
      if (!media) return;
      const video = document.createElement('video');
      video.className = 'dashboard-tv-preview';
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      media.prepend(video);
      const preview = { tile, video, hls: null, fullscreen: false, shown: false };
      activePreview = preview;
      // Bild/Platzhalter bleibt sichtbar, bis das erste Videobild da ist; erst dann überblenden.
      onPreviewFirstFrame(video, () => {
        if (activePreview !== preview) return;
        preview.shown = true;
        tile.classList.add('is-previewing');
      });
      if (openAfterStart && deps.openFullscreen) {
        video.addEventListener(
          'playing',
          () => {
            if (activePreview === preview && !preview.fullscreen) deps.openFullscreen(tile, ch);
          },
          { once: true },
        );
      }
      const fail = () => {
        if (activePreview !== preview) return;
        tile.classList.add('is-preview-error');
        stopPreview();
      };
      video.addEventListener('error', fail, { once: true });
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false, maxBufferLength: 8, liveSyncDurationCount: 2 });
        preview.hls = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) fail();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(fail));
        hls.loadSource(ch.url);
        hls.attachMedia(video);
      } else {
        video.src = ch.url;
        video.play().catch(fail);
      }
    }, PREVIEW_DELAY_MS);
  }

  /** Entfernt Stream und Video-Element einer Vorschau (nach dem Zurückblenden, siehe stopPreview). */
  function teardownPreview(preview) {
    if (preview.hls) preview.hls.destroy();
    preview.video.pause();
    preview.video.removeAttribute('src');
    preview.video.load();
    preview.video.remove();
  }

  function stopPreview() {
    if (activePreview?.fullscreen) return;
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (!activePreview) return;
    const preview = activePreview;
    activePreview = null;
    preview.tile.classList.remove('is-previewing', 'is-preview-error');
    // Hat das Video schon Bild gezeigt, bleibt es für die Dauer der Überblendung stehen (kein schwarzer Moment), dann Abbau.
    if (preview.shown) setTimeout(() => teardownPreview(preview), PREVIEW_CROSSFADE_MS);
    else teardownPreview(preview);
  }

  /** Vorschau beenden, wenn sie zu dieser Kachel gehört (Kachel verschwindet aus dem DOM). */
  function stopPreviewOf(tile) {
    if (activePreview?.tile === tile || (!activePreview && previewTimer)) stopPreview();
  }

  /** Hover und Tastaturfokus der Kachel starten die Vorschau, Verlassen beendet sie. */
  function attachPreview(tile, ch) {
    tile.addEventListener('mouseenter', () => startPreview(tile, ch));
    tile.addEventListener('mouseleave', stopPreview);
    tile.addEventListener('focusin', () => startPreview(tile, ch));
    tile.addEventListener('focusout', event => {
      if (!event.relatedTarget || !tile.contains(event.relatedTarget)) stopPreview();
    });
  }

  return {
    createMedia,
    createProgress,
    setImage,
    loadImage,
    loadThumb,
    startPreview,
    stopPreview,
    stopPreviewOf,
    attachPreview,
    getActivePreview: () => activePreview,
  };
}

module.exports = { createLiveTvTileKit, formatRemaining, formatRemainingMinutes, formatClock };
