import { Loader2, Tv2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import type { EditorChannel, EpgChannel } from "./types";

// EPG lists can be thousands of entries, so we filter ourselves and only render
// a capped slice. Rendering them all bogs down the popover.
const RENDER_LIMIT = 80;

/** Per-channel EPG picker. Lists EPG channels from every source, plus a reset to
    the channel's own source EPG. The list is fetched lazily on open, then saved
    via the editor fetcher (intent=setEpg). */
export function EpgPicker({
  channel,
  playlistId,
  fetcher,
}: {
  channel: EditorChannel;
  playlistId: number;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const epgFetcher = useFetcher<{ epgChannels: EpgChannel[] }>();

  useEffect(() => {
    if (open && !epgFetcher.data && epgFetcher.state === "idle") {
      epgFetcher.load(`/playlists/${playlistId}/epg-channels`);
    }
  }, [open, epgFetcher, playlistId]);

  const epgChannels = epgFetcher.data?.epgChannels ?? [];
  const loading = epgFetcher.state === "loading";

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return epgChannels;
    return epgChannels.filter(
      (e) =>
        (e.displayName ?? "").toLowerCase().includes(needle) ||
        e.channelId.toLowerCase().includes(needle) ||
        e.sourceName.toLowerCase().includes(needle),
    );
  }, [epgChannels, query]);

  const displayName = channel.customName ?? channel.sourceName;
  const isDefault =
    channel.epgSourceId === channel.channelSourceId &&
    channel.epgChannelId === channel.sourceEpgChannelId;
  const hasEpg = !!channel.epgChannelId;

  // When the EPG points at something other than the source default, pin that
  // channel to the top so the current pick is obvious and easy to change.
  const selectedEpg =
    !isDefault && hasEpg
      ? (epgChannels.find(
          (e) =>
            e.sourceId === channel.epgSourceId &&
            e.channelId === channel.epgChannelId,
        ) ?? null)
      : null;

  const shown = matches.slice(0, RENDER_LIMIT);
  const grouped = useMemo(() => {
    const map = new Map<string, EpgChannel[]>();
    for (const epg of shown) {
      if (epg.id === selectedEpg?.id) continue;
      const list = map.get(epg.sourceName) ?? [];
      list.push(epg);
      map.set(epg.sourceName, list);
    }
    return Array.from(map.entries());
  }, [shown, selectedEpg]);

  function save(epgSourceId: number | null, epgChannelId: string | null) {
    fetcher.submit(
      {
        intent: "setEpg",
        channelId: channel.id,
        epgSourceId: epgSourceId ?? "",
        epgChannelId: epgChannelId ?? "",
      },
      { method: "post" },
    );
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 cursor-pointer"
          title={
            !hasEpg
              ? "No EPG set"
              : isDefault
                ? `EPG: ${channel.epgChannelId}`
                : `EPG (custom): ${channel.epgChannelId}`
          }
        >
          <Tv2
            className={cn(
              "size-4",
              !hasEpg
                ? "text-destructive"
                : !isDefault
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        {/* We do our own filtering and capping, so cmdk's filter is off. */}
        <Command shouldFilter={false}>
          <div className="border-b border-border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">EPG for</p>
            <p className="truncate text-sm font-medium">{displayName}</p>
          </div>
          <CommandInput
            placeholder="Search EPG channels..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {selectedEpg ? (
              <CommandGroup heading="Selected">
                <CommandItem
                  value="epg-selected"
                  onSelect={() => save(selectedEpg.sourceId, selectedEpg.channelId)}
                  className="bg-accent"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">
                      {selectedEpg.displayName ?? selectedEpg.channelId}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {selectedEpg.sourceName} · {selectedEpg.channelId}
                    </span>
                  </div>
                  <span className="text-xs text-primary">Active</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Default">
              <CommandItem
                value="source-default"
                onSelect={() =>
                  save(channel.channelSourceId, channel.sourceEpgChannelId)
                }
              >
                <Tv2 className="size-4" />
                <span className="flex-1">Source default</span>
                {isDefault ? <span className="text-xs text-primary">Active</span> : null}
              </CommandItem>
            </CommandGroup>

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading EPG channels...
              </div>
            ) : matches.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No EPG channels found.
              </div>
            ) : (
              grouped.map(([sourceName, list]) => (
                <CommandGroup key={sourceName} heading={sourceName}>
                  {list.map((epg) => {
                    const selected =
                      !isDefault &&
                      channel.epgSourceId === epg.sourceId &&
                      channel.epgChannelId === epg.channelId;
                    return (
                      <CommandItem
                        key={epg.id}
                        value={`epg-${epg.id}`}
                        onSelect={() => save(epg.sourceId, epg.channelId)}
                        className={cn(selected && "bg-accent")}
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">
                            {epg.displayName ?? epg.channelId}
                          </span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {epg.channelId}
                          </span>
                        </div>
                        {selected ? (
                          <span className="text-xs text-primary">Active</span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))
            )}
            {matches.length > shown.length ? (
              <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                Showing {shown.length} of {matches.length}. Refine your search.
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
