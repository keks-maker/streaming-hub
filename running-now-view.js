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
  button.dataset.area = card.area;
  button.setAttribute('aria-label', cardAriaLabel(card));
  const plate = el(doc, 'span', 'running-card-icon');
  plate.setAttribute('aria-hidden', 'true');
  plate.appendChild(Icons.createIcon(doc, card.icon));
  const body = el(doc, 'span', 'running-card-body');
  const title = el(doc, 'span', 'running-card-title', card.title);
  const sub = el(doc, 'span', 'running-card-sub', card.subtitle);
  body.append(title, sub);
  button.append(plate, body);
  if (card.live) {
    const badge = el(doc, 'span', 'running-card-live', 'LIVE');
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
  }
  if (card.progress > 0) {
    const bar = el(doc, 'span', 'running-card-progress');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el(doc, 'span', '');
    fill.style.width = `${(card.progress * 100).toFixed(1)}%`;
    bar.appendChild(fill);
    button.appendChild(bar);
  }
  button.addEventListener('click', () => onAction(card.action));
  return button;
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
  let signature = '';

  function paint(cards) {
    const next = JSON.stringify(cards);
    if (next === signature) return;
    signature = next;
    list.textContent = '';
    cards.forEach(card => list.appendChild(buildCard(doc, card, onAction)));
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
    signature = '';
    list.textContent = '';
    root.hidden = true;
  }

  root.hidden = true;
  return { show, hide, schedule, refresh };
}

module.exports = { createRunningNow };
