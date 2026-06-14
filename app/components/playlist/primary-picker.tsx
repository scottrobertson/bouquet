import { CornerDownRight } from "lucide-react";
import { useState } from "react";
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

/** Pick a playlist channel to group the current selection under, as alternates.
    Searchable since a playlist can hold a lot of channels. */
export function PrimaryPicker({
  primaries,
  onPick,
  label,
}: {
  primaries: { id: number; name: string; hint?: string }[];
  onPick: (id: number) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);

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
            <CommandGroup>
              {primaries.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.id}`}
                  onSelect={() => {
                    onPick(p.id);
                    setOpen(false);
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="break-words">{p.name}</span>
                  {p.hint ? (
                    <span className="text-[11px] text-muted-foreground">
                      {p.hint}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
