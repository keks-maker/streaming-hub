// DOM-Hilfen des Programmführers (Etappe 3.3): Elemente nur per createElement/textContent bauen,
// Tab-Falle für Modal, Rückfrage und Overlay.

'use strict';

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
    el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0,
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

module.exports = { h, getFocusable, trapTab };
