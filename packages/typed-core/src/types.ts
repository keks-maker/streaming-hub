// ─── Dienst (Streaming-Anbieter) ───────────────────────────────

export interface StreamService {
  id: string;
  name: string;
  url: string;
  icon: string;
  color?: string;
  group?: 'streaming' | 'mediathek' | 'livetv';
  iosAppScheme?: string;
  tvosAppScheme?: string;
}

// ─── TV-Quelle (Senderliste) ───────────────────────────────────

export interface TvSource {
  id: string;
  name: string;
  url: string;
  type?: 'file' | 'url';
  color?: string;
  epgUrl?: string | null;
  logo?: string;
  order: number;
  baseUrl?: string;
  channelOverrides?: Record<string, Record<string, string | undefined>>;
  sortOrder?: string[];
  favorites?: string[];
}

// ─── TV-Sender ─────────────────────────────────────────────────

export interface TvChannelGroup {
  label: string;
  channels: TvChannel[];
}

export interface TvChannel {
  id: string;
  name: string;
  logo?: string;
  url: string;
  group: string;
  tvgId?: string;
  sourceId?: string;
  epgId?: string;
}

// ─── EPG ────────────────────────────────────────────────────────

export interface EpgEntry {
  channelId: string;
  title: string;
  start: string;
  stop: string;
  description?: string;
}

// ─── Wiedergabe-Verlauf ────────────────────────────────────────

export interface HistoryEntry {
  title: string;
  serviceKey: string;
  serviceName: string;
  timestamp: string;
}

// ─── Update ────────────────────────────────────────────────────

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
}

// ─── Konfiguration ─────────────────────────────────────────────

export interface AppConfig {
  customSources: CustomSource[];
  pinnedServices: string[];
  tvSidebarOpen: boolean;
  volume: number;
  lastProvider?: string;
}

export interface CustomSource {
  name: string;
  url: string;
  epgUrl?: string;
}

// ─── Hilfstypen ────────────────────────────────────────────────

export interface ChannelListItem {
  id: string;
  name: string;
  logo: string;
}

// ─── Mediathek ──────────────────────────────────────────────────

export interface MediathekSource {
  /** Key des Anbieters (ard, zdf, arte) */
  provider: string;
  /** Such-Query (optional, vorausgefüllt) */
  query?: string;
  /** API-Basis-URL (hier: mediathekviewweb.de) */
  apiUrl: string;
}

export interface MediathekEntry {
  id: string;
  title: string;
  description: string;
  /** Direkte Video-URL (mp4 oder HLS m3u8) */
  videoUrl: string;
  /** Original-Mediathek-URL */
  websiteUrl: string;
  /** Kanal / Sender */
  creator: string;
  /** Kategorie */
  category: string;
  /** Dauer in Sekunden */
  duration: number;
  /** Video-Dateigröße in Bytes (optional) */
  fileSize?: number;
  /** MP4 oder HLS */
  videoType: string;
  /** Veröffentlichungsdatum (ISO 8601) */
  pubDate: string;
}

export interface MediathekSearchResult {
  query: string;
  /** Gefilterte Einträge (optional, nur gefüllt wenn channelFilter gesetzt) */
  filtered: MediathekEntry[];
  /** Alle Einträge der API (unfiltered) */
  allHits: MediathekEntry[];
}
