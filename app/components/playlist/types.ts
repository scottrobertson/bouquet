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
