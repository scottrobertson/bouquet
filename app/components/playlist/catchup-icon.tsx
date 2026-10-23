import { Rewind } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

/** Marks a channel the provider keeps catchup for. Nothing when it has none. */
export function CatchupIcon({ days }: { days: number }) {
  if (days <= 0) return null;
  const label = `${days} day${days === 1 ? "" : "s"} of catchup`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          onPointerDown={(e) => e.stopPropagation()}
          className="shrink-0 cursor-default text-muted-foreground"
          aria-label={label}
        >
          <Rewind className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
