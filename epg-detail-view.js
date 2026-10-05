// Erweiterung des Detail-Modals (Etappe 3.6, M6/EPG-E4/E7): Poster, Metazeile, Besetzung, Untertitel/Altersfreigabe
// und „Läuft auch“.
//
// Reine DOM-Sicht ohne Datenlogik: die Texte kommen fertig aus epg-detail-model.js, die Daten aus epg-view.js
// (epg:find mit voller Projektion, epg:search für „Läuft auch“). Fremdtexte nur per textContent; das Poster ist
// ein img, dessen src erst nach safeIconUrl (nur http/https) gesetzt wird. Fehlen Felder, entfällt die Zeile
// (kein leerer Platzhalter) — nur das Poster behält bei Ladefehler seinen festen Rahmen (kein Layoutsprung).

'use strict';

const detailModel = require('./epg-detail-model.js');
const { h } = require('./epg-dom.js');
const { genreLabel } = require('./epg-genres.js');

/** deps: metaEl (Zeit/Sender-Zeile des Modals), onPickAlso(row), now(). */
function createDetailView(deps) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const sub = h('p', { className: 'epg-detail-sub', id: 'epgDetailSub', hidden: true });
  const info = h('p', { className: 'epg-detail-info', id: 'epgDetailInfo', hidden: true });
  const rating = h('span', { className: 'epg-detail-rating', id: 'epgDetailRating', hidden: true });
  const cast = h('p', { className: 'epg-detail-cast', id: 'epgDetailCast', hidden: true });
  const text = h('div', { className: 'epg-detail-top-text' }, [sub, deps.metaEl, info, cast]);
  const poster = h('div', { className: 'epg-detail-poster', id: 'epgDetailPoster', hidden: true, attrs: { 'aria-hidden': 'true' } });
  const top = h('div', { className: 'epg-detail-top' }, [text, poster]);

  const alsoList = h('ul', { className: 'epg-also-list', attrs: { 'aria-label': 'Läuft auch' } });
  const alsoMore = h('div', { className: 'epg-also-more', hidden: true });
  const also = h('section', { className: 'epg-detail-also', id: 'epgDetailAlso', hidden: true, attrs: { 'aria-label': 'Läuft auch' } }, [
    h('h4', { className: 'epg-also-title', text: 'Läuft auch' }),
    alsoList,
    alsoMore,
  ]);

  let base = { genre: '', minutes: 0 };
  let extra = { year: 0, episode: '' };

  function renderInfo() {
    info.textContent = '';
    const label = genreLabel(base.genre);
    const parts = detailModel.metaParts({ genreText: label, year: extra.year, minutes: base.minutes, episode: extra.episode });
    parts.forEach((part, i) => {
      if (i) info.appendChild(document.createTextNode(' · '));
      if (i === 0 && label && part === label) {
        const genre = h('span', { className: 'epg-info-genre', text: part });
        genre.dataset.g = base.genre;
        genre.prepend(h('span', { className: 'epg-chip-dot', attrs: { 'aria-hidden': 'true' } }));
        info.appendChild(genre);
      } else {
        info.appendChild(document.createTextNode(part));
      }
    });
    if (!rating.hidden) {
      if (parts.length) info.appendChild(document.createTextNode(' '));
      info.appendChild(rating);
    }
    info.hidden = !parts.length && rating.hidden;
  }

  function clearPoster() {
    poster.textContent = '';
    poster.hidden = true;
    poster.classList.remove('is-failed', 'has-img');
  }

  /** Neues Detail: alles zurücksetzen, Genre/Dauer stehen schon vor der Antwort von epg:find fest. */
  function reset({ genre = '', minutes = 0 } = {}) {
    base = { genre, minutes };
    extra = { year: 0, episode: '' };
    sub.textContent = '';
    sub.hidden = true;
    rating.textContent = '';
    rating.hidden = true;
    cast.textContent = '';
    cast.hidden = true;
    clearPoster();
    alsoList.textContent = '';
    alsoMore.hidden = true;
    also.hidden = true;
    renderInfo();
  }

  /** Antwort von epg:find (volle Projektion) einarbeiten; slot kann null sein (dann bleibt das Modal neutral). */
  function setExtra(slot) {
    if (!slot || typeof slot !== 'object') return;
    extra = { year: detailModel.cleanYear(slot.year), episode: typeof slot.episode === 'string' ? slot.episode : '' };
    const subtitle = detailModel.subtitleText(slot.subtitle);
    sub.textContent = subtitle;
    sub.hidden = !subtitle;
    const ratingValue = detailModel.ratingText(slot.rating);
    rating.textContent = ratingValue;
    rating.hidden = !ratingValue;
    renderInfo();
    const castText = detailModel.castLine(slot.credits);
    cast.textContent = castText;
    cast.hidden = !castText;
    const url = detailModel.safeIconUrl(slot.icon);
    clearPoster();
    if (url) {
      poster.hidden = false;
      const img = h('img', { className: 'epg-poster-img', attrs: { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' } });
      img.addEventListener('load', () => poster.classList.add('has-img'));
      img.addEventListener('error', () => {
        img.remove(); // Bild entfällt, der Rahmen bleibt (kein Layoutsprung)
        poster.classList.add('is-failed');
      });
      poster.appendChild(img);
      img.src = url;
    }
  }

  /** „Läuft auch“: { items: Zeilen, more: Anzahl } aus detailModel.alsoPicks; ohne Einträge bleibt der Abschnitt weg. */
  function setAlso(result) {
    alsoList.textContent = '';
    const items = result && Array.isArray(result.items) ? result.items : [];
    also.hidden = items.length === 0;
    alsoMore.hidden = !(result && result.more > 0);
    if (!items.length) return;
    const nowMs = now();
    for (const row of items) {
      const label = detailModel.alsoLabel(row, nowMs);
      const btn = h('button', { className: 'epg-also-item', type: 'button' }, [
        h('span', { className: 'epg-also-when', text: label.when }),
        h('span', { className: 'epg-also-channel', text: label.channel }),
      ]);
      btn.dataset.rowId = row.id;
      btn.title = `${row.title} · ${label.channel} · ${label.when}`;
      btn.addEventListener('click', () => {
        if (typeof deps.onPickAlso === 'function') deps.onPickAlso(row);
      });
      alsoList.appendChild(h('li', { className: 'epg-also-li' }, [btn]));
    }
    if (result.more > 0) alsoMore.textContent = `+ ${result.more} weitere Termine (Anzeige max. ${detailModel.ALSO_LIMIT})`;
  }

  reset();

  return { top, also, reset, setExtra, setAlso };
}

module.exports = { createDetailView };
