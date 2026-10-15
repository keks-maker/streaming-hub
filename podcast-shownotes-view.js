// Podcast-Oberfläche: Shownotes-Baum (aus dem Main, lib/podcast/shownotes-sanitizer.js) -> DOM. Das DOM entsteht ausschließlich
// mit createElement/createTextNode/setAttribute (nie als HTML-Zeichenkette); der Baum wird hier erneut gegen die Allowlist geprüft
// (shownotes-schema.js). Links: <a href> mit sichtbarer Adresse als title, rel="noopener noreferrer", ohne target; der Klick wird
// abgefangen und über openLink(url) an den Main gegeben (der die Adresse erneut prüft und im Browser/Mailprogramm öffnet).
// Bilder lädt nur der Main (getImage(url) -> { ok, dataUrl }): höchstens 20, lazy (IntersectionObserver), höchstens 3 parallel,
// Platzhalter mit Alt-Text bei Fehler oder wenn die Einstellung „Bilder in Shownotes laden“ aus ist.

'use strict';

const { cleanTree, TAGS, VOID_TAGS } = require('./lib/podcast/shownotes-schema.js');

const MAX_IMAGES = 20;
const MAX_PARALLEL = 3;
const SCROLL_REGION_TAGS = new Set(['pre', 'table']);

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * options: { openLink(url), getImage(url) -> Promise<{ ok, dataUrl }>, loadImages (bool), maxImages, maxParallel }
 * Ergebnis: { element (Fragment), dispose(), imageCount }. Der Aufrufer hängt element ein und ruft dispose() beim Ersetzen/Schließen.
 */
function renderShownotes(doc, tree, { openLink = null, getImage = null, loadImages = true, maxImages = MAX_IMAGES, maxParallel = MAX_PARALLEL } = {}) {
  const fragment = doc.createDocumentFragment();
  const clean = cleanTree(tree);
  const uniqueImages = new Map(); // URL -> Index (Reihenfolge wie im Main)
  const queue = [];
  const observers = [];
  let running = 0;
  let disposed = false;
  const View = doc.defaultView;
  const Observer = View && typeof View.IntersectionObserver === 'function' ? View.IntersectionObserver : null;
  const observer = Observer && loadImages && getImage ? new Observer(onIntersect, { rootMargin: '200px' }) : null;
  if (observer) observers.push(observer);
  const pending = new Map(); // Platzhalter -> Bild-Daten

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const job = pending.get(entry.target);
      if (!job) continue;
      pending.delete(entry.target);
      observer.unobserve(entry.target);
      enqueue(job);
    }
  }

  function enqueue(job) {
    queue.push(job);
    pump();
  }

  function pump() {
    while (!disposed && running < maxParallel && queue.length) {
      const job = queue.shift();
      running += 1;
      Promise.resolve()
        .then(() => getImage(job.url))
        .then(reply => (reply && reply.ok === true && typeof reply.dataUrl === 'string' && reply.dataUrl.startsWith('data:image/') ? reply.dataUrl : null))
        .catch(() => null)
        .then(dataUrl => {
          running -= 1;
          if (!disposed) finishImage(job, dataUrl);
          pump();
        });
    }
  }

  function finishImage(job, dataUrl) {
    const { holder, alt, width, height } = job;
    if (!dataUrl) {
      holder.classList.remove('is-pending');
      holder.classList.add('is-error');
      holder.title = 'Bild konnte nicht geladen werden';
      return;
    }
    const img = doc.createElement('img');
    img.alt = alt;
    if (width && height) {
      img.setAttribute('width', String(width));
      img.setAttribute('height', String(height));
    }
    img.src = dataUrl; // data:image/* aus dem Main (Magic-Bytes geprüft)
    holder.textContent = '';
    holder.classList.remove('is-pending');
    holder.classList.add('is-loaded');
    holder.appendChild(img);
  }

  function imagePlaceholder(attrs) {
    const alt = attrs.alt || '';
    const holder = el(doc, 'span', 'podcast-notes-img is-pending');
    holder.appendChild(el(doc, 'span', 'podcast-notes-img-alt', alt || 'Bild'));
    const url = attrs.src;
    if (!uniqueImages.has(url)) uniqueImages.set(url, uniqueImages.size);
    const index = uniqueImages.get(url);
    if (!loadImages || !getImage) {
      holder.classList.remove('is-pending');
      holder.classList.add('is-off');
      holder.title = 'Bilder in den Shownotes sind ausgeschaltet';
    } else if (index >= maxImages) {
      holder.classList.remove('is-pending');
      holder.classList.add('is-off');
      holder.title = 'Weitere Bilder werden nicht geladen';
    } else {
      const job = { url, holder, alt, width: attrs.width, height: attrs.height };
      if (observer) {
        pending.set(holder, job);
        observer.observe(holder);
      } else {
        enqueue(job);
      }
    }
    return holder;
  }

  function link(node) {
    const a = doc.createElement('a');
    const href = node.a.href;
    a.setAttribute('href', href);
    a.setAttribute('rel', 'noopener noreferrer');
    a.title = node.a.title ? `${node.a.title}\n${href}` : href;
    a.className = 'podcast-notes-link';
    a.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof openLink === 'function') openLink(href);
    });
    a.addEventListener('auxclick', event => event.preventDefault());
    return a;
  }

  function build(node, parent) {
    if (typeof node === 'string') {
      parent.appendChild(doc.createTextNode(node));
      return;
    }
    if (!node || !TAGS.has(node.t)) return;
    if (node.t === 'img') {
      parent.appendChild(imagePlaceholder(node.a));
      return;
    }
    const element = node.t === 'a' ? link(node) : doc.createElement(node.t);
    if (node.t === 'td' || node.t === 'th') {
      if (node.a && node.a.colspan) element.setAttribute('colspan', String(node.a.colspan));
      if (node.a && node.a.rowspan) element.setAttribute('rowspan', String(node.a.rowspan));
    }
    if (!VOID_TAGS.has(node.t)) for (const child of node.c || []) build(child, element);
    if (SCROLL_REGION_TAGS.has(node.t)) {
      const target = node.t === 'table' ? el(doc, 'div', 'podcast-notes-table-wrap') : element;
      target.tabIndex = 0; // per Tastatur scrollbar
      target.setAttribute('role', 'region');
      target.setAttribute('aria-label', node.t === 'table' ? 'Tabelle' : 'Codeblock');
      if (node.t === 'table') target.appendChild(element);
      parent.appendChild(target);
      return;
    }
    parent.appendChild(element);
  }

  for (const node of clean) build(node, fragment);
  if (!loadImages && uniqueImages.size) {
    fragment.appendChild(el(doc, 'p', 'podcast-section-empty podcast-notes-images-off', 'Bilder in den Shownotes sind ausgeschaltet (Einstellungen → Podcasts → Wiedergabe).'));
  }

  function dispose() {
    disposed = true;
    queue.length = 0;
    pending.clear();
    for (const entry of observers) entry.disconnect();
    observers.length = 0;
  }

  return { element: fragment, dispose, imageCount: uniqueImages.size };
}

module.exports = { renderShownotes, MAX_IMAGES, MAX_PARALLEL };
