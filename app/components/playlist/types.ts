/** A channel inside a playlist, joined to its source channel, as the editor uses it. */
export type EditorChannel = {
  id: number;
  categoryId: number;
  sourceChannelId: number;
  customName: string | null;
  customLogo: string | null;
  // Logo borrowed from a custom EPG pick, null when the EPG is the source default.
  epgLogo: string | null;
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
  // The provider's direct stream URL, for the Play in VLC / copy actions.
  streamUrl: string;
  // Latest ffprobe result for the underlying stream. Null = never probed.
  // "queued"/"probing" are live states shown while a probe is in flight.
  probeStatus: "queued" | "probing" | "ok" | "error" | "timeout" | null;
  probeWidth: number | null;
  probeHeight: number | null;
  probeFps: number | null;
  probeVideoCodec: string | null;
  probeAudioCodec: string | null;
  probeBitrate: number | null;
  // Set when this channel is an alternate of another channel (its primary).
  primaryChannelId: number | null;
  altPosition: number;
  // The name an alternate falls back to when not manually renamed.
  autoName: string;
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
  // The logo this EPG channel lends a channel when picked. Same as the source
  // channel's own logo.
  icon: string | null;
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
