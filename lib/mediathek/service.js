'use strict';

// MediathekService (Port von MediathekService.swift): Seitenabrufe (Home, Suche mit Paging, Serien, Genres, Nachladen),
// Stream-Auflösung zum Abspielen und resolveForDownload. Der HTTP-Zugriff kommt als http = { getText } (http.js; Tests
// übergeben einen Ersatz). Kein Zustand, keine Electron-Abhängigkeit.

const parser = require('./parser.js');
const sources = require('./sources.js');
const { dedupe, withFields } = require('./util.js');
const { parseHlsMaster } = require('./hls-master.js');
const { ardDownloadInfo, zdfDownloadInfo, arteDownloadInfo, arteMasterStreams } = require('./download-info.js');
const { isValidArteApiUrl, arteSubcollectionName } = require('./parser-arte.js');
const { isZdfDocumentUrl } = require('./parser-zdf.js');
const { genrePageUrl, isArdWidgetUrl } = require('./genre-pages.js');
const { mergeOriginalVersions } = require('./entries.js');
const ardSeason = require('./ard-season.js');
const { accountNote } = require('./restrictions.js');

const MAX_ARTE_PAGES = 12; // Nachlade-Seiten je Zone (mit limit=100: bis 1000 Folgen)
const MAX_ARTE_EPISODES = 1000; // Folgen je Zone
const ARTE_PAGE_LIMIT = 100; // größte Seitenlänge, die die Emac-API annimmt
const SEASON_CACHE_MS = 10 * 60 * 1000; // ARD-Staffellisten für Serien-Batches
const PAGE_CACHE_MS = 2 * 60 * 1000; // ARD-Folgenseiten (Nachladen auf der Serienseite, Mehrfachabrufe)
const CACHE_MAX = 400;
const MAX_ARD_EPISODES = 2000; // Obergrenze der Folgenliste einer ARD-Serie (Anzeige und Serien-Batches)
const MAX_ARD_PAGES = 45;
const RETRY_DELAYS_MS = [700, 2000]; // Wiederholungen bei vorübergehenden Fehlern (503/429/Zeitüberschreitung): höchstens zwei
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const ZDF_NEXT_MAX = 60; // gemerkte Folgeseiten-Adressen der ZDF-Suche

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Vorübergehender Abruffehler (Server überlastet, Zeitüberschreitung, Netz), der eine Wiederholung lohnt. */
function isTransient(error) {
  return Boolean(error) && error.permanent !== true && (error.code === 'network' || (error.code === 'http' && TRANSIENT_STATUS.has(error.status)));
}

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
 * wird eine Jugendschutz-Sperre (ARD, arte) bei angemeldetem Konto einmal mit dem Token des Kontos wiederholt. zdfFsk (optional,
 * zdf-fsk.js): löst FSK-Beiträge des ZDF nach Konto-/PIN-Prüfung auf (ohne zdfFsk bleibt die Sperre bestehen).
 */
function createMediathekService({ http, auth = null, zdfFsk = null, sleep = wait }) {
  if (!http || typeof http.getText !== 'function') throw new Error('http fehlt');

  /** Listen-Abruf (Seiten, Suche, Folgen) mit bis zu zwei Wiederholungen bei vorübergehenden Fehlern; sonst sofort der Fehler. */
  async function listText(url, options) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await http.getText(url, options);
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length || !isTransient(error)) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /**
   * Konto-Wiederholung bei Jugendschutz-Sperre: load(authSender) lädt die Stream-Info (mit Konto, wenn authSender gesetzt) und
   * liefert { done: true, value } (freigeschaltet), { done: false, value } (weiter gesperrt) oder wirft. Ergebnis:
   * { value, account } mit account: null (kein Konto-Sender) | 'signedOut' | 'expired' | 'unlocked' | 'blocked' | 'network' | 'error'.
   */
  async function retryWithAccount(sender, load) {
    const state = auth && typeof auth.accountState === 'function' ? auth.accountState(sender) : 'unsupported';
    if (state === 'unsupported') return { value: null, account: null };
    if (state === 'signedOut' || state === 'expired') return { value: null, account: state };
    const failureStatus = () => {
      const failure = typeof auth.refreshFailure === 'function' ? auth.refreshFailure(sender) : null;
      return failure && Number.isInteger(failure.status) ? failure.status : null;
    };
    /** Token vorab auffrischen: Ergebnis null (weiter) oder { value, account } (Abbruch); "abgelaufen" nur, wenn die Auffrischung scheiterte. */
    const prepare = async () => {
      if (typeof auth.ensureFresh === 'function') await auth.ensureFresh(sender);
      if (auth.accountState(sender) === 'expired') return { value: null, account: 'expired' };
      if (typeof auth.tokenUsable === 'function' && !auth.tokenUsable(sender)) return { value: null, account: 'network', status: failureStatus() };
      return null;
    };
    try {
      // Schlägt das per Netz fehl, wäre der Abruf ohne Kopfzeilen ein Fehlalarm "auch mit Konto gesperrt"
      const stop = await prepare();
      if (stop) return stop;
      let outcome;
      try {
        outcome = await load(sender);
      } catch (error) {
        if (!error || error.status !== 401) throw error;
        // Der Anbieter lehnt den Token ab: einmal auffrischen (bzw. Sitzung wiederherstellen) und wiederholen
        const again = await prepare();
        if (again) return again;
        outcome = await load(sender);
      }
      if (outcome.done) return { value: outcome.value, account: 'unlocked' };
      return { value: outcome.value, account: auth.accountState(sender) === 'expired' ? 'expired' : 'blocked' };
    } catch (error) {
      const status = error && Number.isInteger(error.status) ? error.status : null;
      if (status === 401) return auth.accountState(sender) === 'expired' ? { value: null, account: 'expired' } : { value: null, account: 'rejected', status };
      return { value: null, account: 'error', status };
    }
  }

  /** Abrufoptionen mit Konto (Standard { auth: sender }; arte: Alters-Token, siehe auth/arte.js). */
  async function accountOptions(sender) {
    return auth && typeof auth.requestOptions === 'function' ? auth.requestOptions(sender) : { auth: sender };
  }

  /** Adresse für den Wiederholungsabruf mit Konto (ARD: Parameter userId wie im Web-Client). */
  function personalized(sender, url) {
    return auth && typeof auth.personalizeUrl === 'function' ? auth.personalizeUrl(sender, url) : url;
  }

  /** Startseite einer Quelle als benannte Abschnitte. */
  async function fetchHomeSections(sourceId) {
    const body = await listText(sources.homeUrl(sourceId));
    return parsed(() => parser.parseSections(body, sourceId));
  }

  const zdfNext = new Map(); // "<Suche>|<Seite>" -> nextPageUrl der ZDF-Suche (Seite 0-basiert)
  const zdfNextKey = (query, page) => `${query}|${page}`;

  /** Adresse einer Suchseite; ZDF: die von der Vorseite genannte nextPageUrl, sonst der Parameter page (1-basiert). */
  function searchPageUrl(query, sourceId, page) {
    if (sourceId === 'zdf' && page > 0) return zdfNext.get(zdfNextKey(query, page)) || `${sources.searchUrl(query, 'zdf')}&page=${page + 1}`;
    return sources.searchUrl(query, sourceId, page);
  }

  /** Eine Suchseite { series, entries, page, hasMore }; ARD, ZDF und arte pagen (Seite 0-basiert). Fehler werden geworfen (nie eine leere Liste). */
  async function searchPage(query, sourceId, page = 0) {
    const body = await listText(searchPageUrl(query, sourceId, page));
    const result = parsed(() => parser.parseSearchPage(body, sourceId, page));
    if (sourceId === 'zdf') {
      if (result.nextPageUrl) {
        zdfNext.set(zdfNextKey(query, page + 1), result.nextPageUrl);
        if (zdfNext.size > ZDF_NEXT_MAX) zdfNext.delete(zdfNext.keys().next().value);
      }
      delete result.nextPageUrl;
    }
    return result;
  }

  /** Erste Nachlade-Adresse mit größerer Seitenlänge (limit=100, ab page=1: die schon geladenen Folgen kommen als Dubletten mit und entfallen). */
  function widenArteUrl(next) {
    try {
      const url = new URL(next);
      const limit = Number(url.searchParams.get('limit'));
      if (!Number.isFinite(limit) || limit <= 0 || limit >= ARTE_PAGE_LIMIT) return next;
      url.searchParams.set('limit', String(ARTE_PAGE_LIMIT));
      url.searchParams.set('page', '1');
      return url.toString();
    } catch {
      return next;
    }
  }

  /** Eine Zone samt Nachladeseiten (bis 1000 Folgen); Fehler beim Nachladen beenden das Nachladen still (die bisherigen Folgen bleiben). */
  async function arteZoneEntries(zone) {
    let entries = zone.entries;
    let next = zone.nextPage ? widenArteUrl(zone.nextPage) : null;
    const visited = new Set();
    let pages = 0;
    while (next && pages < MAX_ARTE_PAGES && entries.length < MAX_ARTE_EPISODES && !visited.has(next)) {
      visited.add(next);
      pages += 1;
      if (!isValidArteApiUrl(next)) break;
      let more;
      try {
        more = parser.parseArteMore(await listText(next), '');
      } catch {
        break;
      }
      entries = dedupe(entries.concat(more.entries));
      next = more.nextPage;
    }
    return entries.slice(0, MAX_ARTE_EPISODES);
  }

  /**
   * arte-Sammlung: mehrere Unterreihen sind benannte Gruppen. Tragen alle "Staffel N", ist N die Staffel; sonst zählt die Reihenfolge
   * (1, 2 ...) und seasonTitles { "<Nummer>": "Alltag" } liefert die Namen. Folgen, die in einer Unterreihe stehen, bleiben dort
   * (auch wenn sie in "Alle Videos" vorkommen); übrige Folgen haben keine Staffel. Eine einzelne Unterreihe ergibt keine Gruppe.
   */
  async function arteEpisodeView(series) {
    if (!isValidArteApiUrl(series.groupingURL)) throw invalidUrl();
    const body = await listText(series.groupingURL);
    const zones = parsed(() => parser.parseArteCollection(body));
    const subs = zones.filter(zone => zone.isSubcollection);
    const names = subs.map(zone => arteSubcollectionName(zone.title, zone.collectionTitle));
    const staffel = names.map(name => (name ? /^Staffel\s*(\d+)$/i.exec(name) : null));
    const byNumber = subs.length > 1 && staffel.every(Boolean) && new Set(staffel.map(match => match[1])).size === subs.length;
    const seasonTitles = {};
    const ordered = [];
    for (const [index, zone] of zones.entries()) {
      if (!zone.isSubcollection) continue;
      const position = subs.indexOf(zone);
      let season = null;
      if (subs.length > 1) {
        season = byNumber ? Number(staffel[position][1]) : position + 1;
        if (names[position] && !byNumber) seasonTitles[String(season)] = names[position];
      }
      ordered.push({ zone, season, index });
    }
    const all = [];
    // Unterreihen zuerst: bei Dubletten mit "Alle Videos" gewinnt die Zuordnung zur Unterreihe
    for (const { zone, season } of ordered) for (const entry of await arteZoneEntries(zone)) all.push(withFields(entry, { season }));
    for (const zone of zones.filter(item => !item.isSubcollection)) for (const entry of await arteZoneEntries(zone)) all.push(withFields(entry, { season: null }));
    return { entries: dedupe(all), seasonTitles };
  }

  async function fetchArteEpisodes(series) {
    return (await arteEpisodeView(series)).entries;
  }

  /** Folgen einer Serie (flach; mit groupBySeason nach Staffel gruppierbar). */
  async function fetchEpisodes(series) {
    if (!series || typeof series.groupingURL !== 'string') throw invalidUrl();
    if (series.sourceId === 'arte') return fetchArteEpisodes(series);
    if (series.sourceId === 'zdf') {
      if (!isZdfDocumentUrl(series.groupingURL)) throw invalidUrl();
      const body = await listText(series.groupingURL);
      return parsed(() => parser.parseZdfEpisodes(body));
    }
    if (series.sourceId !== 'ard' || !isArdGroupingUrl(series.groupingURL)) throw invalidUrl();
    return (await collectArdEpisodes(series, { pages: 0 })).entries;
  }

  /**
   * Folgen einer ARD-Serie, seitenweise (pages: Anzahl der Seiten, 0 = alle bis MAX_ARD_EPISODES). Ergebnis { entries (OV/AD
   * zusammengefasst), hasMore, progress: { loaded, total }|null, availableSeasons: [Zahl]|null }.
   */
  async function collectArdEpisodes(series, { pages = 1 } = {}) {
    let url = series.groupingURL;
    let all = [];
    let count = 0;
    let availableSeasons = null;
    let progress = null;
    while (url && (pages === 0 || count < pages) && count < MAX_ARD_PAGES && all.length < MAX_ARD_EPISODES) {
      const target = url;
      const page = await cached(
        `page|${target}`,
        async () => {
          const body = await listText(target);
          const root = parsed(() => parser.toRoot(body));
          return { ...parsed(() => parser.parseArdGroupingPage(root)), seasons: count === 0 ? ardSeason.availableSeasons(root) : [] };
        },
        Date.now(),
        PAGE_CACHE_MS
      );
      if (count === 0) availableSeasons = page.seasons.length ? page.seasons : null;
      all = all.concat(page.entries);
      count += 1;
      const pageSize = page.pageSize || ardSeason.PAGE_SIZE;
      const pageNumber = page.pageNumber || 0;
      progress = page.total ? { loaded: Math.min(page.total, (pageNumber + 1) * pageSize), total: page.total } : null;
      url = page.nextPage;
    }
    const hasMore = Boolean(url) && all.length < MAX_ARD_EPISODES;
    return { entries: mergeOriginalVersions(dedupe(all)), hasMore, progress: hasMore ? progress : null, availableSeasons };
  }

  /** Alle Folgen einer ARD-Staffel (Staffel-Widget, seitenweise bis zur Obergrenze) mit Staffel- und Folgennummer (Titel "(S05/E08)", sonst Position nach Sendedatum). */
  function ardSeasonEpisodes(series, season) {
    return cached(
      `seasonEntries|${series.id}|${season}`,
      async () => {
        let entries = [];
        for (let page = 0; page < ardSeason.MAX_PAGES && entries.length < MAX_ARD_EPISODES; page += 1) {
          const body = await listText(ardSeason.seasonAssetUrl(series.id, season, page));
          const root = parsed(() => parser.toRoot(body));
          entries = entries.concat(ardSeason.seasonEntryObjects(root));
          if (!ardSeason.hasMorePages(root, page)) break;
        }
        const merged = mergeOriginalVersions(dedupe(entries)).sort((a, b) => (a.airedAt || '') < (b.airedAt || '') ? -1 : (a.airedAt || '') > (b.airedAt || '') ? 1 : 0);
        return merged.map((entry, index) => withFields(entry, { season, episode: entry.season === season && entry.episode !== null ? entry.episode : index + 1 }));
      },
      Date.now(),
      PAGE_CACHE_MS
    );
  }

  /**
   * Folgen für die Serienseite: ARD seitenweise (pages) bzw. eine Staffel komplett (season, über die Staffel-Widgets), alle anderen
   * Quellen vollständig. Ergebnis { entries, hasMore, progress, availableSeasons } (siehe collectArdEpisodes).
   */
  async function fetchEpisodeView(series, { pages = 1, season = null } = {}) {
    if (!series || typeof series.groupingURL !== 'string') throw invalidUrl();
    if (series.sourceId === 'arte') return { ...(await arteEpisodeView(series)), hasMore: false, progress: null, availableSeasons: null };
    if (series.sourceId !== 'ard') return { entries: await fetchEpisodes(series), hasMore: false, progress: null, availableSeasons: null };
    if (!isArdGroupingUrl(series.groupingURL)) throw invalidUrl();
    if (season === null) return collectArdEpisodes(series, { pages });
    const first = await collectArdEpisodes(series, { pages: 1 });
    if (!first.availableSeasons || !first.availableSeasons.includes(season)) throw invalidUrl();
    return { entries: await ardSeasonEpisodes(series, season), hasMore: false, progress: null, availableSeasons: first.availableSeasons };
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

  const fskCache = new Map(); // "<quelle>:<id>" -> Altersfreigabe (nur Treffer, auch null; Fehler werden nicht gemerkt)
  const FSK_PARALLEL = 2; // Nachladen für Listen: höchstens zwei Abfragen gleichzeitig
  const fskKey = entry => `${entry.sourceId}:${entry.id}`;
  const fskWaiting = [];
  let fskRunning = 0;

  /** Bereits bekannte Altersfreigabe (Zahl) ohne Abruf, sonst null. */
  function knownFsk(entry) {
    if (!entry) return null;
    if (typeof entry.fsk === 'number') return entry.fsk;
    const cached = fskCache.get(fskKey(entry));
    return typeof cached === 'number' ? cached : null;
  }

  /** Merkt die Altersfreigabe aus einer ohnehin geladenen Stream-Info (ARD item, ZDF document). */
  function rememberFsk(entry, body) {
    if (!entry || (entry.sourceId !== 'zdf' && entry.sourceId !== 'ard') || fskCache.has(fskKey(entry))) return;
    const fsk = parser.parseFsk(body, entry.sourceId);
    if (fsk !== null) fskCache.set(fskKey(entry), fsk);
  }

  function pumpFsk() {
    while (fskRunning < FSK_PARALLEL && fskWaiting.length) {
      const job = fskWaiting.shift();
      fskRunning += 1;
      job().finally(() => {
        fskRunning -= 1;
        pumpFsk();
      });
    }
  }

  /**
   * Altersfreigabe einer Folge, wenn der Eintrag sie nicht trägt: Listen-Teaser nennen sie oft nicht (ZDF "none"), die Stream-Info
   * (ZDF document, ARD item) schon. Eine kleine, gecachte Abfrage, höchstens zwei gleichzeitig; arte und Fehler ergeben null.
   */
  async function fetchFsk(entry) {
    if (!entry) return null;
    if (typeof entry.fsk === 'number') return entry.fsk;
    if (entry.sourceId !== 'zdf' && entry.sourceId !== 'ard') return null;
    const key = fskKey(entry);
    if (fskCache.has(key)) return fskCache.get(key);
    const url = sources.streamInfoUrl(entry);
    if (!url) return null;
    return new Promise(resolve => {
      fskWaiting.push(async () => {
        if (fskCache.has(key)) return resolve(fskCache.get(key));
        try {
          const fsk = parser.parseFsk(await http.getText(url), entry.sourceId);
          fskCache.set(key, fsk);
          return resolve(fsk);
        } catch {
          return resolve(null);
        }
      });
      pumpFsk();
    });
  }

  /** Genre-/Rubrikseite (arte Genre, ARD/ZDF Rubrik) als Reihen. */
  async function fetchGenrePage(genre) {
    const url = genrePageUrl(genre);
    if (!url) throw invalidUrl();
    const body = await listText(url);
    return parsed(() => parser.parseGenrePage(body, genre.sourceId));
  }

  /** Nächste Seite einer Reihe (section.nextPage): arte-Emac-Adressen oder ARD-Widget-Adressen, sonst ungültig. */
  async function fetchMore(section) {
    if (!section || !section.nextPage) throw invalidUrl();
    if (isArdWidgetUrl(section.nextPage)) {
      const body = await http.getText(section.nextPage);
      return parsed(() => parser.parseArdMore(body, section.title));
    }
    if (!isValidArteApiUrl(section.nextPage)) throw invalidUrl();
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
    rememberFsk(entry, body);
    const detail = parser.parseStreamDetail(body, entry.sourceId);
    if (detail.resolution.kind === 'ageRestricted' && entry.sourceId === 'zdf' && zdfFsk) return unlockZdf(detail, body);
    if (detail.resolution.kind !== 'ageRestricted' || !auth) return detail;
    const { value, account, status } = await retryWithAccount(entry.sourceId, async sender => {
      const again = parser.parseStreamDetail(await http.getText(personalized(sender, url), await accountOptions(sender)), entry.sourceId);
      return { done: again.resolution.kind === 'playable', value: again };
    });
    if (account === 'unlocked') return value;
    return account ? { ...detail, resolution: { ...detail.resolution, account, ...(Number.isInteger(status) ? { accountStatus: status } : {}) } } : detail;
  }

  /** ZDF: gesperrten Beitrag nach Konto-/PIN-Prüfung auflösen; sonst die Sperre mit dem Grund (account) zurückgeben. */
  async function unlockZdf(detail, body) {
    let outcome;
    try {
      outcome = await zdfFsk.unlock(parser.toRoot(body));
    } catch {
      outcome = { ok: false, account: 'error' };
    }
    if (outcome.ok) return parser.parseStreamDetail(outcome.root, 'zdf');
    return outcome.account ? { ...detail, resolution: { ...detail.resolution, account: outcome.account, ...(outcome.status ? { accountStatus: outcome.status } : {}) } } : detail;
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

  async function cached(key, load, nowMs, ttl = SEASON_CACHE_MS) {
    const hit = seasonCache.get(key);
    if (hit && nowMs - hit.at < ttl) return hit.value;
    const value = await load();
    seasonCache.delete(key);
    seasonCache.set(key, { at: nowMs, value });
    if (seasonCache.size > CACHE_MAX) seasonCache.delete(seasonCache.keys().next().value);
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
    if (info.restriction && info.restriction.code === 'age' && entry.sourceId === 'zdf' && zdfFsk) {
      let outcome;
      try {
        outcome = await zdfFsk.unlock(root);
      } catch {
        outcome = { ok: false, account: 'error' };
      }
      if (outcome.ok) info = await buildInfo(outcome.root);
      else if (outcome.account) {
        // PIN-Fehler brauchen eine Eingabe des Nutzers: nicht zurückstellen (sonst fragt die Wiederholung nachts erneut), sondern melden
        const needsUser = ['pinCancelled', 'wrongPin', 'pinLocked'].includes(outcome.account);
        info.restriction = { ...info.restriction, ...(needsUser ? { code: 'unavailable' } : {}), account: outcome.account, message: accountNote(info.restriction.message, outcome.account, 'zdf', outcome.status) };
      }
    } else if (info.restriction && info.restriction.code === 'age' && auth) {
      const { value, account, status } = await retryWithAccount(entry.sourceId, async sender => {
        const again = await buildInfo(parser.toRoot(await http.getText(personalized(sender, url), await accountOptions(sender))));
        return { done: !again.restriction, value: again };
      });
      if (account === 'unlocked') info = value;
      else if (account) info.restriction = { ...info.restriction, account, message: accountNote(info.restriction.message, account, entry.sourceId, status) };
    }
    if (entry.sourceId === 'ard' && info.season === null && series) {
      // Staffel steht bei der ARD nur im Staffel-Widget; eine im Titel gefundene Folgennummer (S05/E08) bleibt maßgeblich
      const found = await ardSeasonOf(series, entry);
      if (found) {
        info.season = found.season;
        if (info.episode === null) info.episode = found.episode;
      }
    }
    const fsk = parser.parseFsk(root, entry.sourceId);
    return { source: entry.sourceId, entryId: entry.id, ...info, fsk };
  }

  return { fetchHomeSections, searchPage, fetchEpisodes, fetchEpisodeView, retryEmptySeries, fetchFsk, knownFsk, fetchGenrePage, fetchMore, resolveStreamDetail, resolveForDownload };
}

module.exports = { createMediathekService };
