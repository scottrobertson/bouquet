import type { AutoChannelView, EditorCategory, EditorChannel } from "./types";

/** One line in the playlist pane. The pane renders a flat list of these so it
    can virtualise, rather than nesting channels inside categories. */
export type BoardRow =
  | {
      kind: "category";
      key: string;
      category: EditorCategory;
      count: number;
      collapsed: boolean;
    }
  | { kind: "empty"; key: string; categoryId: number; auto: boolean }
  | {
      kind: "primary";
      key: string;
      channel: EditorChannel;
      alternates: EditorChannel[];
      collapsed: boolean;
    }
  | {
      kind: "alternate";
      key: string;
      channel: EditorChannel;
      primary: EditorChannel;
      index: number;
      total: number;
    }
  | { kind: "auto"; key: string; channel: AutoChannelView };

// Shared so a channel with no alternates hands the same array to every render.
// A fresh [] each time would break the memo on the row and re-render the lot.
const NO_ALTERNATES: EditorChannel[] = [];

/** Roughly how tall each row is before it's measured. Only needs to be close;
    the virtualiser remeasures once a row mounts. */
export function estimateRowHeight(row: BoardRow): number {
  switch (row.kind) {
    case "category":
      return 41;
    case "empty":
      return 49;
    case "auto":
      return 45;
    default:
      return 57;
  }
}

export function buildBoardRows({
  categories,
  channelsByCategory,
  alternatesByPrimary,
  autoChannels,
  collapsedCats,
  expandedGroups,
}: {
  categories: EditorCategory[];
  channelsByCategory: Map<number, EditorChannel[]>;
  alternatesByPrimary: Map<number, EditorChannel[]>;
  autoChannels: Record<number, AutoChannelView[]>;
  collapsedCats: Set<number>;
  expandedGroups: Set<number>;
}): BoardRow[] {
  const rows: BoardRow[] = [];

  for (const category of categories) {
    const isAuto = category.auto != null;
    const autoList = autoChannels[category.id] ?? [];
    const channels = channelsByCategory.get(category.id) ?? [];
    const altTotal = channels.reduce(
      (n, c) => n + (alternatesByPrimary.get(c.id)?.length ?? 0),
      0,
    );
    const collapsed = collapsedCats.has(category.id);

    rows.push({
      kind: "category",
      key: `cat-${category.id}`,
      category,
      count: isAuto ? autoList.length : channels.length + altTotal,
      collapsed,
    });

    if (collapsed) continue;

    if (isAuto) {
      if (autoList.length === 0) {
        rows.push({
          kind: "empty",
          key: `empty-${category.id}`,
          categoryId: category.id,
          auto: true,
        });
      } else {
        for (const channel of autoList) {
          rows.push({
            kind: "auto",
            key: `auto-${category.id}-${channel.sourceChannelId}`,
            channel,
          });
        }
      }
      continue;
    }

    if (channels.length === 0) {
      rows.push({
        kind: "empty",
        key: `empty-${category.id}`,
        categoryId: category.id,
        auto: false,
      });
      continue;
    }

    for (const channel of channels) {
      const alternates = alternatesByPrimary.get(channel.id) ?? NO_ALTERNATES;
      const groupCollapsed = !expandedGroups.has(channel.id);
      rows.push({
        kind: "primary",
        key: `ch-${channel.id}`,
        channel,
        alternates,
        collapsed: groupCollapsed,
      });
      if (groupCollapsed) continue;
      alternates.forEach((alt, index) => {
        rows.push({
          kind: "alternate",
          key: `ch-${alt.id}`,
          channel: alt,
          primary: channel,
          index,
          total: alternates.length,
        });
      });
    }
  }

  return rows;
}
