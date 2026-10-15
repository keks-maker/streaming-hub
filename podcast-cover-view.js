// Podcast-Oberfläche (P3): Cover-Darstellung mit Initialen-Platzhalter. https-Cover werden direkt als Bild gesetzt (wie die
// Radio-Logos); http-Cover lädt der Main über podcast:cover und liefert eine data:-URL (die CSP erlaubt kein http: für Bilder,
// der Renderer ruft Fremdadressen nicht selbst ab). Fehlt das Bild oder ist es kaputt, bleiben die Initialen sichtbar.

'use strict';

const { coverKind } = require('./podcast-format.js');

/** Auflösung einer Cover-Adresse zu einer ladbaren URL: https → unverändert, http → data:-URL vom Main, sonst null. */
async function resolveCoverSource(podcasts, url) {
  const kind = coverKind(url);
  if (kind === 'https') return url;
  if (kind === 'http' && podcasts && typeof podcasts.getCover === 'function') {
    try {
      const reply = await podcasts.getCover(url);
      return reply && reply.ok && typeof reply.dataUrl === 'string' && reply.dataUrl.startsWith('data:image/') ? reply.dataUrl : null;
    } catch {
      return null;
    }
  }
  return null;
}

function createCover(doc, { podcasts, className = '' } = {}) {
  const wrapper = doc.createElement('span');
  wrapper.className = `podcast-cover is-empty${className ? ` ${className}` : ''}`;
  wrapper.setAttribute('aria-hidden', 'true');
  const fallback = doc.createElement('span');
  fallback.className = 'podcast-cover-fallback';
  wrapper.appendChild(fallback);
  let currentUrl = null;
  let image = null;

  /** Setzt Cover-Adresse und Initialen; unveränderte Adresse lädt nicht erneut. */
  function update({ url, initial }) {
    if (fallback.textContent !== initial) fallback.textContent = initial || '?';
    const next = url || null;
    if (next === currentUrl) return;
    currentUrl = next;
    if (image) {
      image.remove();
      image = null;
    }
    wrapper.classList.add('is-empty');
    if (!next) return;
    const mine = next;
    resolveCoverSource(podcasts, next).then(source => {
      if (mine !== currentUrl || !source) return;
      const img = doc.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        if (image === img) wrapper.classList.remove('is-empty');
      });
      img.addEventListener('error', () => {
        img.remove();
        if (image === img) image = null;
        wrapper.classList.add('is-empty');
      });
      image = img;
      wrapper.appendChild(img);
      img.src = source;
    });
  }

  return { element: wrapper, update };
}

module.exports = { createCover, resolveCoverSource };
