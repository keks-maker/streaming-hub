// Startseite „Läuft gerade“ (Design-Umbau Schritt 6): Leiste mit bis zu vier kleinen Karten unter den Bereichskacheln.
// Dünne Ansicht: die Auswahl liefert running-now-model.js, die Daten und Klick-Ziele kommen aus renderer.js (options).
// Texte nur per textContent; leer = Leiste ausgeblendet (kein Platzhaltertext).

'use strict';

const { runningNowCards, cardAriaLabel } = require('./running-now-model.js');
const Icons = require('./icons.js');

const DEBOUNCE_MS = 120;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildCard(doc, card, onAction) {
  const button = el(doc, 'button', `running-card running-card-${card.kind}`);
  button.type = 'button';
  button.dataset.kind = card.kind;
  const plate = el(doc, 'span', 'running-card-icon');
  plate.setAttribute('aria-hidden', 'true');
  const body = el(doc, 'span', 'running-card-body');
  body.append(el(doc, 'span', 'running-card-title'), el(doc, 'span', 'running-card-sub'));
  button.append(plate, body);
  button.addEventListener('click', () => onAction(button.runningAction));
  updateCard(doc, button, card);
  return button;
}

/** Aktualisiert eine bestehende Karte in place (Fokus bleibt erhalten): Texte, Icon, LIVE-Badge, Fortschritt, Aktion. */
function updateCard(doc, button, card) {
  button.runningAction = card.action;
  button.dataset.area = card.area;
  button.setAttribute('aria-label', cardAriaLabel(card));
  const plate = button.querySelector('.running-card-icon');
  if (plate.dataset.icon !== card.icon) {
    plate.dataset.icon = card.icon;
    plate.textContent = '';
    plate.appendChild(Icons.createIcon(doc, card.icon));
  }
  const title = button.querySelector('.running-card-title');
  const sub = button.querySelector('.running-card-sub');
  if (title.textContent !== card.title) title.textContent = card.title;
  if (sub.textContent !== card.subtitle) sub.textContent = card.subtitle;
  let badge = button.querySelector('.running-card-live');
  if (card.live && !badge) {
    badge = el(doc, 'span', 'running-card-live', 'LIVE');
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
  } else if (!card.live && badge) badge.remove();
  let bar = button.querySelector('.running-card-progress');
  if (card.progress > 0) {
    if (!bar) {
      bar = el(doc, 'span', 'running-card-progress');
      bar.setAttribute('aria-hidden', 'true');
      bar.appendChild(el(doc, 'span', ''));
      button.appendChild(bar);
    }
    bar.firstChild.style.width = `${(card.progress * 100).toFixed(1)}%`;
  } else if (bar) bar.remove();
}

/**
 * options: { collect() → Eingabe für runningNowCards (async), onAction(action), isShown() (Startseite sichtbar), timers (Tests) }
 * root: <section id="runningNow">; die Überschrift „Läuft gerade“ steht im Gerüst (index.html).
 */
function createRunningNow(root, options = {}) {
  const { collect, onAction, isShown = () => true, timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) } } = options;
  const doc = root.ownerDocument || document;
  const list = root.querySelector('.running-now-list');
  let visible = false;
  let timer = null;
  let seq = 0;

  function paint(cards) {
    const keys = cards.map(card => card.kind).join(',');
    const existing = [...list.children];
    if (keys === existing.map(node => node.dataset.kind).join(',')) {
      cards.forEach((card, i) => updateCard(doc, existing[i], card));
    } else {
      // Kartenmenge/-reihenfolge geändert: neu aufbauen, Fokus nach kind wiederherstellen
      const active = doc.activeElement;
      const focusedKind = active && list.contains(active) ? active.dataset.kind : null;
      list.textContent = '';
      cards.forEach(card => list.appendChild(buildCard(doc, card, onAction)));
      if (focusedKind) {
        const target = [...list.children].find(node => node.dataset.kind === focusedKind);
        if (target) target.focus();
      }
    }
    root.hidden = cards.length === 0;
  }

  async function refresh() {
    if (!visible || !isShown()) return;
    const mine = ++seq;
    let cards;
    try {
      cards = runningNowCards(await collect());
    } catch {
      cards = [];
    }
    if (mine !== seq || !visible || !isShown()) return;
    paint(cards);
  }

  /** Zustandswechsel melden (Radio, Aufnahme, Podcast): gebündelt neu berechnen, kein Polling. */
  function schedule() {
    if (!visible) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      refresh();
    }, DEBOUNCE_MS);
  }

  function show() {
    visible = true;
    return refresh();
  }

  function hide() {
    visible = false;
    seq += 1;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    list.textContent = '';
    root.hidden = true;
  }

  root.hidden = true;
  return { show, hide, schedule, refresh };
}

module.exports = { createRunningNow };
