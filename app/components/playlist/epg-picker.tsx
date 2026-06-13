import { Loader2, Tv2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
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

/** Per-channel EPG picker. Lists EPG channels from every source, plus a reset to
    the channel's own source EPG. The list is fetched lazily on open (there can
    be thousands), then saved via the editor fetcher (intent=setEpg). */
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
  const epgFetcher = useFetcher<{ epgChannels: EpgChannel[] }>();

  // Load the EPG list the first time the picker opens.
  useEffect(() => {
    if (open && !epgFetcher.data && epgFetcher.state === "idle") {
      epgFetcher.load(`/playlists/${playlistId}/epg-channels`);
    }
  }, [open, epgFetcher, playlistId]);

  const epgChannels = epgFetcher.data?.epgChannels ?? [];
  const loading = epgFetcher.state === "loading";

  const grouped = useMemo(() => {
    const map = new Map<string, EpgChannel[]>();
    for (const epg of epgChannels) {
      const list = map.get(epg.sourceName) ?? [];
      list.push(epg);
      map.set(epg.sourceName, list);
    }
    return Array.from(map.entries());
  }, [epgChannels]);

  const isDefault =
    channel.epgSourceId === channel.channelSourceId &&
    channel.epgChannelId === channel.sourceEpgChannelId;

  const hasEpg = !!channel.epgChannelId;

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 cursor-pointer"
          title={hasEpg ? `EPG: ${channel.epgChannelId}` : "No EPG set"}
        >
          <Tv2
            className={cn(
              "size-4",
              hasEpg ? "text-muted-foreground" : "text-destructive",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search EPG channels..." />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading EPG channels...
              </div>
            ) : (
              <CommandEmpty>No EPG channels found.</CommandEmpty>
            )}
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
            {grouped.map(([sourceName, list]) => (
              <CommandGroup key={sourceName} heading={sourceName}>
                {list.map((epg) => {
                  const selected =
                    !isDefault &&
                    channel.epgSourceId === epg.sourceId &&
                    channel.epgChannelId === epg.channelId;
                  return (
                    <CommandItem
                      key={epg.id}
                      value={`${sourceName} ${epg.displayName ?? ""} ${epg.channelId}`}
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
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
