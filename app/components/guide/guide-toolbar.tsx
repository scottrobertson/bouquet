import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useFetcher, useSearchParams } from "react-router";
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

const DAY_MS = 24 * 3_600_000;
export const ALL_GROUPS = "__all__";

export function GuideToolbar({
  groups,
  group,
  onGroupChange,
  atMs,
  onNow,
  needsSync,
}: {
  groups: string[];
  group: string;
  onGroupChange: (g: string) => void;
  atMs: number;
  onNow: () => void;
  needsSync: boolean;
}) {
  const [, setSearchParams] = useSearchParams();
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

  function shiftDay(delta: number) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("at", String(atMs + delta * DAY_MS));
        return next;
      },
      { preventScrollReset: true },
    );
  }

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
          onClick={() => shiftDay(-1)}
          aria-label="Previous day"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8 rounded-l-none border-l-0"
          onClick={() => shiftDay(1)}
          aria-label="Next day"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <span className="text-[13px] text-muted-foreground tabular-nums">
        {fmtDay(atMs)}
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
