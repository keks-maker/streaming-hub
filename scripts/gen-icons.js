'use strict';

// Erzeugt icons.js aus den Lucide-SVGs in assets/lucide/ (ISC-Lizenz, siehe assets/lucide/LICENSE).
// Aufruf: node scripts/gen-icons.js. Neue Icons: SVG aus lucide-static nach assets/lucide/ kopieren, erneut ausführen.

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'assets', 'lucide');
const data = {};
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.svg')).sort()) {
  const svg = fs.readFileSync(path.join(dir, file), 'utf8');
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/ \/>/g, '/>')
    .trim();
  data[file.replace(/\.svg$/, '')] = inner;
}

const body = Object.entries(data)
  .map(([name, inner]) => `  '${name}': '${inner.replace(/'/g, "\\'")}',`)
  .join('\n');

const out = `'use strict';
/* global module, window */

// GENERIERT von scripts/gen-icons.js aus assets/lucide/*.svg (Lucide, ISC-Lizenz: assets/lucide/LICENSE). Nicht von Hand ändern.
// Icons sind Inline-SVG mit currentColor; die Größe steuert CSS (.ic, Standard 1em).

const PATHS = {
${body}
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG-Markup eines Icons (für innerHTML). filled: Fläche in currentColor (aktiver Stern, Aufnahmepunkt). */
function iconSvg(name, { filled = false, cls = '', size = 0 } = {}) {
  const inner = PATHS[name];
  if (inner === undefined) throw new Error(\`Unbekanntes Icon: \${name}\`);
  const classes = \`ic\${filled ? ' ic-fill' : ''}\${cls ? \` \${cls}\` : ''}\`;
  const style = size ? \` style="width:\${size}px;height:\${size}px"\` : '';
  return \`<svg class="\${classes}"\${style} xmlns="\${SVG_NS}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\${inner}</svg>\`;
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
  setIconText(node, name, text, { cls: \`ic-status ic-\${kind}\` });
}

const api = { iconSvg, createIcon, setIconText, setIconOnly, setStatusContent, ICON_NAMES: Object.keys(PATHS) };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.Icons = api;
`;
fs.writeFileSync(path.join(__dirname, '..', 'icons.js'), out);
console.log(`icons.js: ${Object.keys(data).length} Icons`);
