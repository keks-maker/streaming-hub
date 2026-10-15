// Podcast-Oberfläche: Vorschlagsliste „Beliebte öffentlich-rechtliche Sendungen“ aus dem mitgelieferten Katalog (Leerzustand des
// Dashboards und Suche ohne Suchbegriff). Abonniert wird nie automatisch, sondern erst per Klick auf „Abonnieren“; bereits
// abonnierte Sendungen sind markiert („Abonniert“, nicht erneut wählbar). Alle Texte per textContent.

'use strict';

const { createCover } = require('./podcast-cover-view.js');

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * options: { podcasts, data (podcast-data.js), announce(text), report(message, error), id (Listen-ID), label (aria-label) }
 * Ergebnis: { element (ul), render(entries) } – entries aus popularCatalog(…): { catalogId, title, author, cover, initial, subscribed, ariaLabel }
 */
function createSuggestionList(doc, { podcasts, data, announce, report, id, label }) {
  const list = el(doc, 'ul', 'podcast-popular-list');
  if (id) list.id = id;
  if (label) list.setAttribute('aria-label', label);
  const rows = new Map(); // catalogId -> { li, cover, title, author, add, entry }
  let signature = '';

  function buildRow() {
    const li = el(doc, 'li', 'podcast-popular');
    const cover = createCover(doc, { podcasts });
    const text = el(doc, 'span', 'podcast-popular-text');
    const title = el(doc, 'span', 'podcast-show-title');
    const author = el(doc, 'span', 'podcast-show-author');
    text.append(title, author);
    const add = el(doc, 'button', 'podcast-btn');
    add.type = 'button';
    li.append(cover.element, text, add);
    const row = { li, cover, title, author, add, entry: null };
    add.addEventListener('click', async () => {
      const entry = row.entry;
      if (!entry || entry.subscribed || add.getAttribute('aria-disabled') === 'true') return;
      add.setAttribute('aria-disabled', 'true');
      try {
        await podcasts.subscribe({ catalogId: entry.catalogId });
        await data.load();
        announce(`${entry.title} abonniert`);
      } catch (error) {
        add.removeAttribute('aria-disabled');
        report(`Podcast: ${error && error.message ? error.message : 'Abo nicht möglich'}`, error);
      }
    });
    return row;
  }

  function render(entries) {
    const next = entries.map(entry => entry.catalogId).join('\n');
    if (next !== signature) {
      signature = next;
      const keep = new Map(rows);
      rows.clear();
      list.textContent = '';
      for (const entry of entries) {
        const row = keep.get(entry.catalogId) || buildRow();
        rows.set(entry.catalogId, row);
        list.appendChild(row.li);
      }
    }
    for (const entry of entries) {
      const row = rows.get(entry.catalogId);
      row.entry = entry;
      row.li.classList.toggle('is-subscribed', entry.subscribed);
      row.cover.update({ url: entry.cover, initial: entry.initial });
      row.title.textContent = entry.title;
      row.author.textContent = entry.author;
      row.add.dataset.catalogId = entry.catalogId;
      row.add.textContent = entry.subscribed ? 'Abonniert' : 'Abonnieren';
      row.add.setAttribute('aria-label', entry.ariaLabel);
      row.add.classList.toggle('is-subscribed', entry.subscribed);
      if (entry.subscribed) row.add.setAttribute('aria-disabled', 'true');
      else row.add.removeAttribute('aria-disabled');
    }
  }

  return { element: list, render };
}

module.exports = { createSuggestionList };
