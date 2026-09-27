import { Copy, MoreVertical, Play } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/** Try a stream in VLC or copy its URL. Clicks are stopped here so opening the
    menu doesn't also select the row it sits in. */
export function StreamMenu({ streamUrl }: { streamUrl: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Icon stays small but the tap target stretches to ~44px so it's easy to hit on mobile.
          className="relative size-7 shrink-0 cursor-pointer text-muted-foreground before:absolute before:-inset-2 before:content-[''] hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem asChild>
          <a href={`vlc://${streamUrl}`}>
            <Play className="size-4" />
            Play in VLC
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigator.clipboard.writeText(streamUrl)}
        >
          <Copy className="size-4" />
          Copy stream URL
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
