import { Badge } from "~/components/ui/badge";
import type { UploadDestination } from "~/db/schema";

const STYLES: Record<
  UploadDestination["uploadStatus"],
  { label: string; className: string }
> = {
  ok: { label: "Uploaded", className: "bg-success/10 text-success border-transparent" },
  error: { label: "Error", className: "bg-destructive/10 text-destructive border-transparent" },
  uploading: { label: "Uploading", className: "bg-warning/10 text-warning border-transparent" },
  idle: { label: "Not uploaded", className: "bg-muted text-muted-foreground border-transparent" },
};

export function UploadStatusBadge({
  status,
}: {
  status: UploadDestination["uploadStatus"];
}) {
  const s = STYLES[status];
  return <Badge className={s.className}>{s.label}</Badge>;
}
