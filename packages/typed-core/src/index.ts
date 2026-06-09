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
} from './types.js';

export {
  BUILTIN_SERVICES,
  loadServices,
} from './services.js';

export {
  parseM3U,
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
  getMediathekForChannel,
  normalizeTvId,
  isFavorite,
  filterChannels,
  groupChannels,
  separateFavorites,
  buildChannelList,
  getNextChannelId,
  applyChannelOverrides,
  applySortOrder,
  mediathekChannelMap,
} from './tv.js';
