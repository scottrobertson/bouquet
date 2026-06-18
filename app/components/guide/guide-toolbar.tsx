import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { fmtDay } from "./layout";

export const ALL_GROUPS = "__all__";

export function GuideToolbar({
  groups,
  group,
  onGroupChange,
  dayMs,
  onPan,
  onNow,
  needsSync,
}: {
  groups: string[];
  group: string;
  onGroupChange: (g: string) => void;
  // The day on screen, for the date label.
  dayMs: number;
  // Scroll the timeline back (-1) or forward (1) by about a screen.
  onPan: (dir: -1 | 1) => void;
  onNow: () => void;
  needsSync: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; count: number }>();
  const refreshing = fetcher.state !== "idle";
  const notified = useRef(false);

  useEffect(() => {
    if (refreshing) {
      notified.current = false;
    } else if (fetcher.data?.ok && !notified.current) {
      notified.current = true;
      toast.success("Refreshing the guide in the background. Check back shortly.");
    }
  }, [refreshing, fetcher.data]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 md:px-6">
      <Select value={group} onValueChange={onGroupChange}>
        <SelectTrigger size="sm" className="w-[180px]">
          <SelectValue placeholder="All groups" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_GROUPS}>All groups</SelectItem>
          {groups.map((g) => (
            <SelectItem key={g} value={g}>
              {g}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center">
        <Button
          variant="outline"
          size="icon"
          className="size-8 rounded-r-none"
          onClick={() => onPan(-1)}
          aria-label="Scroll back in time"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8 rounded-l-none border-l-0"
          onClick={() => onPan(1)}
          aria-label="Scroll forward in time"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <span className="text-[13px] text-muted-foreground tabular-nums">
        {fmtDay(dayMs)}
      </span>

      <Button variant="outline" size="sm" onClick={onNow}>
        <Clock className="size-4" />
        Now
      </Button>

      <div className="ml-auto flex items-center gap-2">
        {needsSync ? (
          <span className="flex items-center gap-1.5 text-[13px] text-warning">
            <TriangleAlert className="size-4" />
            <span className="hidden sm:inline">Guide may be out of date</span>
          </span>
        ) : null}
        <fetcher.Form method="post">
          <Button type="submit" variant="outline" size="sm" disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh
          </Button>
        </fetcher.Form>
      </div>
    </div>
  );
}
