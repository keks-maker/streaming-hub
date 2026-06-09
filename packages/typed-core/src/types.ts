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
