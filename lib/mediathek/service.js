'use strict';

// MediathekService (Port von MediathekService.swift): Seitenabrufe (Home, Suche mit Paging, Serien, Genres, Nachladen),
// Stream-Auflösung zum Abspielen und resolveForDownload. Der HTTP-Zugriff kommt als http = { getText } (http.js; Tests
// übergeben einen Ersatz). Kein Zustand, keine Electron-Abhängigkeit.

const parser = require('./parser.js');
const sources = require('./sources.js');
const { dedupe, withFields } = require('./util.js');
const { parseHlsMaster } = require('./hls-master.js');
const { ardDownloadInfo, zdfDownloadInfo, arteDownloadInfo, arteMasterStreams } = require('./download-info.js');
const { isValidArteApiUrl, arteGenrePageUrl } = require('./parser-arte.js');
const ardSeason = require('./ard-season.js');
const { accountNote } = require('./restrictions.js');

const MAX_ARTE_PAGES = 8; // Nachlade-Seiten je Zone
const MAX_ARTE_EPISODES = 300; // Folgen je Zone
const SEASON_CACHE_MS = 10 * 60 * 1000; // ARD-Staffellisten für Serien-Batches

function fetchFailed(cause) {
  return Object.assign(new Error('Mediathek konnte nicht geladen werden'), { code: 'fetchFailed', cause });
}

function invalidUrl() {
  return Object.assign(new Error('Ungültige Mediatheken-URL'), { code: 'invalidURL' });
}

/** Parser-Aufruf, dessen Fehler (ungültiges JSON) als "konnte nicht geladen werden" gemeldet werden. */
function parsed(run) {
  try {
    return run();
  } catch (error) {
    throw fetchFailed(error);
  }
}

function isArdGroupingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.ardmediathek.de' && url.pathname.startsWith('/page-gateway/pages/');
  } catch {
    return false;
  }
}

const UNAVAILABLE = { resolution: { kind: 'unavailable' }, regionRestricted: false };

/**
 * options: http ({ getText(url, { accept, auth }) }), auth (optional, Konten-Modul: accountState(sender), kein Token hier). Mit auth
 * wird eine Jugendschutz-Sperre (ARD, arte) bei angemeldetem Konto einmal mit dem Token des Kontos wiederholt.
 */
function createMediathekService({ http, auth = null }) {
  if (!http || typeof http.getText !== 'function') throw new Error('http fehlt');

  /**
   * Konto-Wiederholung bei Jugendschutz-Sperre: load(authSender) lädt die Stream-Info (mit Konto, wenn authSender gesetzt) und
   * liefert { done: true, value } (freigeschaltet), { done: false, value } (weiter gesperrt) oder wirft. Ergebnis:
   * { value, account } mit account: null (kein Konto-Sender) | 'signedOut' | 'expired' | 'unlocked' | 'blocked' | 'network' | 'error'.
   */
  async function retryWithAccount(sender, load) {
    const state = auth && typeof auth.accountState === 'function' ? auth.accountState(sender) : 'unsupported';
    if (state === 'unsupported') return { value: null, account: null };
    if (state === 'signedOut' || state === 'expired') return { value: null, account: state };
    try {
      // Token vorab auffrischen: schlägt das per Netz fehl, wäre der Abruf ohne Kopfzeilen ein Fehlalarm "auch mit Konto gesperrt"
      if (typeof auth.ensureFresh === 'function') await auth.ensureFresh(sender);
      if (auth.accountState(sender) === 'expired') return { value: null, account: 'expired' };
      if (typeof auth.tokenUsable === 'function' && !auth.tokenUsable(sender)) return { value: null, account: 'network' };
      const outcome = await load(sender);
      if (outcome.done) return { value: outcome.value, account: 'unlocked' };
      return { value: outcome.value, account: auth.accountState(sender) === 'expired' ? 'expired' : 'blocked' };
    } catch (error) {
      if (error && error.status === 401) return { value: null, account: 'expired' };
      return { value: null, account: 'error' };
    }
  }

  /** Adresse für den Wiederholungsabruf mit Konto (ARD: Parameter userId wie im Web-Client). */
  function personalized(sender, url) {
    return auth && typeof auth.personalizeUrl === 'function' ? auth.personalizeUrl(sender, url) : url;
  }

  /** Startseite einer Quelle als benannte Abschnitte. */
  async function fetchHomeSections(sourceId) {
    const body = await http.getText(sources.homeUrl(sourceId));
    return parsed(() => parser.parseSections(body, sourceId));
  }

  /** Eine Suchseite { series, entries, page, hasMore }; ARD pagt (0-basiert), ZDF/arte liefern nur Seite 0. */
  async function searchPage(query, sourceId, page = 0) {
    if (sourceId !== 'ard' && page > 0) return { series: [], entries: [], page, hasMore: false };
    const body = await http.getText(sources.searchUrl(query, sourceId, page));
    return parsed(() => parser.parseSearchPage(body, sourceId, page));
  }

  /** Eine Zone samt Nachladeseiten (begrenzt); Fehler beim Nachladen beenden das Nachladen still. */
  async function arteZoneEntries(zone) {
    let entries = zone.entries;
    let next = zone.nextPage;
    let pages = 0;
    while (next && pages < MAX_ARTE_PAGES && entries.length < MAX_ARTE_EPISODES) {
      pages += 1;
      if (!isValidArteApiUrl(next)) break;
      let more;
      try {
        more = parser.parseArteMore(await http.getText(next), '');
      } catch {
        break;
      }
      entries = entries.concat(more.entries);
      next = more.nextPage;
    }
    return entries;
  }

  /** arte-Sammlung: mehrere Unterreihen = Staffeln (1, 2 ...); Folgen ohne Unterreihe bleiben ohne Staffel. */
  async function fetchArteEpisodes(series) {
    if (!isValidArteApiUrl(series.groupingURL)) throw invalidUrl();
    const body = await http.getText(series.groupingURL);
    const zones = parsed(() => parser.parseArteCollection(body));
    const subCount = zones.filter(zone => zone.isSubcollection).length;
    let subIndex = 0;
    const all = [];
    for (const zone of zones) {
      let season = null;
      if (zone.isSubcollection && subCount > 1) {
        subIndex += 1;
        season = subIndex;
      }
      for (const entry of await arteZoneEntries(zone)) all.push(withFields(entry, { season }));
    }
    return dedupe(all);
  }

  /** Folgen einer Serie (flach; mit groupBySeason nach Staffel gruppierbar). */
  async function fetchEpisodes(series) {
    if (!series || typeof series.groupingURL !== 'string') throw invalidUrl();
    if (series.sourceId === 'arte') return fetchArteEpisodes(series);
    if (series.sourceId !== 'ard' || !isArdGroupingUrl(series.groupingURL)) throw invalidUrl();
    const body = await http.getText(series.groupingURL);
    return parsed(() => parser.parseArdGrouping(body));
  }

  /**
   * Leere Folgenliste einer ARD-Serie: FSK-eingestufte Folgen liefert der Server tagsüber nicht in der Liste. Mit Konto wird
   * die Liste personalisiert (userId + X-Authorization wie bei der Wiedergabe) erneut abgerufen.
   * Ergebnis { entries, account }: account wie bei retryWithAccount (null = Sender ohne Konto-Unterstützung).
   */
  async function retryEmptySeries(series) {
    if (!series || series.sourceId !== 'ard' || !isArdGroupingUrl(series.groupingURL) || !auth) {
      return { entries: [], account: auth && typeof auth.accountState === 'function' && series ? plainAccount(series.sourceId) : null };
    }
    const { value, account } = await retryWithAccount('ard', async sender => {
      const again = parser.parseArdGrouping(await http.getText(personalized(sender, series.groupingURL), { auth: sender }));
      return { done: again.length > 0, value: again };
    });
    return { entries: account === 'unlocked' && Array.isArray(value) ? value : [], account };
  }

  /** Kontozustand eines Senders ohne Abruf: 'signedOut' | 'expired' | 'signedIn' bzw. null (nicht unterstützt). */
  function plainAccount(sender) {
    const state = auth.accountState(sender);
    return state === 'unsupported' ? null : state;
  }

  /** arte-Genre-Seite als Reihen. */
  async function fetchGenrePage(genre) {
    const url = genre && genre.sourceId === 'arte' ? arteGenrePageUrl(genre.id) : null;
    if (!url) throw invalidUrl();
    const body = await http.getText(url);
    return parsed(() => parser.parseArteGenrePage(body));
  }

  /** Nächste Seite einer arte-Reihe (section.nextPage); nur Emac-API-Adressen. */
  async function fetchMore(section) {
    if (!section || !section.nextPage || !isValidArteApiUrl(section.nextPage)) throw invalidUrl();
    const body = await http.getText(section.nextPage);
    return parsed(() => parser.parseArteMore(body, section.title));
  }

  /** Stream zum Abspielen mit Regionshinweis: { resolution: { kind, url?, rating? }, regionRestricted }. */
  async function resolveStreamDetail(entry) {
    if (entry && typeof entry.streamUrl === 'string' && entry.streamUrl) return { resolution: { kind: 'playable', url: entry.streamUrl }, regionRestricted: false };
    const url = sources.streamInfoUrl(entry);
    if (!url) return UNAVAILABLE;
    let body;
    try {
      body = await http.getText(url);
    } catch {
      return UNAVAILABLE;
    }
    const detail = parser.parseStreamDetail(body, entry.sourceId);
    if (detail.resolution.kind !== 'ageRestricted' || !auth) return detail;
    const { value, account } = await retryWithAccount(entry.sourceId, async sender => {
      const again = parser.parseStreamDetail(await http.getText(personalized(sender, url), { auth: sender }), entry.sourceId);
      return { done: again.resolution.kind === 'playable', value: again };
    });
    if (account === 'unlocked') return value;
    return account ? { ...detail, resolution: { ...detail.resolution, account } } : detail;
  }

  /** arte: HLS-Master zu den Streams der Player-Antwort laden (Fehler je Master -> null). */
  async function loadArteMasters(root) {
    return Promise.all(
      arteMasterStreams(root).map(async stream => {
        try {
          return { stream, parsed: parseHlsMaster(await http.getText(stream.url, { accept: '*/*' }), stream.url) };
        } catch {
          return null;
        }
      })
    );
  }

  const seasonCache = new Map(); // "<serie>|<staffel>" -> { at, entries } bzw. "<serie>" -> { at, seasons }

  async function cached(key, load, nowMs) {
    const hit = seasonCache.get(key);
    if (hit && nowMs - hit.at < SEASON_CACHE_MS) return hit.value;
    const value = await load();
    seasonCache.set(key, { at: nowMs, value });
    return value;
  }

  /** Alle Folgen einer ARD-Staffel (Seiten bis zur Grenze), aus dem Staffel-Widget. */
  async function loadArdSeason(series, season) {
    const all = [];
    for (let page = 0; ; page += 1) {
      const root = parser.toRoot(await http.getText(ardSeason.seasonAssetUrl(series.id, season, page)));
      all.push(...ardSeason.seasonEntries(root));
      if (!ardSeason.hasMorePages(root, page)) break;
    }
    return all;
  }

  /**
   * ARD: Staffel und Folgennummer einer Folge über die Staffel-Widgets der Serie (Spike §5). Rückgabe { season, episode } oder
   * null (keine Serie, Staffel nicht ermittelbar). Fehler beim Abruf ergeben null: der Titel-Regex bleibt der Rückfall.
   */
  async function ardSeasonOf(series, entry) {
    if (!series || series.sourceId !== 'ard' || !isArdGroupingUrl(series.groupingURL)) return null;
    const now = Date.now();
    try {
      const seasons = await cached(`${series.id}`, async () => ardSeason.availableSeasons(parser.toRoot(await http.getText(series.groupingURL))), now);
      for (const season of seasons) {
        const entries = await cached(`${series.id}|${season}`, () => loadArdSeason(series, season), now);
        const position = ardSeason.episodePosition(entries, entry.id);
        if (position !== null) return { season, episode: position };
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Alles, was ein Download braucht, frisch aus der Quelle (URLs nie aus dem Eintrag): { source, entryId, variants, audioTracks,
   * subtitles, restriction, availableUntil, season, episode, broadcastDate, seriesTitle, title, durationSeconds, isExtra }
   * (Felder siehe download-info.js). Netzwerkfehler beim Abruf der Stream-Info werden geworfen (Wiederholung), HTTP-Fehler
   * und unlesbare Antworten ergeben restriction 'unavailable'.
   */
  async function resolveForDownload(entry, { series = null } = {}) {
    const url = sources.streamInfoUrl(entry);
    const empty = restriction => ({ source: entry && entry.sourceId, entryId: entry && entry.id, variants: [], audioTracks: [], subtitles: [], restriction, availableUntil: (entry && entry.availableUntil) || null, season: (entry && entry.season) ?? null, episode: (entry && entry.episode) ?? null, broadcastDate: null, seriesTitle: null, title: (entry && entry.title) || null, durationSeconds: null, isExtra: false });
    if (!url) return empty({ code: 'unavailable', message: 'Dieser Beitrag kann nicht geladen werden.' });
    let root;
    try {
      root = parser.toRoot(await http.getText(url));
    } catch (error) {
      if (error && (error.code === 'network' || error.code === 'too-large')) throw error;
      return empty({ code: 'unavailable', message: 'Stream nicht verfügbar (abgelaufen oder vom Anbieter gesperrt).' });
    }
    const buildInfo = async data => {
      if (entry.sourceId === 'ard') return ardDownloadInfo(data, entry);
      if (entry.sourceId === 'zdf') return zdfDownloadInfo(data, entry);
      return arteDownloadInfo(data, entry, await loadArteMasters(data));
    };
    let info = await buildInfo(root);
    if (info.restriction && info.restriction.code === 'age' && auth) {
      const { value, account } = await retryWithAccount(entry.sourceId, async sender => {
        const again = await buildInfo(parser.toRoot(await http.getText(personalized(sender, url), { auth: sender })));
        return { done: !again.restriction, value: again };
      });
      if (account === 'unlocked') info = value;
      else if (account) info.restriction = { ...info.restriction, account, message: accountNote(info.restriction.message, account) };
    }
    if (entry.sourceId === 'ard' && info.season === null && series) {
      // Staffel steht bei der ARD nur im Staffel-Widget; eine im Titel gefundene Folgennummer (S05/E08) bleibt maßgeblich
      const found = await ardSeasonOf(series, entry);
      if (found) {
        info.season = found.season;
        if (info.episode === null) info.episode = found.episode;
      }
    }
    return { source: entry.sourceId, entryId: entry.id, ...info };
  }

  return { fetchHomeSections, searchPage, fetchEpisodes, retryEmptySeries, fetchGenrePage, fetchMore, resolveStreamDetail, resolveForDownload };
}

module.exports = { createMediathekService };
