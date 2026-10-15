// „Eigenen Feed hinzufügen“ (P3): Zustandsmodell Eingabe → „Feed prüfen“ (podcast:probe-feed) → Bestätigung → Abo. Kein DOM.
// Zustände: idle · probing · ready (Feed gelesen, wartet auf Bestätigung) · error. Abonniert wird erst nach confirm().

'use strict';

/**
 * options: { probe(url) → { ok, title, author, cover, description, episodeCount, error }, subscribe(feed) → Promise, onChange() }
 * getState(): { status, url, preview, message }
 */
function createFeedAddModel({ probe, subscribe, onChange = () => {} } = {}) {
  let status = 'idle';
  let url = '';
  let preview = null;
  let message = '';
  let seq = 0;

  const set = patch => {
    ({ status = status, url = url, preview = preview, message = message } = patch);
    onChange();
  };

  function setUrl(value) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (next === url) return;
    seq += 1; // laufende Prüfung gilt nicht mehr für diese Eingabe
    set({ status: 'idle', url: next, preview: null, message: '' });
  }

  async function check() {
    if (!url) {
      set({ status: 'error', message: 'Bitte eine Feed-Adresse eingeben.' });
      return;
    }
    if (status === 'probing') return;
    const mine = ++seq;
    const target = url;
    set({ status: 'probing', preview: null, message: 'Feed wird geprüft …' });
    let reply;
    try {
      reply = await probe(target);
    } catch (error) {
      reply = { ok: false, error: (error && error.message) || 'Feed konnte nicht geprüft werden' };
    }
    if (mine !== seq) return;
    if (reply && reply.ok) {
      const preview = { feedUrl: target, title: reply.title || target, author: reply.author || '', cover: reply.cover || null, description: reply.description || '', episodeCount: reply.episodeCount };
      set({ status: 'ready', preview, message: '' });
    } else {
      set({ status: 'error', preview: null, message: (reply && reply.error) || 'Feed konnte nicht gelesen werden' });
    }
  }

  /** Abonniert den geprüften Feed (nur im Zustand ready). Liefert das Ergebnis von subscribe oder null. */
  async function confirm() {
    if (status !== 'ready' || !preview) return null;
    const feed = preview;
    try {
      const result = await subscribe(feed);
      set({ status: 'idle', url: '', preview: null, message: '' });
      return result;
    } catch (error) {
      set({ status: 'error', message: (error && error.message) || 'Abo nicht möglich' });
      return null;
    }
  }

  function getState() {
    return { status, url, preview, message };
  }

  return { setUrl, check, confirm, getState };
}

module.exports = { createFeedAddModel };
