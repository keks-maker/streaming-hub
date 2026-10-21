'use strict';

// Serienseite: Kopf (Zurück, Abspielen/Fortsetzen/Nächste Folge, Merken), Staffelauswahl, Sortierung und Folgenliste.
// Dünne Ansicht über mediathek-series-model.js.

const { createSeriesPage } = require('./mediathek-series-model.js');
const { sourceBadge, imageSrc, subtitleText, minutesText, fskText, seriesFsk } = require('./mediathek-format.js');
const { el, button, createThumb, setIcon, PLAY_SVG, STAR_SVG, STAR_OUTLINE_SVG } = require('./mediathek-cards.js');
const { downloadIcon, AUTO_SVG } = require('./mediathek-download-icons.js');
const { stateLabel } = require('./mediathek-downloads-model.js');
const { menuItems } = require('./mediathek-download-select-model.js');

const BACK_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';

/**
 * ctx: { api, back(), play(entry, series, trigger), openDetail(entry, series, trigger), isBlocked(id), toggleFavorite(series) -> Promise<bool|null>,
 *        onFavoritesChanged(listener) -> unsubscribe, announce(text),
 *        downloads?: { enabled(), stateOf(entry) -> { state, percent }, count(series), start(entry, series, trigger), openSelection({ series, seasons, mode, trigger }),
 *                      openArea(tab), subscribe(listener) -> unsubscribe,
 *                      auto?: { isOn(series), toggle(series, { seasons, trigger }) -> Promise } } }
 */
function createMediathekSeriesView(root, ctx) {
  const doc = root.ownerDocument || document;
  let page = null;
  let unsubscribe = null;
  let unsubscribeDownloads = null;
  let current = null;
  let menuOpen = false;
  let observer = null;

  function enter(series) {
    if (unsubscribe) unsubscribe();
    current = series;
    page = createSeriesPage({ api: ctx.api, series });
    unsubscribe = page.subscribe(render);
    if (unsubscribeDownloads) unsubscribeDownloads();
    unsubscribeDownloads = dl() ? ctx.downloads.subscribe(patchDownloads) : null;
    menuOpen = false;
    render();
    page.load();
  }

  const dl = () => Boolean(ctx.downloads && ctx.downloads.enabled());

  function paintDownloadButton(btn, entry) {
    const st = ctx.downloads.stateOf(entry);
    const label = stateLabel(st);
    btn.className = `mediathek-dl-btn-inline is-${st.state}`;
    setIcon(btn.querySelector('.mediathek-dl-icon'), downloadIcon(st.state, st.percent));
    btn.setAttribute('aria-label', `${label}: ${entry.title}`);
    btn.title = label;
    btn.dataset.dlState = st.state;
  }

  function downloadButton(entry, series) {
    const btn = el(doc, 'button');
    btn.type = 'button';
    btn.dataset.action = 'download';
    btn.appendChild(el(doc, 'span', 'mediathek-dl-icon'));
    paintDownloadButton(btn, entry);
    btn.addEventListener('click', () => {
      const state = btn.dataset.dlState;
      if (state === 'none' || state === 'failed') ctx.downloads.start(entry, series, btn);
      else ctx.downloads.openArea(state === 'done' ? 'library' : 'queue');
    });
    return btn;
  }

  /** Zustände ohne Neuaufbau nachziehen (Fokus und Scrollposition bleiben). */
  function patchDownloads() {
    if (!page || !dl()) return;
    const index = entryIndex();
    for (const row of root.querySelectorAll('.mediathek-episode')) {
      const btn = row.querySelector('[data-action="download"]');
      const entry = index.get(row.dataset.entryId);
      if (btn && entry) paintDownloadButton(btn, entry);
    }
    const count = root.querySelector('.mediathek-dl-count');
    if (count) paintCount(count);
    const auto = root.querySelector('[data-action="auto"]');
    if (auto) paintAuto(auto);
  }

  /** Schalter „Neue Folgen automatisch laden“ (Abo) im Serienkopf. */
  function paintAuto(btn) {
    const on = ctx.downloads.auto.isOn(current);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Neue Folgen automatisch laden: an. Zum Ausschalten drücken' : 'Neue Folgen automatisch laden: aus. Zum Einschalten drücken');
    btn.title = on ? 'Neue Folgen werden automatisch geladen' : 'Neue Folgen automatisch laden';
    btn.querySelector('.mediathek-auto-label').textContent = on ? 'Auto-Laden an' : 'Auto-Laden';
  }

  function autoButton(series) {
    const btn = el(doc, 'button', 'mediathek-btn mediathek-auto-btn');
    btn.type = 'button';
    btn.id = 'mediathekSeriesAuto';
    btn.dataset.action = 'auto';
    const icon = el(doc, 'span');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, AUTO_SVG);
    btn.append(icon, el(doc, 'span', 'mediathek-auto-label'));
    paintAuto(btn);
    btn.addEventListener('click', () => ctx.downloads.auto.toggle(series, { seasons: page.loadedSeasons(), trigger: btn }));
    return btn;
  }

  /** Alle geladenen Folgen nach ID (Liste plus komplett geladene Staffeln). */
  function entryIndex() {
    const index = new Map();
    for (const season of page.loadedSeasons()) for (const entry of season.entries) index.set(entry.id, entry);
    return index;
  }

  function paintCount(node) {
    const n = ctx.downloads.count(current);
    node.hidden = n === 0;
    node.textContent = n === 1 ? '1 Folge geladen' : `${n} Folgen geladen`;
  }

  function downloadMenu(series) {
    const wrap = el(doc, 'div', 'mediathek-menu-wrap');
    const toggle = el(doc, 'button', 'mediathek-btn mediathek-dl-menu-btn');
    toggle.type = 'button';
    toggle.id = 'mediathekSeriesLoad';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', String(menuOpen));
    toggle.setAttribute('aria-label', 'Folgen herunterladen');
    const icon = el(doc, 'span');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, downloadIcon('none'));
    toggle.append(icon, el(doc, 'span', '', 'Laden'), el(doc, 'span', 'mediathek-caret', '▾'));
    toggle.lastChild.setAttribute('aria-hidden', 'true');
    toggle.addEventListener('click', () => {
      menuOpen = !menuOpen;
      toggle.setAttribute('aria-expanded', String(menuOpen));
      renderMenu();
      if (menuOpen) {
        const first = wrap.querySelector('[role="menuitem"]');
        if (first) first.focus();
      }
    });
    const list = el(doc, 'ul', 'mediathek-menu');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', 'Folgen laden');
    list.hidden = !menuOpen;
    wrap.append(toggle, list);
    function renderMenu() {
      list.hidden = !menuOpen;
      list.textContent = '';
      if (!menuOpen) return;
      for (const item of menuItems(page.snapshot().seasonNumbers, page.snapshot().seasonTitles)) {
        const li = el(doc, 'li');
        li.setAttribute('role', 'none');
        const entry = button(doc, 'mediathek-menu-item', item.label, () => {
          menuOpen = false;
          renderMenu();
          toggle.setAttribute('aria-expanded', 'false');
          ctx.downloads.openSelection({ series, seasons: page.loadedSeasons(), mode: item.id, trigger: toggle });
        });
        entry.setAttribute('role', 'menuitem');
        entry.dataset.mode = item.id;
        li.appendChild(entry);
        list.appendChild(li);
      }
    }
    wrap.addEventListener('keydown', event => {
      if (!menuOpen) return;
      const items = [...list.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(doc.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menuOpen = false;
        renderMenu();
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next].focus();
      } else if (event.key === 'Tab') {
        menuOpen = false;
        renderMenu();
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    renderMenu();
    return wrap;
  }

  function reload() {
    if (page) page.load();
  }

  function hero(state) {
    const series = state.series;
    const box = el(doc, 'header', 'mediathek-hero');
    const src = imageSrc(series.imageUrl, 1280);
    if (src) {
      const bg = el(doc, 'img', 'mediathek-hero-img');
      bg.alt = '';
      bg.addEventListener('error', () => bg.remove());
      bg.src = src;
      box.appendChild(bg);
    }
    const back = el(doc, 'button', 'mediathek-back');
    back.type = 'button';
    back.id = 'mediathekSeriesBack';
    back.setAttribute('aria-label', 'Zurück zu den Mediatheken');
    const icon = el(doc, 'span');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, BACK_SVG);
    back.append(icon, el(doc, 'span', '', 'Mediatheken'));
    back.addEventListener('click', () => ctx.back());

    const text = el(doc, 'div', 'mediathek-hero-text');
    text.appendChild(el(doc, 'p', 'mediathek-eyebrow', `${sourceBadge(series.sourceId)} · SERIE`));
    const title = el(doc, 'h2', 'mediathek-hero-title', series.title);
    title.id = 'mediathekSeriesTitle';
    text.appendChild(title);
    const badges = el(doc, 'p', 'mediathek-dialog-badges mediathek-hero-fsk');
    const fsk = fskText(seriesFsk(state.seasons));
    if (fsk) badges.appendChild(el(doc, 'span', 'mediathek-fsk-badge', fsk));
    badges.hidden = !fsk;
    text.appendChild(badges);
    if (series.description) text.appendChild(el(doc, 'p', 'mediathek-hero-desc', series.description));

    const actions = el(doc, 'div', 'mediathek-actions');
    const play = el(doc, 'button', 'mediathek-btn mediathek-btn-primary');
    play.type = 'button';
    play.id = 'mediathekSeriesPlay';
    const playIcon = el(doc, 'span');
    playIcon.setAttribute('aria-hidden', 'true');
    setIcon(playIcon, PLAY_SVG);
    play.append(playIcon, el(doc, 'span', '', page.playLabel()));
    const target = state.playTarget && state.playTarget.entry;
    play.disabled = !target;
    if (target) {
      play.setAttribute('aria-label', `${page.playLabel()}: ${target.title}`);
      play.addEventListener('click', () => ctx.play(target, series, play));
    }
    const fav = el(doc, 'button', 'mediathek-btn mediathek-fav-btn');
    fav.type = 'button';
    fav.id = 'mediathekSeriesFav';
    const favIcon = el(doc, 'span');
    favIcon.setAttribute('aria-hidden', 'true');
    setIcon(favIcon, state.favorite ? STAR_SVG : STAR_OUTLINE_SVG);
    fav.append(favIcon, el(doc, 'span', '', state.favorite ? 'In Meine Serien' : 'Merken'));
    fav.classList.toggle('is-on', state.favorite);
    fav.setAttribute('aria-pressed', String(state.favorite));
    fav.setAttribute('aria-label', state.favorite ? 'Aus Meine Serien entfernen' : 'Zu Meine Serien hinzufügen');
    fav.addEventListener('click', async () => {
      const result = await ctx.toggleFavorite(series);
      if (typeof result === 'boolean') page.setFavorite(result);
    });
    actions.append(play, fav);
    if (dl() && state.status === 'loaded') {
      actions.appendChild(downloadMenu(series));
      if (ctx.downloads.auto) actions.appendChild(autoButton(series));
      const count = el(doc, 'span', 'mediathek-dl-count mediathek-pill-inline');
      paintCount(count);
      actions.appendChild(count);
    }
    text.appendChild(actions);
    box.append(back, text);
    return box;
  }

  function seasonChips(state) {
    const bar = el(doc, 'div', 'mediathek-chips mediathek-season-chips');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Staffel');
    const make = (label, number) => {
      const chip = button(doc, 'mediathek-chip', label, () => {
        page.selectSeason(number);
        ctx.announce(number === null ? 'Alle Staffeln' : page.seasonLabel(number));
      });
      const on = state.selectedSeason === number;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
      chip.dataset.season = number === null ? 'all' : String(number);
      return chip;
    };
    bar.appendChild(make('Alle', null));
    state.seasonNumbers.forEach(number => bar.appendChild(make(page.seasonLabel(number), number)));
    return bar;
  }

  function sortControl(state) {
    const group = el(doc, 'div', 'mediathek-sort');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Sortierung');
    [
      { label: 'Älteste zuerst', value: false },
      { label: 'Neueste zuerst', value: true },
    ].forEach(option => {
      const btn = button(doc, 'mediathek-seg', option.label, () => page.setSort(option.value));
      btn.dataset.sort = option.value ? 'newest' : 'oldest';
      btn.classList.toggle('is-on', state.newestFirst === option.value);
      btn.setAttribute('aria-pressed', String(state.newestFirst === option.value));
      group.appendChild(btn);
    });
    return group;
  }

  function episodeRow(entry, series) {
    const blocked = ctx.isBlocked(entry.id);
    const item = el(doc, 'li', 'mediathek-episode');
    if (blocked) item.classList.add('is-blocked');
    item.dataset.entryId = entry.id;
    const main = el(doc, 'button', 'mediathek-episode-main');
    main.type = 'button';
    const sub = subtitleText(entry);
    main.setAttribute('aria-label', [entry.title, sub, minutesText(entry.duration), blocked ? 'nicht abrufbar' : 'abspielen'].filter(Boolean).join(', '));
    const text = el(doc, 'span', 'mediathek-episode-text');
    text.append(el(doc, 'span', 'mediathek-card-title', entry.title));
    if (sub) text.appendChild(el(doc, 'span', 'mediathek-card-sub', sub));
    main.append(createThumb(doc, { imageUrl: entry.imageUrl, title: entry.title, duration: entry.duration, geo: entry.regionRestricted, width: 480, fsk: entry.fsk, fskEntry: entry }), text);
    main.addEventListener('click', () => ctx.play(entry, series, main));
    const info = button(doc, 'mediathek-info-btn is-inline', 'i', () => ctx.openDetail(entry, series, info), `Details zu ${entry.title}`);
    if (dl() && !blocked) item.append(main, downloadButton(entry, series), info);
    else item.append(main, info);
    return item;
  }

  /** Selektor des fokussierten Bedienelements, um den Fokus nach dem Neuaufbau zurückzugeben. */
  function focusSelector() {
    const active = doc.activeElement;
    if (!active || !root.contains(active)) return null;
    if (active.id) return `#${active.id}`;
    if (active.dataset.sort) return `[data-sort="${active.dataset.sort}"]`;
    if (active.dataset.season) return `[data-season="${active.dataset.season}"]`;
    const row = active.closest('[data-entry-id]');
    if (row && row.dataset.entryId) return `[data-entry-id="${CSS.escape(row.dataset.entryId)}"] .${active.className.split(' ')[0]}`;
    return null;
  }

  /** Kopf-Badge nachführen, wenn nachgeladene Folgen eine (höhere) Einstufung bringen. */
  function refreshHeroFsk() {
    if (!page) return;
    const holder = root.querySelector('.mediathek-hero-fsk');
    if (!holder) return;
    const text = fskText(seriesFsk(page.snapshot().seasons));
    holder.textContent = '';
    if (text) holder.appendChild(el(doc, 'span', 'mediathek-fsk-badge', text));
    holder.hidden = !text;
  }
  if (ctx.fsk) ctx.fsk.onChange(refreshHeroFsk);

  function render() {
    if (!page) return;
    const state = page.snapshot();
    const selector = focusSelector();
    renderContent(state);
    observeSentinel();
    if (ctx.fsk) ctx.fsk.decorate(root, { max: 30 }); // Einstufung der sichtbaren Folgenzeilen nachladen (höchstens 30, zwei parallel)
    if (selector) {
      const target = root.querySelector(selector);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function renderContent(state) {
    root.textContent = '';
    root.setAttribute('aria-labelledby', 'mediathekSeriesTitle');
    root.appendChild(hero(state));
    if (state.status === 'loading' || state.status === 'idle') {
      const line = el(doc, 'div', 'mediathek-block mediathek-status');
      line.setAttribute('role', 'status');
      const spin = el(doc, 'span', 'mediathek-spinner');
      spin.setAttribute('aria-hidden', 'true');
      line.append(spin, el(doc, 'span', '', 'Folgen werden geladen …'));
      root.appendChild(line);
      return;
    }
    if (state.status === 'failed') {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', `Laden fehlgeschlagen: ${state.error}`), button(doc, 'mediathek-btn', 'Erneut versuchen', () => page.load()));
      root.appendChild(box);
      return;
    }
    const total = page.total();
    const more = page.canLoadMore();
    const head = el(doc, 'div', 'mediathek-episodes-head');
    const title = el(doc, 'h3', 'mediathek-group-title');
    title.append(el(doc, 'span', '', 'Folgen'), el(doc, 'span', 'mediathek-group-count', more ? `${total}+` : String(total)));
    head.append(title, sortControl(state));
    root.appendChild(head);
    if (page.showSeasonPicker()) root.appendChild(seasonChips(state));
    if (state.seasonStatus === 'loading') {
      root.appendChild(statusLine(`${page.seasonLabel(state.selectedSeason)} wird geladen …`));
      return;
    }
    if (state.seasonStatus === 'failed') {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', `Staffel konnte nicht geladen werden: ${state.seasonError}`), button(doc, 'mediathek-btn', 'Erneut versuchen', () => page.retrySeason()));
      root.appendChild(box);
      return;
    }
    if (total === 0) {
      root.appendChild(el(doc, 'p', 'mediathek-hint mediathek-empty', state.emptyNote || 'Keine Folgen verfügbar.'));
      if (state.emptyConnect && typeof ctx.openAccounts === 'function') {
        const connect = el(doc, 'button', 'mediathek-btn mediathek-connect', 'Konto verbinden');
        connect.type = 'button';
        connect.addEventListener('click', () => ctx.openAccounts());
        root.appendChild(connect);
      }
      return;
    }
    for (const season of page.visibleSeasons()) {
      const section = el(doc, 'section', 'mediathek-season');
      const heading = el(doc, 'h3', 'mediathek-season-title', page.seasonLabel(season.number));
      const list = el(doc, 'ul', 'mediathek-episode-list');
      season.entries.forEach(entry => list.appendChild(episodeRow(entry, state.series)));
      section.append(heading, list);
      root.appendChild(section);
    }
    if (more) root.appendChild(moreBlock(state));
  }

  function statusLine(text) {
    const line = el(doc, 'div', 'mediathek-block mediathek-status');
    line.setAttribute('role', 'status');
    const spin = el(doc, 'span', 'mediathek-spinner');
    spin.setAttribute('aria-hidden', 'true');
    line.append(spin, el(doc, 'span', '', text));
    return line;
  }

  /** Fuß der Folgenliste (ARD, lange Serien): Fortschritt, Nachladen-Knopf, Fehler mit „Erneut versuchen“; sichtbar nachgeladen wird auch beim Scrollen. */
  function moreBlock(state) {
    if (state.loadingMore) return statusLine(`Weitere Folgen werden geladen …${state.progress ? ` (${state.progress.loaded} von ${state.progress.total})` : ''}`);
    const box = el(doc, 'div', `mediathek-block ${state.moreError ? 'mediathek-error' : 'mediathek-more'}`);
    box.dataset.sentinel = '1';
    if (state.moreError) {
      box.setAttribute('role', 'alert');
      box.dataset.failed = '1';
      box.append(el(doc, 'span', '', `Weitere Folgen konnten nicht geladen werden: ${state.moreError}`), button(doc, 'mediathek-btn', 'Erneut versuchen', () => page.loadMore()));
      return box;
    }
    const label = state.progress ? `Weitere Folgen laden (${state.progress.loaded} von ${state.progress.total})` : 'Weitere Folgen laden';
    box.appendChild(button(doc, 'mediathek-btn', label, () => page.loadMore()));
    return box;
  }

  function observeSentinel() {
    if (observer) observer.disconnect();
    observer = null;
    const sentinel = root.querySelector('[data-sentinel]:not([data-failed])');
    const Observer = doc.defaultView && doc.defaultView.IntersectionObserver;
    if (!sentinel || !Observer) return;
    observer = new Observer(entries => {
      if (entries.some(entry => entry.isIntersecting) && page) page.loadMore();
    });
    observer.observe(sentinel);
  }

  return {
    enter,
    reload,
    render,
    snapshot: () => (page ? page.snapshot() : null),
    currentSeries: () => current,
    focusFirst() {
      const target = root.querySelector('#mediathekSeriesPlay:not(:disabled)') || root.querySelector('#mediathekSeriesBack');
      if (target) target.focus();
    },
    dispose() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (unsubscribeDownloads) unsubscribeDownloads();
      unsubscribeDownloads = null;
      if (observer) observer.disconnect();
      observer = null;
    },
    /** Favorit extern geändert (z. B. aus dem Detail-Fenster). */
    setFavorite(value) {
      if (page) page.setFavorite(value);
    },
  };
}

module.exports = { createMediathekSeriesView };
