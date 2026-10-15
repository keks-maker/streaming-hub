// Podcast-Oberfläche: Modell des Episoden-Overlays (Shownotes, Kapitel, Wiedergabe). Reine Funktionen ohne DOM und IPC.
// Die Shownotes kommen als bereinigter Baum aus dem Main (lib/podcast/shownotes-sanitizer.js); nur ältere Cache-Einträge ohne
// Baum liefern noch Klartext, der hier in Absätze zerlegt und von Steuerzeichen befreit wird.

'use strict';

const { episodeItem } = require('./podcast-episode-model.js');
const { currentChapter } = require('./lib/podcast/chapters.js');
const { formatChapterTime, formatDuration } = require('./podcast-format.js');

const MAX_NOTES_CHARS = 20000;
const MAX_PARAGRAPHS = 400;
const EMPTY_TREE = Object.freeze([]); // stabile Referenz, damit die Ansicht unverändertes Nichts nicht neu zeichnet

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Shownotes-Text -> Absätze (an Leerzeilen getrennt, einfache Zeilenumbrüche bleiben im Absatz). Nie HTML. */
function notesToParagraphs(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const clean = text.slice(0, MAX_NOTES_CHARS).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  return clean
    .split(/\n{2,}/)
    .map(part => part.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim())
    .filter(Boolean)
    .slice(0, MAX_PARAGRAPHS);
}

/**
 * options: { podcastId, episodeId, subscriptions, episodes (je Abo), player, now, details (Antwort von episode-details | null),
 *            detailsState ('loading'|'ready'|'error') }
 * Ausgabe: { found, item (Anzeigemodell der Episode), showTitle, cover, positionText, metaText, chapters [{ index, start, startText, title, current }],
 *            hasChapters, chapterNote, notes { state ('loading'|'ready'|'none'|'error'), tree, paragraphs, text }, playLabel, markLabel }
 */
function episodeOverlayModel({ podcastId, episodeId, subscriptions = [], episodes = {}, player = null, now = Date.now(), details = null, detailsState = 'loading' } = {}) {
  const sub = (subscriptions || []).find(entry => entry.id === podcastId) || null;
  const feed = (episodes && episodes[podcastId]) || { episodes: [] };
  const episode = feed.episodes.find(entry => entry && entry.id === episodeId) || null;
  if (!sub || !episode) return { found: false };
  const item = episodeItem({ podcastId, show: sub.title, episode, fallbackCover: sub.cover, player, now });
  const chapterList = details && Array.isArray(details.chapters) ? details.chapters : [];
  const position = item.active && player && Number.isFinite(player.position) ? player.position : Number(episode.state && episode.state.position) || 0;
  const current = item.active ? currentChapter(chapterList, position) : null;
  const tree = details && Array.isArray(details.notesTree) ? details.notesTree : EMPTY_TREE;
  const paragraphs = details && !tree.length ? notesToParagraphs(details.notes) : []; // Klartext nur, wenn kein Baum vorliegt (alter Cache)
  const hasNotes = tree.length > 0 || paragraphs.length > 0;
  let notesState = detailsState === 'error' ? 'error' : detailsState === 'loading' ? 'loading' : hasNotes ? 'ready' : 'none';
  if (!details && detailsState === 'ready') notesState = 'none';
  const durationText = formatDuration(Number(episode.state && episode.state.duration) || Number(episode.duration) || 0);
  return {
    found: true,
    item,
    showTitle: sub.title || '',
    cover: item.cover,
    metaText: [item.dateText, durationText, item.statusText].filter(Boolean).join(' · '),
    chapters: chapterList.map((chapter, index) => ({ index, start: chapter.start, startText: formatChapterTime(chapter.start), title: chapter.title, current: Boolean(current) && current.index === index })),
    hasChapters: chapterList.length > 0,
    chapterNote: current ? `Aktuell: ${current.chapter.title}` : '',
    notes: { state: notesState, tree, paragraphs, text: paragraphs.join('\n\n') },
    playLabel: { play: 'Abspielen', pause: 'Pausieren', resume: 'Fortsetzen' }[item.action],
    markLabel: item.markLabel,
  };
}

module.exports = { MAX_NOTES_CHARS, MAX_PARAGRAPHS, notesToParagraphs, episodeOverlayModel };
