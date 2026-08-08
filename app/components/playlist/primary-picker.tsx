import { CornerDownRight, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
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
import {
  suggestPrimaries,
  type MatchTarget,
} from "~/services/playlist/channel-match";

type Primary = {
  id: number;
  name: string;
  // Other names to match a suggestion against, like the provider's name for a
  // channel you've renamed.
  names?: string[];
  epgChannelId?: string | null;
  hint?: string;
};

/** Pick a playlist channel to group the current selection under, as alternates.
    Searchable since a playlist can hold a lot of channels, and the groups that
    look like the right home for what you picked are offered at the top. */
export function PrimaryPicker({
  primaries,
  picked,
  onPick,
  label,
}: {
  primaries: Primary[];
  // The channels being grouped, which is what the suggestions are based on.
  picked?: MatchTarget[];
  onPick: (id: number) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  const suggested = useMemo(() => {
    if (!open || !picked?.length) return [];
    const byId = new Map(primaries.map((p) => [p.id, p]));
    return suggestPrimaries(picked, primaries)
      .map((s) => ({ ...byId.get(s.id)!, reason: s.reason }))
      .filter((s) => s.name);
  }, [open, picked, primaries]);

  const suggestedIds = new Set(suggested.map((s) => s.id));
  const rest = primaries.filter((p) => !suggestedIds.has(p.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          className="font-normal"
          disabled={primaries.length === 0}
        >
          <CornerDownRight className="size-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
      >
        <Command>
          <CommandInput placeholder="Find a channel..." />
          <CommandList>
            <CommandEmpty>No channels.</CommandEmpty>
            {suggested.length > 0 ? (
              <CommandGroup heading="Suggested">
                {suggested.map((p) => (
                  <Row
                    key={p.id}
                    primary={p}
                    reason={p.reason}
                    onPick={(id) => {
                      onPick(id);
                      setOpen(false);
                    }}
                  />
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading={suggested.length > 0 ? "All channels" : undefined}>
              {rest.map((p) => (
                <Row
                  key={p.id}
                  primary={p}
                  onPick={(id) => {
                    onPick(id);
                    setOpen(false);
                  }}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  primary,
  reason,
  onPick,
}: {
  primary: Primary;
  reason?: string;
  onPick: (id: number) => void;
}) {
  return (
    <CommandItem
      value={`${primary.name} ${primary.id}`}
      onSelect={() => onPick(primary.id)}
      className="flex flex-col items-start gap-0.5"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="break-words">{primary.name}</span>
        {reason ? (
          <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3" />
            {reason}
          </span>
        ) : null}
      </div>
      {primary.hint ? (
        <span className="text-[11px] text-muted-foreground">{primary.hint}</span>
      ) : null}
    </CommandItem>
  );
}
