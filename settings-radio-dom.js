'use strict';

// Kleine DOM-Bausteine der Radio-Einstellungsseiten (R3). Nutzerdaten kommen nur per textContent bzw. value in
// den DOM, nie über innerHTML. Funktionen nehmen das Dokument entgegen, damit die Seiten ohne Browser testbar sind.

const { formatIpcError } = require('./settings-tv-sources.js');
const { safeLogoUrl, stationInitial } = require('./radio-dashboard-model.js');

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Logo einer Senderzeile samt Platzhalter mit Anfangsbuchstaben (wie im Dashboard). Das Bild trägt „empty“, wenn es
 * kein Logo gibt oder es nicht lädt; dann zeigt das Geschwister-Element den Buchstaben (CSS).
 */
function appendStationLogo(doc, parent, station) {
  const logo = el(doc, 'img', 'settings-chan-logo settings-radio-logo');
  logo.alt = '';
  logo.loading = 'lazy';
  const src = safeLogoUrl(station.logo);
  logo.addEventListener('error', () => {
    logo.removeAttribute('src');
    logo.classList.add('empty');
  });
  if (src) logo.src = src;
  else logo.classList.add('empty');
  const fallback = el(doc, 'span', 'settings-chan-logo-fallback', stationInitial(station.name));
  fallback.setAttribute('aria-hidden', 'true');
  parent.append(logo, fallback);
  return logo;
}

/** Statuszeile für Screenreader (role=status, aria-live=polite). */
function statusLine(doc, id) {
  const node = el(doc, 'div', 'settings-status settings-status-left');
  if (id) node.id = id;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  return node;
}

function setStatus(node, message, isError = false) {
  node.textContent = message || '';
  node.classList.toggle('error', Boolean(isError));
}

/** Beschriftetes Feld mit optionaler Fehlermeldung (aria-describedby auf die Meldung). */
function labelledField(doc, labelText, control, { error = '', hint = '', idBase = '' } = {}) {
  const wrap = el(doc, 'label', 'settings-field');
  wrap.appendChild(el(doc, 'span', 'settings-field-label', labelText));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el(doc, 'span', 'settings-field-hint', hint));
  if (error) {
    const msg = el(doc, 'div', 'settings-chan-error', error);
    msg.setAttribute('role', 'alert');
    if (idBase) {
      msg.id = `${idBase}-error`;
      control.setAttribute('aria-describedby', msg.id);
    }
    control.setAttribute('aria-invalid', 'true');
    wrap.appendChild(msg);
    // Sobald das Feld geändert wird, ist die Meldung überholt
    control.addEventListener('input', () => {
      msg.remove();
      if (typeof control.removeAttribute === 'function') {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
    });
  }
  return wrap;
}

function textInput(doc, { field, value = '', placeholder = '', type = 'text' }) {
  const input = el(doc, 'input', 'modal-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.field = field;
  return input;
}

function button(doc, className, text, action) {
  const node = el(doc, 'button', className, text);
  node.type = 'button';
  if (action) node.dataset.action = action;
  return node;
}

/** Alle Nachfahren, die pred erfüllen (echtes DOM und Fake-DOM der Tests). */
function findAll(node, pred) {
  if (typeof node.find === 'function') return node.find(pred);
  return Array.from(node.querySelectorAll('*')).filter(pred);
}

function childList(node) {
  return Array.from(node.children);
}

function focusNode(node) {
  if (node && typeof node.focus === 'function') node.focus();
}

module.exports = { el, appendStationLogo, statusLine, setStatus, labelledField, textInput, button, focusNode, findAll, childList, formatIpcError };
