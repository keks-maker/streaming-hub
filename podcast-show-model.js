// Podcast-Sendungsseite (P3): Modell für Kopf (Cover, Titel, Autor, Beschreibung, Abo-Knopf) und Episodenliste. Reine
// Funktionen ohne DOM und IPC. Ohne Abo (Vorschau aus Suche oder Feed-Prüfung) gibt es nur den Kopf; die Episodenliste liefert
// der Main erst nach dem Abonnieren (Cache der Feed-Aktualisierung).

'use strict';

const { episodeItem, episodeStatus } = require('./podcast-episode-model.js');
const { formatAgo, initialOf, plural } = require('./podcast-format.js');

const PAGE_SIZE = 50;
const VIRTUAL_THRESHOLD = 200; // ab hier wäre eine virtuelle Liste nötig; der Feed-Cache hält höchstens 50 Episoden je Abo

/**
 * options: { id, subscription (Abo mit feed-Zustand) | null, feed ({ episodes, channel, fetchedAt }) | null,
 *            preview ({ title, author, cover, description, episodeCount }) | null, player, limit, now, loading }
 * Ausgabe: { id, subscribed, title, author, description, cover, initial, errorText, checkedText, episodes, total,
 *            shown, hasMore, moreLabel, unheard, canMarkAll, emptyText, previewNote, subscribeLabel, subscribeAria }
 */
function podcastShowModel({ id, subscription = null, feed = null, preview = null, player = null, limit = PAGE_SIZE, now = Date.now(), loading = false } = {}) {
  const subscribed = Boolean(subscription);
  const channel = (feed && feed.channel) || {};
  const title = (subscription && subscription.title) || (preview && preview.title) || channel.title || '';
  const author = (subscription && subscription.author) || (preview && preview.author) || channel.author || '';
  const description = channel.description || (preview && preview.description) || '';
  const cover = (subscription && subscription.cover) || (preview && preview.cover) || channel.cover || null;
  const list = subscribed && feed && Array.isArray(feed.episodes) ? feed.episodes : [];
  const items = list.map(episode => episodeItem({ podcastId: id, show: title, episode, fallbackCover: cover, player, now }));
  const shown = Math.min(items.length, Math.max(PAGE_SIZE, limit));
  const unheard = list.filter(episode => episodeStatus(episode) !== 'played').length;
  const lastError = (subscription && subscription.feed && subscription.feed.lastError) || '';
  const lastChecked = subscription && subscription.feed ? subscription.feed.lastChecked : null;
  let emptyText = '';
  if (subscribed && !items.length) emptyText = loading ? 'Episoden werden geladen …' : lastError ? 'Es liegen keine Episoden vor.' : 'Noch keine Episoden geladen. Mit „Jetzt aktualisieren“ im Dashboard prüfst du den Feed.';
  let previewNote = '';
  if (!subscribed) {
    const count = preview && Number.isFinite(preview.episodeCount) ? preview.episodeCount : null;
    previewNote = `${count === null ? 'Vorschau' : `Vorschau: ${plural(count, 'Episode', 'Episoden')} im Feed`}. Die Episodenliste erscheint nach dem Abonnieren.`;
  }
  return {
    id,
    subscribed,
    title: title || 'Podcast',
    author,
    description,
    cover,
    initial: initialOf(title),
    errorText: lastError ? `Der Feed ist nicht erreichbar: ${lastError}` : '',
    checkedText: subscribed && lastChecked ? `Geprüft ${formatAgo(lastChecked, now)}` : '',
    episodes: items.slice(0, shown),
    total: items.length,
    shown,
    hasMore: shown < items.length,
    moreLabel: `Mehr laden (${items.length - shown} weitere)`,
    unheard,
    canMarkAll: unheard > 0,
    emptyText,
    previewNote,
    subscribeLabel: subscribed ? 'Abbestellen' : 'Abonnieren',
    subscribeAria: subscribed ? `${title || 'Podcast'} abbestellen` : `${title || 'Podcast'} abonnieren`,
  };
}

module.exports = { PAGE_SIZE, VIRTUAL_THRESHOLD, podcastShowModel };
