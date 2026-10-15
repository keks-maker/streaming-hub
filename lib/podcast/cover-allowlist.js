'use strict';

// Allowlist für podcast:cover (SSRF-Schutz): der Main lädt nur Cover-Adressen, die ihm aus eigenen Quellen bekannt sind:
// Abos und Overrides, mitgelieferter Katalog, Episoden-Cache (Episoden- und Kanal-Cover), aktuelle Wiedergabe sowie
// iTunes-Suchtreffer und Probe-Ergebnisse (per note() gemerkt, begrenzt). Alles andere wird ohne Netzabruf abgelehnt.

const MAX_NOTED = 400;

function createCoverAllowlist({ library, controller = null, maxNoted = MAX_NOTED } = {}) {
  const noted = new Set(); // Suchtreffer/Probe-Ergebnisse, älteste fallen heraus

  function note(url) {
    if (typeof url !== 'string' || !url) return;
    noted.delete(url);
    noted.add(url);
    if (noted.size > maxNoted) noted.delete(noted.values().next().value);
  }

  function noteAll(urls) {
    for (const url of urls) note(url);
  }

  function fromLibrary(url) {
    const subs = library.getSubscriptions();
    for (const sub of subs) {
      if (sub.cover === url) return true;
      if (sub.overrides && sub.overrides.cover === url) return true;
    }
    for (const source of library.getCatalog()) {
      if ((source.podcasts || []).some(entry => entry && entry.cover === url)) return true;
    }
    for (const sub of subs) {
      const feed = library.getCachedFeed(sub.id);
      if (feed.channel && feed.channel.cover === url) return true;
      if (feed.episodes.some(episode => episode && episode.cover === url)) return true;
    }
    return false;
  }

  function fromPlayback(url) {
    const episode = controller && controller.getState().episode;
    return Boolean(episode && episode.cover === url);
  }

  function has(url) {
    if (typeof url !== 'string' || !url) return false;
    if (noted.has(url) || fromPlayback(url)) return true;
    try {
      return fromLibrary(url);
    } catch {
      return false;
    }
  }

  return { has, note, noteAll };
}

module.exports = { createCoverAllowlist };
