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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import type { EditorChannel, EpgChannel } from "./types";

// EPG lists can be thousands of entries, so we filter ourselves and only render
// a capped slice. Rendering them all bogs down the list.
const RENDER_LIMIT = 100;

/** Per-channel EPG picker. Lists EPG channels from every source, plus a reset to
    the channel's own source EPG. The list is fetched lazily on open, then saved
    via the editor fetcher (intent=setEpg). */
export function EpgPicker({
  channel,
  playlistId,
  fetcher,
  alternates,
}: {
  channel: EditorChannel;
  playlistId: number;
  fetcher: ReturnType<typeof useFetcher>;
  // The primary's alternates, when this channel is an alt group primary. Their
  // own source EPGs are surfaced at the top as likely guides.
  alternates?: EditorChannel[];
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

  const matchesNeedle = (e: EpgChannel, needle: string) =>
    (e.displayName ?? "").toLowerCase().includes(needle) ||
    e.channelId.toLowerCase().includes(needle) ||
    e.sourceName.toLowerCase().includes(needle);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return epgChannels;
    return epgChannels.filter((e) => matchesNeedle(e, needle));
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

  // EPG channels belonging to this group's alternates. Each alternate is the
  // same channel from another provider, so its own source EPG is a likely guide
  // for the primary. We pin these at the top so they're one click away. Dedupe
  // alternates that share an EPG; the active one is marked below.
  const altEpg = useMemo(() => {
    if (!alternates?.length) return [];
    const seen = new Set<number>();
    const out: EpgChannel[] = [];
    for (const alt of alternates) {
      if (!alt.sourceEpgChannelId) continue;
      const match = epgChannels.find(
        (e) =>
          e.sourceId === alt.channelSourceId &&
          e.channelId === alt.sourceEpgChannelId,
      );
      if (!match || seen.has(match.id)) continue;
      seen.add(match.id);
      out.push(match);
    }
    return out;
  }, [alternates, epgChannels]);

  const altEpgShown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return altEpg;
    return altEpg.filter((e) => matchesNeedle(e, needle));
  }, [altEpg, query]);

  const altEpgIds = useMemo(() => new Set(altEpg.map((e) => e.id)), [altEpg]);

  const shown = matches.slice(0, RENDER_LIMIT);
  // A flat list rather than grouped under a source heading: once you scroll the
  // heading is gone, so each row carries its own source instead.
  const others = useMemo(
    () =>
      shown.filter((e) => e.id !== selectedEpg?.id && !altEpgIds.has(e.id)),
    [shown, selectedEpg, altEpgIds],
  );

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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <DialogTrigger asChild>
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
      </DialogTrigger>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[35rem]">
        <DialogHeader className="gap-0.5 border-b border-border px-4 py-3 pr-10 text-left">
          <p className="text-[11px] font-normal text-muted-foreground">EPG for</p>
          <DialogTitle className="truncate text-sm font-medium">
            {displayName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose which EPG channel provides the guide for {displayName}.
          </DialogDescription>
        </DialogHeader>
        {/* We do our own filtering and capping, so cmdk's filter is off. */}
        <Command shouldFilter={false} className="rounded-none">
          <CommandInput
            placeholder="Search EPG channels..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[60vh]">
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
            {altEpgShown.length > 0 ? (
              <CommandGroup heading="Alternatives">
                {altEpgShown.map((epg) => {
                  const selected =
                    !isDefault &&
                    channel.epgSourceId === epg.sourceId &&
                    channel.epgChannelId === epg.channelId;
                  return (
                    <CommandItem
                      key={`alt-${epg.id}`}
                      value={`alt-epg-${epg.id}`}
                      onSelect={() => save(epg.sourceId, epg.channelId)}
                      className={cn(selected && "bg-accent")}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">
                          {epg.displayName ?? epg.channelId}
                        </span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {epg.sourceName} · {epg.channelId}
                        </span>
                      </div>
                      {selected ? (
                        <span className="text-xs text-primary">Active</span>
                      ) : null}
                    </CommandItem>
                  );
                })}
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
              <CommandGroup heading="All channels">
                {others.map((epg) => {
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
                          {epg.sourceName} · {epg.channelId}
                        </span>
                      </div>
                      {selected ? (
                        <span className="text-xs text-primary">Active</span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {matches.length > shown.length ? (
              <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                Showing {shown.length} of {matches.length}. Refine your search.
              </div>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
