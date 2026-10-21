'use strict';

// Detail-Fenster einer Folge (modaler Dialog): Beschreibung, Dauer, „Verfügbar bis“, Geo-/FSK-Hinweise, Abspielen, Merken
// (Serie) und – bei gesperrten Beiträgen – „Auf der Webseite öffnen“. Fokusfalle, Esc schließt, Fokus kehrt zurück.

const { detailInfo } = require('./mediathek-detail-model.js');
const { el, button, setIcon, PLAY_SVG, STAR_SVG, STAR_OUTLINE_SVG } = require('./mediathek-cards.js');
const { downloadIcon } = require('./mediathek-download-icons.js');

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * ctx: { play(entry, series, trigger), isBlocked(id) -> { reason, message, webUrl }|null, isFavorite(series), toggleFavorite(series) -> Promise<bool|null>,
 *        openWeb(url, title), canDownload() -> bool, download(entry, series, trigger), downloadState(entry) -> { state, percent } }
 */
function createMediathekDetail(host, ctx) {
  const doc = host.ownerDocument || document;
  let backdrop = null;
  let state = null;

  function close({ restoreFocus = true } = {}) {
    if (!backdrop) return;
    const trigger = state && state.trigger;
    backdrop.remove();
    backdrop = null;
    state = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...backdrop.querySelectorAll(FOCUSABLE)];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function render() {
    if (!state) return;
    const { entry, series } = state;
    const blocked = ctx.isBlocked(entry.id);
    const info = detailInfo(entry, { blocked, series });
    const hadFocus = backdrop.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
    const dialog = backdrop.querySelector('.mediathek-dialog');
    dialog.textContent = '';

    const closeBtn = button(doc, 'mediathek-dialog-close', '×', () => close(), 'Schließen');
    closeBtn.dataset.action = 'close';
    dialog.appendChild(closeBtn);
    dialog.appendChild(el(doc, 'p', 'mediathek-eyebrow', info.kicker));
    const title = el(doc, 'h2', 'mediathek-dialog-title', info.title);
    title.id = 'mediathekDetailTitle';
    dialog.appendChild(title);
    if (info.fsk) {
      const badges = el(doc, 'p', 'mediathek-dialog-badges');
      badges.appendChild(el(doc, 'span', 'mediathek-fsk-badge', info.fsk));
      dialog.appendChild(badges);
    }
    if (info.meta.length) dialog.appendChild(el(doc, 'p', 'mediathek-dialog-meta', info.meta.join('   ·   ')));
    if (info.availability) {
      const until = el(doc, 'p', 'mediathek-dialog-until', info.availability);
      until.id = 'mediathekDetailUntil';
      dialog.appendChild(until);
    }
    if (info.description) dialog.appendChild(el(doc, 'p', 'mediathek-dialog-desc', info.description));
    for (const hint of info.hints) {
      const note = el(doc, 'p', `mediathek-dialog-hint is-${hint.kind}`, hint.text);
      note.setAttribute('role', hint.kind === 'geo' && !blocked ? 'note' : 'alert');
      dialog.appendChild(note);
    }

    const actions = el(doc, 'div', 'mediathek-actions');
    if (info.canPlay) {
      const play = el(doc, 'button', 'mediathek-btn mediathek-btn-primary');
      play.type = 'button';
      play.id = 'mediathekDetailPlay';
      play.dataset.action = 'play';
      const icon = el(doc, 'span');
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, PLAY_SVG);
      play.append(icon, el(doc, 'span', '', 'Abspielen'));
      play.addEventListener('click', () => {
        const current = state;
        close({ restoreFocus: false });
        ctx.play(current.entry, current.series, current.trigger);
      });
      actions.appendChild(play);
    }
    if (!blocked && ctx.canDownload && ctx.canDownload()) {
      const st = ctx.downloadState ? ctx.downloadState(entry) : { state: 'none', percent: null };
      const busy = st.state !== 'none' && st.state !== 'failed';
      const dl = el(doc, 'button', 'mediathek-btn');
      dl.type = 'button';
      dl.id = 'mediathekDetailDownload';
      dl.dataset.action = 'download';
      const icon = el(doc, 'span');
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, downloadIcon(st.state === 'none' ? 'none' : st.state, st.percent));
      const text = { done: 'Heruntergeladen', running: 'Wird geladen', queued: 'In der Warteschlange', paused: 'Angehalten', scheduled: 'Zurückgestellt', failed: 'Erneut herunterladen' }[st.state] || 'Herunterladen';
      dl.append(icon, el(doc, 'span', '', text));
      dl.disabled = busy;
      dl.addEventListener('click', () => {
        const current = state;
        close({ restoreFocus: false });
        ctx.download(current.entry, current.series, current.trigger);
      });
      actions.appendChild(dl);
    }
    if (info.canFavorite) {
      const star = el(doc, 'button', 'mediathek-btn mediathek-fav-btn');
      star.type = 'button';
      star.id = 'mediathekDetailFav';
      star.dataset.action = 'fav';
      const favorite = ctx.isFavorite(series);
      const icon = el(doc, 'span', 'mediathek-star-icon');
      icon.setAttribute('aria-hidden', 'true');
      star.append(icon, el(doc, 'span', '', favorite ? 'In Meine Serien' : 'Merken'));
      setIcon(icon, favorite ? STAR_SVG : STAR_OUTLINE_SVG);
      star.classList.toggle('is-on', favorite);
      star.setAttribute('aria-pressed', String(favorite));
      star.setAttribute('aria-label', favorite ? `${series.title} aus Meine Serien entfernen` : `${series.title} zu Meine Serien hinzufügen`);
      star.addEventListener('click', async () => {
        await ctx.toggleFavorite(series);
        render();
      });
      actions.appendChild(star);
    }
    if (blocked && blocked.webUrl) {
      const web = button(doc, 'mediathek-btn', 'Auf der Webseite öffnen', () => {
        const url = blocked.webUrl;
        close({ restoreFocus: false });
        ctx.openWeb(url, entry.title);
      });
      web.dataset.action = 'web';
      actions.appendChild(web);
    }
    dialog.appendChild(actions);
    if (hadFocus) {
      const again = dialog.querySelector(`[data-action="${hadFocus}"]`);
      if (again) again.focus();
    }
  }

  /** Öffnet das Fenster für eine Folge. trigger: Element, das beim Schließen den Fokus zurückbekommt. */
  function open({ entry, series = null, trigger = null }) {
    close({ restoreFocus: false });
    state = { entry, series, trigger };
    backdrop = el(doc, 'div', 'mediathek-modal');
    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop) close();
    });
    backdrop.addEventListener('keydown', onKeydown);
    const dialog = el(doc, 'div', 'mediathek-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'mediathekDetailTitle');
    backdrop.appendChild(dialog);
    (doc.body || host).appendChild(backdrop); // außerhalb der Ansicht, damit der Hintergrund auch die Navigationsleiste abdunkelt
    render();
    const target = dialog.querySelector('#mediathekDetailPlay') || dialog.querySelector('[data-action="close"]');
    if (target) target.focus();
  }

  return { open, close, render, isOpen: () => Boolean(backdrop), currentEntry: () => (state ? state.entry : null) };
}

module.exports = { createMediathekDetail };
