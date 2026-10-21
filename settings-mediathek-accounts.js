'use strict';

// Einstellungen ▸ Mediatheken ▸ Konten (experimentell): je Sender eine Karte mit Status, Anmelden/Abmelden und
// "Freischaltung testen". Die Anmeldung läuft im Anbieter-Fenster des Main-Prozesses; hier gibt es nie Passwörter.

const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');
const { describeAccount, GENERAL_HINT, STORAGE_NOTE } = require('./settings-mediathek-accounts-model.js');

function createMediathekAccountsView(root, { mediathek, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const accounts = mediathek.accounts;
  const busy = new Set();
  let current = { accounts: [], persistent: false };
  const cards = new Map();

  const intro = el(doc, 'p', 'settings-field-hint', GENERAL_HINT);
  intro.id = 'settingsMediathekAccountsIntro';
  const storageNote = el(doc, 'p', 'settings-field-hint');
  const list = el(doc, 'div', 'settings-row settings-row-stack');
  list.setAttribute('role', 'list');
  const statusEl = statusLine(doc, 'settingsMediathekAccountsStatus');
  root.textContent = '';
  root.append(intro, storageNote, list, statusEl);

  function button(label, id, onClick) {
    const node = el(doc, 'button', 'settings-btn settings-account-btn', label);
    node.type = 'button';
    node.id = id;
    node.addEventListener('click', onClick);
    return node;
  }

  function buildCard(sender) {
    const card = el(doc, 'div', 'settings-account-card');
    card.setAttribute('role', 'listitem');
    card.dataset.sender = sender;
    const title = el(doc, 'h5', 'settings-card-title settings-account-title');
    const badge = el(doc, 'span', 'settings-badge', 'experimentell');
    const state = el(doc, 'p', 'settings-field-hint');
    state.id = `settingsMediathekAccount-${sender}-state`;
    const hint = el(doc, 'p', 'settings-field-hint');
    const login = button('Anmelden', `settingsMediathekAccount-${sender}-login`, () => run(sender, 'login'));
    const logout = button('Abmelden', `settingsMediathekAccount-${sender}-logout`, () => run(sender, 'logout'));
    const test = button('Freischaltung testen', `settingsMediathekAccount-${sender}-test`, () => run(sender, 'test'));
    for (const node of [login, logout, test]) node.setAttribute('aria-describedby', state.id);
    const actions = el(doc, 'div', 'settings-account-actions');
    actions.append(login, logout, test);
    card.append(title, badge, state, hint, actions);
    cards.set(sender, { card, title, badge, state, hint, login, logout, test, actions });
    return card;
  }

  function renderCards() {
    for (const account of current.accounts) {
      if (!cards.has(account.sender)) list.append(buildCard(account.sender));
      const parts = cards.get(account.sender);
      const info = describeAccount(account, { busy: busy.has(account.sender) });
      parts.title.textContent = info.title;
      parts.badge.hidden = !info.badge;
      parts.state.textContent = info.statusText;
      parts.state.dataset.kind = info.statusKind;
      parts.hint.textContent = info.hint;
      parts.login.textContent = info.loginLabel;
      parts.login.hidden = !info.supported;
      parts.logout.hidden = !info.supported;
      parts.test.hidden = !info.supported;
      parts.login.disabled = !info.canLogin;
      parts.logout.disabled = !info.canLogout;
      parts.test.disabled = !info.canTest;
    }
    storageNote.textContent = current.persistent ? STORAGE_NOTE.persistent : STORAGE_NOTE.memoryOnly;
  }

  function show(status) {
    current = {
      accounts: Array.isArray(status.accounts) ? status.accounts : [],
      persistent: status.persistent === true,
    };
    renderCards();
  }

  async function call(run, successText) {
    try {
      const result = await run();
      if (result && result.status) show(result.status);
      if (result && result.ok === false) return setStatus(statusEl, result.message || 'Das hat nicht geklappt.', true);
      setStatus(statusEl, successText || (result && result.message) || '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Konten:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  async function run(sender, action) {
    busy.add(sender);
    renderCards();
    setStatus(statusEl, action === 'login' ? 'Anbieter-Fenster geöffnet: dort anmelden …' : action === 'test' ? 'Prüfe …' : 'Melde ab …');
    try {
      if (action === 'login') await call(() => accounts.login(sender), 'Angemeldet. Beiträge, die der Anbieter für dich freigibt, sind jetzt abrufbar.');
      else if (action === 'logout') await call(() => accounts.logout(sender), 'Abgemeldet. Sitzungsdaten wurden gelöscht.');
      else await call(() => accounts.test(sender), null);
    } finally {
      busy.delete(sender);
      renderCards();
    }
  }

  async function refresh() {
    try {
      const status = await accounts.status();
      show(status);
      setStatus(statusEl, '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Konten konnten nicht geladen werden:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  if (typeof accounts.onChanged === 'function') accounts.onChanged(status => show(status));

  return { refresh, show };
}

module.exports = { createMediathekAccountsView };
