'use strict';

// Downloads-Bereich der Mediathek: drei Ansichten – Warteschlange (Fortschritt, Tempo, Restzeit, Pause/Fortsetzen/Abbrechen/
// Wiederholen, Meldungen), Bibliothek (Abspielen, im Dateimanager zeigen, Löschen mit Rückfrage) und Abos (Serien, deren neue
// Folgen automatisch geladen werden). Dünne Ansicht über
// mediathek-downloads-model.js; Titel und Meldungen kommen ausschließlich per textContent in den DOM.

const model = require('./mediathek-downloads-model.js');
const subsModel = require('./mediathek-subscriptions-model.js');
const { el, button, createThumb } = require('./mediathek-cards.js');

const TABS = [
  { id: 'queue', label: 'Warteschlange' },
  { id: 'library', label: 'Bibliothek' },
  { id: 'subs', label: 'Abos' },
];

/**
 * ctx: { store (createDownloadsStore), announce(text), playLocal(info, item) -> Promise, confirmDelete(item) -> Promise<{confirmed, deleteFile}>,
 *        fileManager (Anzeigename, z. B. „Finder“), reload(),
 *        subs? { store (createSubscriptionsStore), openOptions(sub, trigger), openSeries(series, trigger) } }
 */
function createMediathekDownloadsView(root, ctx) {
  const doc = root.ownerDocument || document;
  const { store } = ctx;
  let tab = 'queue';
  let unsubscribe = null;
  let unsubscribeSubs = null;
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
    li.append(createThumb(doc, { imageUrl: item.imageUrl, title: item.title, sourceId: item.sourceId, width: 320, fsk: info.fsk }), body, actionButtons(item, info));
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
    li.append(createThumb(doc, { imageUrl: item.imageUrl, title: item.title, sourceId: item.sourceId, duration: item.durationSec, width: 320, fsk: info.fsk }), body, actionButtons(item, info));
    return li;
  }

  // ── Abos ──

  async function runSubAction(action, sub, trigger) {
    const subs = ctx.subs.store;
    if (action === 'toggle') {
      const result = await subs.update({ id: sub.id, enabled: !sub.enabled });
      ctx.announce(result && result.ok ? `${sub.title}: automatisches Laden ${sub.enabled ? 'pausiert' : 'aktiv'}` : `${sub.title} konnte nicht geändert werden`);
    } else if (action === 'check') {
      ctx.announce(`${sub.title} wird geprüft`);
      ctx.announce(subsModel.checkResultText(await subs.checkNow(sub.id)));
    } else if (action === 'options') {
      ctx.subs.openOptions(sub, trigger);
    } else if (action === 'remove') {
      const result = await subs.remove(sub.id);
      ctx.announce(result && result.ok ? `Abo ${sub.title} entfernt` : `Abo ${sub.title} konnte nicht entfernt werden`);
    }
  }

  function subRow(sub, snapshot) {
    const info = subsModel.describeSubscription(sub, { globalEnabled: snapshot.enabled });
    const li = el(doc, 'li', `mediathek-dl-item mediathek-sub-item${info.enabled ? '' : ' is-paused'}`);
    li.dataset.id = sub.id;
    li.dataset.enabled = String(info.enabled);
    const body = el(doc, 'div', 'mediathek-dl-body');
    const title = el(doc, 'span', 'mediathek-card-title mediathek-dl-title', info.title);
    body.append(title, el(doc, 'span', 'mediathek-card-sub', info.subtitle));
    const lines = [info.checkedText];
    const next = info.enabled && snapshot.enabled ? subsModel.untilTime(snapshot.nextCheckAt) : null;
    if (next) lines.push(`Nächste Prüfung: ${next}`);
    body.appendChild(el(doc, 'span', 'mediathek-dl-state', lines.join(' · ')));
    const result = el(doc, 'p', `mediathek-dl-msg is-${info.tone}`, info.resultText);
    if (info.tone === 'error') result.setAttribute('role', 'alert');
    body.appendChild(result);
    for (const note of info.notes) body.appendChild(el(doc, 'p', 'mediathek-dl-msg is-warn', note));
    body.appendChild(el(doc, 'span', 'mediathek-dl-state', `Optionen: ${info.optionsText}`));

    const actions = el(doc, 'div', 'mediathek-dl-actions');
    const toggle = button(doc, `mediathek-btn mediathek-dl-btn mediathek-switch${info.enabled ? ' is-on' : ''}`, info.enabled ? 'Aktiv' : 'Pausiert', () => runSubAction('toggle', sub, toggle), `Neue Folgen automatisch laden: ${info.title}`);
    toggle.dataset.action = 'toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(info.enabled));
    const check = button(doc, 'mediathek-btn mediathek-dl-btn', 'Jetzt prüfen', () => runSubAction('check', sub, check), `Jetzt prüfen: ${info.title}`);
    check.dataset.action = 'check';
    check.disabled = !info.enabled || !snapshot.enabled || snapshot.checking;
    const opts = button(doc, 'mediathek-btn mediathek-dl-btn', 'Optionen', () => runSubAction('options', sub, opts), `Abo-Optionen: ${info.title}`);
    opts.dataset.action = 'options';
    const remove = button(doc, 'mediathek-btn mediathek-dl-btn', 'Entfernen', () => runSubAction('remove', sub, remove), `Abo entfernen: ${info.title}`);
    remove.dataset.action = 'remove';
    actions.append(toggle, check, opts, remove);
    li.append(createThumb(doc, { imageUrl: sub.imageUrl, title: sub.title, sourceId: sub.sourceId, width: 320 }), body, actions);
    return li;
  }

  function renderSubs() {
    const subs = ctx.subs.store;
    const snapshot = subs.snapshot();
    if (snapshot.error && !snapshot.items.length) {
      const box = el(doc, 'div', 'mediathek-block mediathek-error');
      box.setAttribute('role', 'alert');
      box.append(el(doc, 'span', '', snapshot.error), button(doc, 'mediathek-btn', 'Erneut versuchen', () => subs.load()));
      root.appendChild(box);
      return;
    }
    if (!snapshot.loaded) {
      const line = el(doc, 'div', 'mediathek-block mediathek-status');
      line.setAttribute('role', 'status');
      line.append(el(doc, 'span', '', 'Abos werden geladen …'));
      root.appendChild(line);
      return;
    }
    const bar = el(doc, 'div', 'mediathek-dl-head mediathek-sub-head');
    const text = el(doc, 'p', 'mediathek-dl-summary', subsModel.headline(snapshot));
    text.id = 'mediathekSubsHeadline';
    text.setAttribute('role', 'status');
    const all = button(doc, 'mediathek-btn', snapshot.checking ? 'Wird geprüft …' : 'Alle jetzt prüfen', async () => {
      ctx.announce('Die Abos werden geprüft');
      ctx.announce(subsModel.checkResultText(await subs.checkNow()));
    });
    all.id = 'mediathekSubsCheckAll';
    all.dataset.action = 'check-all';
    all.disabled = snapshot.checking || !snapshot.enabled || !subs.activeCount();
    bar.append(text, all);
    root.appendChild(bar);
    if (!snapshot.items.length) {
      root.appendChild(emptyBlock('Keine Abos. Schalte bei einer Serie „Neue Folgen automatisch laden“ ein, dann erscheint sie hier.'));
      return;
    }
    const list = el(doc, 'ul', 'mediathek-dl-list');
    list.setAttribute('aria-label', 'Abos');
    snapshot.items.forEach(sub => list.appendChild(subRow(sub, snapshot)));
    root.appendChild(list);
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
    const subsCount = ctx.subs ? ctx.subs.store.all().length : 0;

    const head = el(doc, 'div', 'mediathek-dl-head');
    const tabs = el(doc, 'div', 'mediathek-sort mediathek-dl-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Downloads-Ansicht');
    for (const entry of TABS.filter(item => item.id !== 'subs' || ctx.subs)) {
      const count = entry.id === 'queue' ? queue.length : entry.id === 'library' ? library.length : subsCount;
      const btn = button(doc, `mediathek-seg${tab === entry.id ? ' is-on' : ''}`, `${entry.label} (${count})`, () => {
        tab = entry.id;
        render();
        ctx.announce(`${entry.label} ausgewählt`);
      });
      btn.dataset.tab = entry.id;
      btn.setAttribute('aria-pressed', String(tab === entry.id));
      tabs.appendChild(btn);
    }
    head.appendChild(tabs);
    if (tab !== 'subs') head.appendChild(el(doc, 'p', 'mediathek-dl-summary', model.summaryLine(snapshot.summary, snapshot.freeBytes)));
    root.appendChild(head);

    if (tab === 'subs' && ctx.subs) {
      renderSubs();
      restoreFocus(key);
      return;
    }

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
      const refresh = () => root.isConnected && !root.closest('[hidden]') && render();
      if (!unsubscribe) unsubscribe = store.subscribe(refresh);
      if (ctx.subs && !unsubscribeSubs) unsubscribeSubs = ctx.subs.store.subscribe(refresh);
      store.load();
      if (ctx.subs) ctx.subs.store.load();
      render();
    },
    leave() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (unsubscribeSubs) unsubscribeSubs();
      unsubscribeSubs = null;
    },
    showTab(next) {
      if (TABS.some(entry => entry.id === next && (entry.id !== 'subs' || ctx.subs))) tab = next;
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
