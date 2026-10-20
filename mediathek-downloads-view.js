'use strict';

// Downloads-Bereich der Mediathek: zwei Ansichten – Warteschlange (Fortschritt, Tempo, Restzeit, Pause/Fortsetzen/Abbrechen/
// Wiederholen, Meldungen) und Bibliothek (Abspielen, im Dateimanager zeigen, Löschen mit Rückfrage). Dünne Ansicht über
// mediathek-downloads-model.js; Titel und Meldungen kommen ausschließlich per textContent in den DOM.

const model = require('./mediathek-downloads-model.js');
const { el, button, createThumb } = require('./mediathek-cards.js');

const TABS = [
  { id: 'queue', label: 'Warteschlange' },
  { id: 'library', label: 'Bibliothek' },
];

/**
 * ctx: { store (createDownloadsStore), announce(text), playLocal(info, item) -> Promise, confirmDelete(item) -> Promise<{confirmed, deleteFile}>,
 *        fileManager (Anzeigename, z. B. „Finder“), reload() }
 */
function createMediathekDownloadsView(root, ctx) {
  const doc = root.ownerDocument || document;
  const { store } = ctx;
  let tab = 'queue';
  let unsubscribe = null;
  let actionLabels = null;

  const fileManager = ctx.fileManager || 'Dateimanager';
  const labels = () => {
    if (!actionLabels) actionLabels = { ...model.ACTION_LABELS, reveal: `Im ${fileManager} zeigen`, remove: 'Entfernen' };
    return actionLabels;
  };

  function focusKey() {
    const active = doc.activeElement;
    if (!active || !root.contains(active)) return null;
    const row = active.closest('[data-id]');
    return { id: row ? row.dataset.id : '', action: active.dataset.action || '', tab: active.dataset.tab || '' };
  }

  function restoreFocus(key) {
    if (!key) return;
    let target = null;
    if (key.tab) target = root.querySelector(`[data-tab="${key.tab}"]`);
    else if (key.id) target = root.querySelector(`[data-id="${CSS.escape(key.id)}"] [data-action="${CSS.escape(key.action)}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  async function runAction(action, item) {
    const name = item.title;
    if (action === 'play') {
      const info = await store.playInfo(item.id);
      if (!info || !info.ok) {
        ctx.announce(`Wiedergabe nicht möglich: ${(info && info.message) || 'Die Datei ist nicht mehr vorhanden.'}`);
        store.load();
        return;
      }
      await ctx.playLocal(info, item);
      return;
    }
    if (action === 'remove' && item.status === 'done') {
      const choice = await ctx.confirmDelete(item);
      if (!choice || !choice.confirmed) return;
      const result = await store.remove(item.id, { deleteFile: choice.deleteFile });
      ctx.announce(result && result.ok ? `${name} gelöscht` : `${name} konnte nicht gelöscht werden`);
      return;
    }
    const result = await store[action](item.id, action === 'remove' ? { deleteFile: false } : undefined);
    if (!result || result.ok === false) {
      ctx.announce(`${labels()[action] || action} nicht möglich: ${(result && (result.message || result.error)) || 'Unbekannter Fehler'}`);
      return;
    }
    if (action === 'pause') ctx.announce(`${name} angehalten`);
    else if (action === 'resume') ctx.announce(`${name} wird fortgesetzt`);
    else if (action === 'cancel') ctx.announce(`${name} abgebrochen`);
    else if (action === 'retry') ctx.announce(`${name} wird erneut versucht`);
    else if (action === 'remove') ctx.announce(`${name} entfernt`);
  }

  function actionButtons(item, view) {
    const box = el(doc, 'div', 'mediathek-dl-actions');
    for (const action of view.actions) {
      const text = labels()[action];
      const btn = button(doc, `mediathek-btn mediathek-dl-btn${action === 'play' ? ' mediathek-btn-primary' : ''}`, text, () => runAction(action, item), `${text}: ${item.title}`);
      btn.dataset.action = action;
      box.appendChild(btn);
    }
    return box;
  }

  function progressBar(info, title) {
    const bar = el(doc, 'div', `mediathek-dl-bar${info.indeterminate ? ' is-indeterminate' : ''}`);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `Fortschritt: ${title}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    if (info.percent !== null && !info.indeterminate) bar.setAttribute('aria-valuenow', String(info.percent));
    const fill = el(doc, 'i');
    if (info.percent !== null && !info.indeterminate) fill.style.width = `${info.percent}%`;
    bar.appendChild(fill);
    return bar;
  }

  function queueRow(item) {
    const info = model.describeQueueItem(item);
    const li = el(doc, 'li', `mediathek-dl-item is-${item.status}`);
    li.dataset.id = item.id;
    li.dataset.status = item.status;
    const body = el(doc, 'div', 'mediathek-dl-body');
    body.append(el(doc, 'span', 'mediathek-card-title mediathek-dl-title', info.title), el(doc, 'span', 'mediathek-card-sub', info.subtitle));
    if (info.percent !== null || info.indeterminate) body.appendChild(progressBar(info, info.title));
    const state = el(doc, 'span', 'mediathek-dl-state', [info.statusLabel, info.detail].filter(Boolean).join(' · '));
    body.appendChild(state);
    if (info.message) {
      const note = el(doc, 'p', `mediathek-dl-msg is-${info.tone}`, info.message);
      if (info.tone === 'error') note.setAttribute('role', 'alert');
      body.appendChild(note);
    }
    for (const warning of info.warnings) body.appendChild(el(doc, 'p', 'mediathek-dl-msg is-warn', warning));
    li.append(createThumb(doc, { imageUrl: item.imageUrl, title: item.title, sourceId: item.sourceId, width: 320 }), body, actionButtons(item, info));
    return li;
  }

  function libraryRow(item) {
    const info = model.describeLibraryItem(item);
    const li = el(doc, 'li', `mediathek-dl-item is-done${info.missing ? ' is-missing' : ''}`);
    li.dataset.id = item.id;
    li.dataset.status = 'done';
    const body = el(doc, 'div', 'mediathek-dl-body');
    const head = el(doc, 'span', 'mediathek-dl-titlerow');
    head.appendChild(el(doc, 'span', 'mediathek-card-title mediathek-dl-title', info.title));
    if (info.watched) head.appendChild(el(doc, 'span', 'mediathek-dl-pill', 'Gesehen'));
    body.append(head, el(doc, 'span', 'mediathek-card-sub', info.subtitle));
    if (info.meta.length) body.appendChild(el(doc, 'span', `mediathek-dl-state${info.expired ? ' is-expired' : ''}`, info.meta.join(' · ')));
    if (info.missing) {
      const note = el(doc, 'p', 'mediathek-dl-msg is-error', 'Die Datei ist nicht mehr vorhanden. Du kannst den Eintrag entfernen.');
      note.setAttribute('role', 'alert');
      body.appendChild(note);
    }
    li.append(createThumb(doc, { imageUrl: item.imageUrl, title: item.title, sourceId: item.sourceId, duration: item.durationSec, width: 320 }), body, actionButtons(item, info));
    return li;
  }

  function emptyBlock(text) {
    const p = el(doc, 'p', 'mediathek-hint mediathek-empty', text);
    p.setAttribute('role', 'status');
    return p;
  }

  function render() {
    const key = focusKey();
    const snapshot = store.snapshot();
    root.textContent = '';
    const queue = store.queue();
    const library = store.library();

    const head = el(doc, 'div', 'mediathek-dl-head');
    const tabs = el(doc, 'div', 'mediathek-sort mediathek-dl-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Downloads-Ansicht');
    for (const entry of TABS) {
      const count = entry.id === 'queue' ? queue.length : library.length;
      const btn = button(doc, `mediathek-seg${tab === entry.id ? ' is-on' : ''}`, `${entry.label} (${count})`, () => {
        tab = entry.id;
        render();
        ctx.announce(`${entry.label} ausgewählt`);
      });
      btn.dataset.tab = entry.id;
      btn.setAttribute('aria-pressed', String(tab === entry.id));
      tabs.appendChild(btn);
    }
    const summary = el(doc, 'p', 'mediathek-dl-summary', model.summaryLine(snapshot.summary, snapshot.freeBytes));
    head.append(tabs, summary);
    root.appendChild(head);

    if (snapshot.error && !queue.length && !library.length) {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', snapshot.error), button(doc, 'mediathek-btn', 'Erneut versuchen', () => store.load()));
      root.appendChild(box);
      return;
    }
    if (!snapshot.loaded) {
      const line = el(doc, 'div', 'mediathek-block mediathek-status');
      line.setAttribute('role', 'status');
      const spin = el(doc, 'span', 'mediathek-spinner');
      spin.setAttribute('aria-hidden', 'true');
      line.append(spin, el(doc, 'span', '', 'Downloads werden geladen …'));
      root.appendChild(line);
      return;
    }

    const items = tab === 'queue' ? queue : library;
    if (!items.length) {
      root.appendChild(emptyBlock(tab === 'queue' ? 'Keine Downloads in der Warteschlange. Mit „Herunterladen“ bei einer Folge geht es los.' : 'Noch keine fertigen Downloads. Fertige Folgen erscheinen hier und lassen sich ohne Internet abspielen.'));
    } else {
      const list = el(doc, 'ul', 'mediathek-dl-list');
      list.setAttribute('aria-label', tab === 'queue' ? 'Warteschlange' : 'Bibliothek');
      items.forEach(item => list.appendChild(tab === 'queue' ? queueRow(item) : libraryRow(item)));
      root.appendChild(list);
    }
    restoreFocus(key);
  }

  return {
    render,
    /** Nach dem Einblenden: Ladezustand anstoßen und abonnieren. */
    enter() {
      if (!unsubscribe) unsubscribe = store.subscribe(() => root.isConnected && !root.closest('[hidden]') && render());
      store.load();
      render();
    },
    leave() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
    showTab(next) {
      if (TABS.some(entry => entry.id === next)) tab = next;
      render();
    },
    currentTab: () => tab,
    focusFirst() {
      const target = root.querySelector('.mediathek-seg.is-on') || root.querySelector('button');
      if (target) target.focus({ preventScroll: true });
    },
  };
}

module.exports = { createMediathekDownloadsView };
