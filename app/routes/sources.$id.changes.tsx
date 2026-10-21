import { ArrowLeft, History } from "lucide-react";
import type { SourceChangesData } from "~/api/types/SourceChangesData";
import { apiLoad } from "~/lib/api";
import { Link, useNavigate } from "react-router";
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/page-header";
import { RelativeTime } from "~/components/relative-time";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/sources.$id.changes";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Changes · ${loaderData?.source.name ?? "Source"} · Bouquet` }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<SourceChangesData>(request);
}
type Kind =
  | "channel_added"
  | "channel_returned"
  | "channel_removed"
  | "category_added"
  | "category_removed";

const isAdd = (k: Kind) =>
  k === "channel_added" || k === "category_added" || k === "channel_returned";

const KIND: Record<Kind, { label: string; className: string }> = {
  channel_added: { label: "Added", className: "bg-success/10 text-success" },
  channel_returned: { label: "Returned", className: "bg-warning/10 text-warning" },
  channel_removed: { label: "Removed", className: "bg-destructive/10 text-destructive" },
  category_added: { label: "Category added", className: "bg-success/10 text-success" },
  category_removed: {
    label: "Category removed",
    className: "bg-destructive/10 text-destructive",
  },
};

export default function SourceChanges({ loaderData }: Route.ComponentProps) {
  const { source, syncs, selectedAt, changes } = loaderData;
  const navigate = useNavigate();

  const items = [...changes].sort(
    (a, b) =>
      Number(isAdd(a.kind)) - Number(isAdd(b.kind)) || a.name.localeCompare(b.name),
  );

  return (
    <div>
      <PageHeader
        title="Changes"
        description={`What ${source.name} added and removed on each sync.`}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to={`/sources/${source.id}`}>
              <ArrowLeft className="size-4" />
              Back to source
            </Link>
          </Button>
        }
      />

      {syncs.length === 0 ? (
        <div className="px-4 py-5 md:px-8 md:py-6">
          <EmptyState
            icon={History}
            title="No changes recorded yet"
            description="They show up here after a sync finds channels or categories the provider added or removed."
          />
        </div>
      ) : (
        <div className="grid gap-4 px-4 py-5 md:grid-cols-[260px_minmax(0,1fr)] md:gap-6 md:px-8 md:py-6">
          {/* Sync picker: a sidebar list on desktop, a dropdown on mobile. */}
          <aside className="hidden md:block">
            <div className="sticky top-0 max-h-[calc(100vh-9rem)] space-y-0.5 overflow-y-auto pr-1">
              {syncs.map((s) => (
                <Link
                  key={s.at}
                  to={`?at=${s.at}`}
                  preventScrollReset
                  className={cn(
                    "flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors",
                    s.at === selectedAt
                      ? "bg-white/[0.06]"
                      : "hover:bg-white/[0.03]",
                  )}
                >
                  <span className="text-[13px] font-medium">
                    <RelativeTime date={s.syncedAt} />
                  </span>
                  <span className="flex items-center gap-1.5 text-xs tabular-nums">
                    {s.added > 0 ? (
                      <span className="text-success">+{s.added}</span>
                    ) : null}
                    {s.removed > 0 ? (
                      <span className="text-destructive">−{s.removed}</span>
                    ) : null}
                  </span>
                </Link>
              ))}
            </div>
          </aside>

          <div className="min-w-0 space-y-3">
            <div className="md:hidden">
              <Select
                value={selectedAt ?? undefined}
                onValueChange={(v) => navigate(`?at=${v}`, { preventScrollReset: true })}
              >
                <SelectTrigger className="w-full">
                  <span className="truncate">
                    {selectedAt ? (
                      <RelativeTime
                        date={
                          syncs.find((s) => s.at === selectedAt)?.syncedAt ?? null
                        }
                      />
                    ) : (
                      "Pick a sync"
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {syncs.map((s) => (
                    <SelectItem key={s.at} value={s.at}>
                      <RelativeTime date={s.syncedAt} /> (+{s.added} −{s.removed})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5 hover:bg-transparent">
                    <TableHead className="w-40">Change</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Playlists</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((c) => (
                    <TableRow key={c.id} className="border-white/5">
                      <TableCell>
                        <Badge className={cn("border-transparent", KIND[c.kind].className)}>
                          {KIND[c.kind].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.categoryName ?? "—"}
                      </TableCell>
                      <TableCell>
                        {c.playlists.length ? (
                          <div className="flex flex-wrap gap-1">
                            {c.playlists.map((p) => (
                              <Badge
                                key={p.id}
                                className="border-transparent bg-secondary font-normal text-muted-foreground"
                              >
                                {p.name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
