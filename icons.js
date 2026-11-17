'use strict';
/* global module, window */

// GENERIERT von scripts/gen-icons.js aus assets/lucide/*.svg (Lucide, ISC-Lizenz: assets/lucide/LICENSE). Nicht von Hand ändern.
// Icons sind Inline-SVG mit currentColor; die Größe steuert CSS (.ic, Standard 1em).

const PATHS = {
  'arrow-left': '<path d="m12 19-7-7 7-7"/> <path d="M19 12H5"/>',
  'check': '<path d="M20 6 9 17l-5-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'circle-dot': '<circle cx="12" cy="12" r="1"/> <circle cx="12" cy="12" r="10"/>',
  'circle-x': '<circle cx="12" cy="12" r="10"/> <path d="m15 9-6 6"/> <path d="m9 9 6 6"/>',
  'circle': '<circle cx="12" cy="12" r="10"/>',
  'clock': '<circle cx="12" cy="12" r="10"/> <path d="M12 6v6l4 2"/>',
  'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'menu': '<path d="M4 5h16"/> <path d="M4 12h16"/> <path d="M4 19h16"/>',
  'mic': '<path d="M12 19v3"/> <path d="M19 10v2a7 7 0 0 1-14 0v-2"/> <rect x="9" y="2" width="6" height="13" rx="3"/>',
  'monitor-play': '<path d="M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z"/> <path d="M12 17v4"/> <path d="M8 21h8"/> <rect x="2" y="3" width="20" height="14" rx="2"/>',
  'pause': '<rect x="14" y="3" width="5" height="18" rx="1"/> <rect x="5" y="3" width="5" height="18" rx="1"/>',
  'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/> <path d="m15 5 4 4"/>',
  'play': '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  'plus': '<path d="M5 12h14"/> <path d="M12 5v14"/>',
  'radio': '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/> <path d="M19.075 4.933a10 10 0 0 1 0 14.134"/> <path d="M4.925 19.067a10 10 0 0 1 0-14.134"/> <path d="M7.753 16.239a6 6 0 0 1 0-8.478"/> <circle cx="12" cy="12" r="2"/>',
  'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/> <path d="M21 3v5h-5"/>',
  'settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/> <circle cx="12" cy="12" r="3"/>',
  'square-play': '<rect x="3" y="3" width="18" height="18" rx="2"/> <path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/>',
  'square': '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'star-off': '<path d="m10.344 4.688 1.181-2.393a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.237 3.152"/> <path d="m17.945 17.945.43 2.505a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a8 8 0 0 0 .4-.099"/> <path d="m2 2 20 20"/>',
  'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/> <path d="M12 9v4"/> <path d="M12 17h.01"/>',
  'tv-minimal': '<path d="M7 21h10"/> <rect width="20" height="14" x="2" y="3" rx="2"/>',
  'x': '<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG-Markup eines Icons (für innerHTML). filled: Fläche in currentColor (aktiver Stern, Aufnahmepunkt). */
function iconSvg(name, { filled = false, cls = '', size = 0 } = {}) {
  const inner = PATHS[name];
  if (inner === undefined) throw new Error(`Unbekanntes Icon: ${name}`);
  const classes = `ic${filled ? ' ic-fill' : ''}${cls ? ` ${cls}` : ''}`;
  const style = size ? ` style="width:${size}px;height:${size}px"` : '';
  return `<svg class="${classes}"${style} xmlns="${SVG_NS}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** SVG-Element eines Icons (aria-hidden; Beschriftung trägt der Button per aria-label bzw. sichtbarem Text). */
function createIcon(doc, name, options) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = iconSvg(name, options);
  return tpl.content.firstChild;
}

/** Inhalt eines Elements durch Icon + Text ersetzen (Text optional). */
function setIconText(node, name, text, options) {
  const doc = node.ownerDocument;
  const cls = [text ? 'ic-lead' : '', options && options.cls].filter(Boolean).join(' ');
  const children = [createIcon(doc, name, { ...options, cls })];
  if (text) children.push(doc.createTextNode(text));
  node.replaceChildren(...children);
}

/** Inhalt eines Elements durch ein Icon ersetzen; label wird als aria-label gesetzt, wenn angegeben. */
function setIconOnly(node, name, label, options) {
  node.replaceChildren(createIcon(node.ownerDocument, name, options));
  if (label) node.setAttribute('aria-label', label);
}

/** Statusmeldung mit Icon: kind 'ok' (check), 'warn' und 'error' (triangle-alert). */
const STATUS_ICON = { ok: 'check', warn: 'triangle-alert', error: 'triangle-alert' };
function setStatusContent(node, kind, text) {
  const name = STATUS_ICON[kind];
  if (!name || !text) {
    node.textContent = text || '';
    return;
  }
  setIconText(node, name, text, { cls: `ic-status ic-${kind}` });
}

const api = { iconSvg, createIcon, setIconText, setIconOnly, setStatusContent, ICON_NAMES: Object.keys(PATHS) };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.Icons = api;
