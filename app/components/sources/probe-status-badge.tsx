import { Badge } from "~/components/ui/badge";
import type { Source } from "~/db/schema";

const STYLES: Record<Source["probeStatus"], { label: string; className: string }> = {
  ok: { label: "Probed", className: "bg-success/10 text-success border-transparent" },
  error: { label: "Probe error", className: "bg-destructive/10 text-destructive border-transparent" },
  probing: { label: "Probing", className: "bg-warning/10 text-warning border-transparent" },
  idle: { label: "Not probed", className: "bg-muted text-muted-foreground border-transparent" },
};

/** Probe status, with the live count while a probe is running. */
export function ProbeStatusBadge({
  status,
  done,
  total,
}: {
  status: Source["probeStatus"];
  done?: number;
  total?: number;
}) {
  const s = STYLES[status];
  const label =
    status === "probing" && total && total > 0
      ? `Probing ${done ?? 0}/${total}`
      : s.label;
  return <Badge className={s.className}>{label}</Badge>;
}
