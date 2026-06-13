/** A channel inside a playlist, joined to its source channel, as the editor uses it. */
export type EditorChannel = {
  id: number;
  categoryId: number;
  sourceChannelId: number;
  customName: string | null;
  customLogo: string | null;
  enabled: boolean;
  epgSourceId: number | null;
  epgChannelId: string | null;
  sourceName: string;
  sourceLogo: string | null;
  sourceAvailable: boolean;
  sourceCategoryName: string | null;
  channelSourceId: number;
  sourceEpgChannelId: string | null;
  sourceProviderName: string;
  sourceCategoryEnabled: boolean;
};

export type EditorCategory = {
  id: number;
  name: string;
  // Set when this is an auto-sync category mirroring one source category.
  auto: { sourceId: number; sourceName: string; categoryName: string } | null;
};

/** A read-only channel inside an auto-sync category (derived live from source). */
export type AutoChannelView = {
  sourceChannelId: number;
  name: string;
  logo: string | null;
};

export type EpgChannel = {
  id: number;
  sourceId: number;
  channelId: string;
  displayName: string | null;
  sourceName: string;
};

/** A source channel as shown in the left browser pane. */
export type BrowserChannel = {
  id: number;
  name: string;
  logo: string | null;
  categoryName: string | null;
  available: boolean;
  sourceId: number;
  sourceName: string;
};
