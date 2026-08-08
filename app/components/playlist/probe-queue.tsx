import { Loader2 } from "lucide-react";
import type { EditorChannel } from "./types";

// Long queues are the normal case, so only the first slice is rendered and the
// rest is summed up at the bottom.
const MAX_ROWS = 60;

type QueuedChannel = {
  id: number;
  name: string;
  provider: string;
  running: boolean;
};

/** The channels a running probe is working through: the ones on a stream right
    now first, then the ones still waiting. */
export function probeQueue(channels: EditorChannel[]): QueuedChannel[] {
  const rows = channels
    .filter((c) => c.probeStatus === "probing" || c.probeStatus === "queued")
    .map((c) => ({
      id: c.id,
      name: c.customName || c.autoName,
      provider: c.sourceProviderName,
      running: c.probeStatus === "probing",
    }));
  return [...rows.filter((r) => r.running), ...rows.filter((r) => !r.running)];
}

/** Live list of what a probe is doing, shown when you hover the header button. */
export function ProbeQueue({ queue }: { queue: QueuedChannel[] }) {
  const running = queue.filter((r) => r.running).length;
  const waiting = queue.length - running;
  const hidden = queue.length - MAX_ROWS;

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <div className="text-[13px] font-medium">Probing</div>
        <div className="text-xs text-muted-foreground">
          {running} in progress, {waiting} waiting
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {queue.slice(0, MAX_ROWS).map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-2 px-3 py-1 text-xs"
          >
            {row.running ? (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : (
              <span className="size-3 shrink-0 text-center text-muted-foreground/50">
                ·
              </span>
            )}
            <span className={row.running ? "truncate" : "truncate text-muted-foreground"}>
              {row.name}
            </span>
            <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground/60">
              {row.provider}
            </span>
          </div>
        ))}
        {hidden > 0 ? (
          <div className="px-3 py-1 text-[11px] text-muted-foreground/60">
            and {hidden} more
          </div>
        ) : null}
      </div>
    </>
  );
}
