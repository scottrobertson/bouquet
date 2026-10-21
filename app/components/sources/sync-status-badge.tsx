import { Badge } from "~/components/ui/badge";
import type { SyncStatus } from "~/api/types/SyncStatus";

const STYLES: Record<SyncStatus, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-success/10 text-success border-transparent" },
  error: { label: "Error", className: "bg-destructive/10 text-destructive border-transparent" },
  syncing: { label: "Syncing", className: "bg-warning/10 text-warning border-transparent" },
  idle: { label: "Idle", className: "bg-muted text-muted-foreground border-transparent" },
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const s = STYLES[status];
  return <Badge className={s.className}>{s.label}</Badge>;
}
