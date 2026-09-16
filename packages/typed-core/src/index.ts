export type {
  StreamService,
  TvSource,
  TvChannel,
  TvChannelGroup,
  EpgEntry,
  HistoryEntry,
  UpdateInfo,
  AppConfig,
  CustomSource,
  ChannelListItem,
  MediathekSource,
  MediathekEntry,
  MediathekSearchResult,
} from './types.js';

export type {
  M3UFullResult,
} from './tvsources.js';

export {
  BUILTIN_SERVICES,
  loadServices,
} from './services.js';

export {
  parseM3U,
  parseM3UFull,
  flattenM3U,
  searchChannels,
} from './tvsources.js';

export {
  compareVersions,
  parseTagsFromLsRemote,
  checkForUpdate,
} from './updater.js';

export {
  addHistoryEntry,
  searchHistory,
  groupHistoryByDate,
} from './history.js';

export {
  DEFAULT_CONFIG,
  mergeConfig,
  validateConfig,
} from './config.js';

export {
  escapeHtml,
  decodeEntities,
  normalizeUrl,
  formatTimestamp,
  cleanChannelName,
} from './format.js';

export {
  parseEpgTime,
  formatEpgTime,
  buildEpgIndex,
  getEpgChannelList,
  findCurrentEpg,
  parseXMLTV,
} from './epg.js';

export {
  computeEpgMarkers,
  selectEpgWindowEntries,
  absoluteTimeToWindowOffsetSec,
  windowOffsetSecToAbsoluteTime,
  type EpgMarker,
} from './epgWindow.js';

export {
  getMediathekForChannel,
  normalizeTvId,
  isFavorite,
  buildZapOrder,
  filterChannels,
  groupChannels,
  separateFavorites,
  buildChannelList,
  getNextChannelId,
  applyChannelOverrides,
  applySortOrder,
  mediathekChannelMap,
} from './tv.js';

export {
  DEFAULT_MEDIATHEK_SOURCES,
  buildSearchUrl,
  parseSearchResponse,
} from './mediathek.js';
