// DOM-Hilfen des Programmführers (Etappe 3.3): Elemente nur per createElement/textContent bauen,
// Tab-Falle für Modal, Rückfrage und Overlay.

'use strict';

const gridModel = require('./epg-grid-model.js');

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.type) el.type = props.type;
  if (props.hidden) el.hidden = true;
  for (const [name, value] of Object.entries(props.attrs || {})) el.setAttribute(name, value);
  for (const child of children) el.appendChild(child);
  return el;
}

function getFocusable(container) {
  return [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]')].filter(
    el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0,
  );
}

/** Tab-Falle: hält den Fokus in container. Gibt true zurück, wenn die Taste behandelt wurde. */
function trapTab(event, container) {
  if (event.key !== 'Tab') return false;
  const list = getFocusable(container);
  if (!list.length) {
    event.preventDefault();
    return true;
  }
  const idx = list.indexOf(document.activeElement);
  const next = event.shiftKey ? (idx <= 0 ? list.length - 1 : idx - 1) : idx === -1 || idx === list.length - 1 ? 0 : idx + 1;
  event.preventDefault();
  list[next].focus();
  return true;
}

/**
 * Senderlogo (Raster-Senderspalte und Kanalansicht): Kürzel-Badge, darüber das echte Logo aus dem
 * Playlist-Kanalobjekt (img nur über die Property src, lazy; sanitizeLogoUrl = safeResourceUrl des
 * Renderers). Fehlt das Logo oder scheitert das Laden, bleibt das Kürzel stehen.
 */
function createChannelLogo({ name, channel, sanitizeLogoUrl, extraClass = '' }) {
  const badge = gridModel.channelBadge(name);
  const logo = h('span', {
    className: `epg-grid-logo${extraClass ? ` ${extraClass}` : ''}`,
    text: badge.abbr,
    attrs: { 'aria-hidden': 'true' },
  });
  logo.style.setProperty('--h', String(badge.hue));
  const logoUrl = gridModel.resolveLogoUrl(channel, sanitizeLogoUrl);
  if (logoUrl) {
    const img = h('img', { className: 'epg-grid-logo-img', attrs: { alt: '', loading: 'lazy', decoding: 'async' } });
    // Bis das Logo geladen ist, bleibt das Kürzel sichtbar; erst dann ersetzt das Bild das Badge.
    img.addEventListener('load', () => logo.classList.add('has-img'));
    img.addEventListener('error', () => {
      img.remove();
      logo.classList.remove('has-img');
    });
    logo.appendChild(img);
    img.src = logoUrl;
  }
  return logo;
}

module.exports = { h, getFocusable, trapTab, createChannelLogo };
