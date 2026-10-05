// Aufklapp-Menü der Schnellfilter-Leiste (Etappe 3.5): „Sender ▾“ und „Mehr ▾“.
//
// Knopf + Panel im selben Wrapper; Klick außerhalb schließt, ein Menü zur Zeit (der Aufrufer schließt die
// anderen). Das Panel folgt dem Knopf im DOM, die Tab-Reihenfolge bleibt natürlich. Der Inhalt wird vom
// Aufrufer per onOpen (neu) aufgebaut — Texte nur per textContent.

'use strict';

const { h } = require('./epg-dom.js');

/** options: { id, label, ariaLabel, align: 'left' | 'right', onOpen() — baut den Inhalt (panel) auf }. */
function createMenu({ id, label, ariaLabel, align = 'right', onOpen }) {
  const button = h('button', {
    className: 'epg-btn epg-menu-btn',
    id,
    type: 'button',
    text: label,
    attrs: { 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': ariaLabel },
  });
  const panel = h('div', { className: 'epg-menu-panel', id: `${id}Panel`, hidden: true, attrs: { role: 'group', 'aria-label': ariaLabel } });
  panel.dataset.align = align;
  const wrap = h('div', { className: 'epg-menu' }, [button, panel]);
  let opened = false;

  function onOutside(event) {
    if (!wrap.contains(event.target)) close();
  }

  function open() {
    if (opened) return;
    if (typeof onOpen === 'function') onOpen(panel);
    opened = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close({ restoreFocus = false } = {}) {
    if (!opened) return false;
    opened = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (restoreFocus) button.focus();
    return true;
  }

  button.addEventListener('click', () => (opened ? close() : open()));

  return {
    el: wrap,
    button,
    panel,
    open,
    close,
    isOpen: () => opened,
    setLabel: text => {
      button.textContent = text;
    },
  };
}

module.exports = { createMenu };
