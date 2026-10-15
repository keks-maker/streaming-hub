'use strict';

// Gemeinsamer Baustein der Einstellungslisten mit veränderbarer Reihenfolge: Ziehgriff (Drag & Drop) und ▲▼-Knöpfe
// als Tastaturalternative. Ohne eigene Zustandslogik: die Seite berechnet die neue Reihenfolge (settings-podcast-subs-model.js)
// und speichert sie. Fake-DOM-tauglich (nur createElement, addEventListener, classList, dataTransfer mit Prüfung).

const { el, button, findAll } = require('./settings-radio-dom.js');

/**
 * Hängt Ziehgriff und Drop-Ziel an eine Zeile. options: { key, listEl, onDrop(draggedKey, targetKey) }.
 * Liefert das Griff-Element (bereits in `parent` eingefügt).
 */
function attachDragReorder(doc, { row, parent, key, listEl, onDrop, label = 'Ziehen zum Umsortieren' }) {
  const handle = el(doc, 'span', 'settings-chan-drag', '⠿');
  handle.setAttribute('aria-hidden', 'true');
  handle.title = label;
  handle.draggable = true;
  handle.addEventListener('dragstart', event => {
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.effectAllowed = 'move';
    }
    row.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    findAll(listEl, node => node.classList && node.classList.contains('drag-over')).forEach(node => node.classList.remove('drag-over'));
  });
  row.addEventListener('dragover', event => {
    event.preventDefault();
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', event => {
    event.preventDefault();
    row.classList.remove('drag-over');
    const dragged = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
    if (dragged && dragged !== key) onDrop(dragged, key);
  });
  parent.appendChild(handle);
  return handle;
}

/** ▲▼-Knöpfe (aria-label mit Name). options: { name, canUp, canDown, onMove(delta) }; Liefert { up, down }. */
function createMoveButtons(doc, { parent, name, canUp, canDown, onMove }) {
  const make = (symbol, action, text, enabled, delta) => {
    const node = button(doc, 'settings-chan-move', symbol, action);
    node.setAttribute('aria-label', `${name}: ${text}`);
    node.title = text;
    node.disabled = !enabled;
    node.addEventListener('click', () => onMove(delta));
    parent.appendChild(node);
    return node;
  };
  return { up: make('▲', 'up', 'nach oben', canUp, -1), down: make('▼', 'down', 'nach unten', canDown, 1) };
}

module.exports = { attachDragReorder, createMoveButtons };
