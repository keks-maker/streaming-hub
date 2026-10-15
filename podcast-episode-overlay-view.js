// Podcast-Oberfläche: Episoden-Overlay (Dialog) mit Cover, Titel, Sendung, Datum, Dauer, Fortschritt, Play/Pause, „als gehört
// markieren“, Kapitelliste (nur wenn der Feed Kapitel liefert) und Shownotes (bereinigter Baum, podcast-shownotes-view.js).
// Fokusfalle, Esc schließt, aria-modal, der Fokus kehrt zum Auslöser zurück. Feed-Inhalte nie als HTML-Zeichenkette: Titel und Texte per
// textContent, Shownotes per createElement aus dem Baum; Links öffnet der Main nach Klick, Bilder lädt nur der Main.

'use strict';

const { episodeOverlayModel } = require('./podcast-overlay-model.js');
const { playEpisodeItem } = require('./podcast-episode-list-view.js');
const { createCover } = require('./podcast-cover-view.js');
const { renderShownotes } = require('./podcast-shownotes-view.js');

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>';
const FOCUSABLE = 'button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * ctx: { podcasts, data, details (podcast-details-cache.js), getPlayer(), now(), announce(text), notify(text), logger, openShow(podcastId) }
 * Ergebnis: { open({ podcastId, episodeId }, trigger), close(), isOpen(), render(), getKey() }
 */
function createEpisodeOverlay(doc, ctx) {
  const { podcasts, data, details, getPlayer, now, announce, notify, logger, openShow } = ctx;

  const backdrop = el(doc, 'div', 'podcast-overlay');
  backdrop.id = 'podcastOverlay';
  const dialog = el(doc, 'div', 'podcast-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const closeBtn = el(doc, 'button', 'podcast-dialog-close');
  closeBtn.type = 'button';
  closeBtn.id = 'podcastOverlayClose';
  closeBtn.setAttribute('aria-label', 'Schließen');
  closeBtn.title = 'Schließen (Esc)';
  closeBtn.textContent = '×';

  const head = el(doc, 'header', 'podcast-dialog-head');
  const cover = createCover(doc, { podcasts, className: 'podcast-cover-large' });
  const headText = el(doc, 'div', 'podcast-dialog-head-text');
  const showLink = el(doc, 'button', 'podcast-link');
  showLink.type = 'button';
  showLink.id = 'podcastOverlayShow';
  const title = el(doc, 'h2', 'podcast-dialog-title');
  title.id = 'podcastOverlayTitle';
  dialog.setAttribute('aria-labelledby', title.id);
  const meta = el(doc, 'p', 'podcast-dialog-meta');
  meta.id = 'podcastOverlayMeta';
  const progress = el(doc, 'span', 'podcast-progress');
  progress.setAttribute('aria-hidden', 'true');
  const bar = el(doc, 'span', 'podcast-progress-bar');
  progress.appendChild(bar);
  const actions = el(doc, 'div', 'podcast-show-actions');
  const play = el(doc, 'button', 'podcast-btn podcast-btn-primary podcast-dialog-play');
  play.type = 'button';
  play.id = 'podcastOverlayPlay';
  const playIcon = el(doc, 'span');
  playIcon.setAttribute('aria-hidden', 'true');
  const playText = el(doc, 'span');
  play.append(playIcon, playText);
  const mark = el(doc, 'button', 'podcast-btn');
  mark.type = 'button';
  mark.id = 'podcastOverlayMark';
  actions.append(play, mark);
  headText.append(showLink, title, meta, progress, actions);
  head.append(cover.element, headText);

  const body = el(doc, 'div', 'podcast-dialog-body');
  const chapterSection = el(doc, 'section', 'podcast-dialog-section');
  chapterSection.id = 'podcastOverlayChapters';
  const chapterHeading = el(doc, 'h3', 'podcast-section-title', 'Kapitel');
  chapterHeading.id = 'podcastOverlayChaptersHeading';
  chapterSection.setAttribute('aria-labelledby', chapterHeading.id);
  const chapterNote = el(doc, 'p', 'podcast-section-empty');
  const chapterList = el(doc, 'ol', 'podcast-chapter-list');
  chapterList.setAttribute('aria-label', 'Kapitel');
  chapterSection.append(chapterHeading, chapterNote, chapterList);
  const notesSection = el(doc, 'section', 'podcast-dialog-section');
  notesSection.id = 'podcastOverlayNotesSection';
  const notesHeading = el(doc, 'h3', 'podcast-section-title', 'Shownotes');
  notesHeading.id = 'podcastOverlayNotesHeading';
  notesSection.setAttribute('aria-labelledby', notesHeading.id);
  const notes = el(doc, 'div', 'podcast-notes');
  notes.id = 'podcastOverlayNotes';
  notes.tabIndex = 0; // scrollbar per Tastatur
  notes.setAttribute('aria-labelledby', notesHeading.id);
  notesSection.append(notesHeading, notes);
  body.append(chapterSection, notesSection);

  dialog.append(closeBtn, head, body);
  backdrop.appendChild(dialog);

  let key = null; // { podcastId, episodeId }
  let trigger = null;
  let detailsState = 'loading';
  let detailsValue = null;
  let token = 0;
  let chaptersSignature = '';
  let notesSignature = '';
  let notesTree = null;
  let notesRender = null; // laufende Shownotes-Darstellung (Bilder-Warteschlange)
  let loadImages = true; // Einstellung „Bilder in Shownotes laden“
  const chapterButtons = [];

  const report = (message, error) => {
    if (logger) logger.warn(`Podcast-Overlay: ${message}`, error && error.message ? error.message : error || '');
    if (notify) notify(message);
  };
  async function run(fn, message) {
    try {
      await fn();
    } catch (error) {
      report(`Podcast: ${error && error.message ? error.message : message}`, error);
    }
  }

  function model() {
    const snap = data.snapshot();
    return episodeOverlayModel({ podcastId: key.podcastId, episodeId: key.episodeId, subscriptions: snap.subscriptions, episodes: snap.episodes, player: getPlayer(), now: now(), details: detailsValue, detailsState });
  }

  function renderChapters(m) {
    chapterSection.hidden = !m.hasChapters;
    if (!m.hasChapters) {
      chaptersSignature = '';
      return;
    }
    const signature = m.chapters.map(chapter => `${chapter.start}|${chapter.title}`).join('\n');
    if (signature !== chaptersSignature) {
      chaptersSignature = signature;
      chapterList.textContent = '';
      chapterButtons.length = 0;
      for (const chapter of m.chapters) {
        const li = el(doc, 'li', 'podcast-chapter');
        const button = el(doc, 'button', 'podcast-chapter-btn');
        button.type = 'button';
        button.dataset.start = String(chapter.start);
        button.append(el(doc, 'span', 'podcast-chapter-time', chapter.startText), el(doc, 'span', 'podcast-chapter-title', chapter.title));
        button.setAttribute('aria-label', `${chapter.title}, ab ${chapter.startText} – hier abspielen`);
        button.addEventListener('click', () => run(() => podcasts.player.play({ podcastId: key.podcastId, episodeId: key.episodeId }, chapter.start), 'Sprung nicht möglich'));
        li.appendChild(button);
        chapterList.appendChild(li);
        chapterButtons.push(button);
      }
    }
    m.chapters.forEach((chapter, index) => {
      const button = chapterButtons[index];
      if (!button) return;
      button.parentElement.classList.toggle('is-current', chapter.current);
      if (chapter.current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    chapterNote.textContent = m.chapterNote;
    chapterNote.hidden = !m.chapterNote;
  }

  function disposeNotes() {
    if (notesRender) notesRender.dispose();
    notesRender = null;
  }

  function renderNotes(m) {
    const signature = `${m.notes.state}\u0000${m.notes.text}\u0000${loadImages}`;
    if (signature === notesSignature && m.notes.tree === notesTree) return;
    notesSignature = signature;
    notesTree = m.notes.tree;
    disposeNotes();
    notes.textContent = '';
    if (m.notes.state === 'ready') {
      if (m.notes.tree.length) {
        const current = key;
        notesRender = renderShownotes(doc, m.notes.tree, {
          loadImages,
          openLink: url => run(async () => {
            const reply = await podcasts.openLink(url);
            if (!reply || reply.ok !== true) throw new Error('Link konnte nicht geöffnet werden');
          }, 'Link konnte nicht geöffnet werden'),
          getImage: url => podcasts.getShownoteImage({ podcastId: current.podcastId, episodeId: current.episodeId, url }),
        });
        notes.appendChild(notesRender.element);
      } else {
        for (const paragraph of m.notes.paragraphs) notes.appendChild(el(doc, 'p', 'podcast-notes-paragraph', paragraph)); // Klartext (alter Cache)
      }
      return;
    }
    const text = { loading: 'Shownotes werden geladen …', error: 'Shownotes konnten nicht geladen werden.', none: 'Zu dieser Episode gibt es keine Shownotes.' }[m.notes.state];
    notes.appendChild(el(doc, 'p', 'podcast-section-empty', text));
  }

  function render() {
    if (!key) return;
    const m = model();
    if (!m.found) {
      close();
      return;
    }
    const item = m.item;
    cover.update({ url: m.cover, initial: (m.showTitle || item.title).trim().slice(0, 1).toUpperCase() || '?' });
    showLink.textContent = m.showTitle;
    showLink.hidden = !m.showTitle;
    showLink.setAttribute('aria-label', `${m.showTitle}: Sendung öffnen`);
    title.textContent = item.title;
    meta.textContent = m.metaText;
    const showBar = item.progress > 0 && item.status !== 'played';
    progress.hidden = !showBar;
    bar.style.width = `${Math.round(item.progress * 100)}%`;
    const icon = item.action === 'pause' ? ICON_PAUSE : ICON_PLAY;
    if (play.dataset.icon !== item.action) {
      play.dataset.icon = item.action;
      playIcon.innerHTML = icon; // statisches SVG
    }
    playText.textContent = m.playLabel;
    play.dataset.action = item.action;
    play.setAttribute('aria-label', `${item.title}: ${m.playLabel}`);
    mark.textContent = m.markLabel;
    mark.setAttribute('aria-pressed', item.markPlayed ? 'false' : 'true');
    renderChapters(m);
    renderNotes(m);
  }

  function focusables() {
    return Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(node => !node.closest('[hidden]'));
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // nicht an die globale Esc-Behandlung (Navigation) weiterreichen
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) {
      event.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener('keydown', onKeydown);
  backdrop.addEventListener('mousedown', event => {
    if (event.target === backdrop) close();
  });
  closeBtn.addEventListener('click', () => close());
  play.addEventListener('click', () => {
    const m = key && model();
    if (m && m.found) run(() => playEpisodeItem(podcasts.player, m.item), 'Wiedergabe nicht möglich');
  });
  mark.addEventListener('click', () => {
    const m = key && model();
    if (!m || !m.found) return;
    const item = m.item;
    run(async () => {
      await podcasts.setPlayed({ podcastId: item.podcastId, episodeId: item.episodeId, played: item.markPlayed });
      announce(item.markPlayed ? `${item.title} als gehört markiert` : `${item.title} als ungehört markiert`);
    }, 'Status nicht änderbar');
  });
  showLink.addEventListener('click', () => {
    const id = key && key.podcastId;
    close({ restoreFocus: false });
    if (id) openShow(id);
  });

  /** Einstellung „Bilder in Shownotes laden“ (Standard an; bei Lesefehler an). */
  async function imageSetting() {
    try {
      const settings = typeof podcasts.getSettings === 'function' ? await podcasts.getSettings() : null;
      return !settings || settings.loadShownoteImages !== false;
    } catch {
      return true;
    }
  }

  function open(next, opener = null) {
    if (!next || typeof next.podcastId !== 'string' || typeof next.episodeId !== 'string') return;
    key = { podcastId: next.podcastId, episodeId: next.episodeId };
    trigger = opener || (doc.activeElement !== doc.body ? doc.activeElement : null);
    detailsState = 'loading';
    detailsValue = null;
    chaptersSignature = '';
    notesSignature = '';
    notesTree = null;
    disposeNotes();
    const mine = ++token;
    if (!backdrop.isConnected) doc.body.appendChild(backdrop);
    const first = model();
    if (!first.found) {
      close();
      return;
    }
    render();
    dialog.scrollTop = 0;
    body.scrollTop = 0;
    play.focus();
    Promise.all([Promise.resolve(details.get(key.podcastId, key.episodeId)), imageSetting()])
      .then(([value, images]) => {
        if (mine !== token) return;
        loadImages = images;
        detailsValue = value;
        detailsState = 'ready';
        render();
      })
      .catch(error => {
        if (mine !== token) return;
        detailsState = 'error';
        if (logger) logger.warn('Podcast-Overlay: Details nicht lesbar', error && error.message ? error.message : error || '');
        render();
      });
  }

  function close({ restoreFocus = true } = {}) {
    if (!key) return;
    key = null;
    token += 1;
    disposeNotes();
    const back = trigger;
    trigger = null;
    if (backdrop.isConnected) backdrop.remove();
    if (restoreFocus && back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  return { open, close, render, isOpen: () => Boolean(key), getKey: () => key };
}

module.exports = { createEpisodeOverlay };
