import { eq } from "drizzle-orm";
import { MoreHorizontal, Plus, Radio, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, data, useFetcher, useRevalidator } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/page-header";
import { SyncStatusBadge } from "~/components/sources/sync-status-badge";
import { hostFromUrl, relativeTime } from "~/components/sources/source-shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { db } from "~/db/index.server";
import { sources } from "~/db/schema";
import { startSync } from "~/services/sync/sync.server";
import type { Route } from "./+types/sources._index";

export function meta() {
  return [{ title: "Sources · Bouquet" }];
}

export async function loader() {
  const rows = db.select().from(sources).all();
  return {
    sources: rows.map((s) => ({
      id: s.id,
      name: s.name,
      host: hostFromUrl(s.serverUrl),
      syncStatus: s.syncStatus,
      channelCount: s.channelCount,
      lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "syncAll") {
    const ids = db.select({ id: sources.id }).from(sources).all().map((r) => r.id);
    for (const sourceId of ids) startSync(sourceId);
    return data({ intent: "syncAll" as const, started: ids.length });
  }

  const id = Number(form.get("id"));
  if (!Number.isFinite(id)) {
    return data({ ok: false, error: "Missing source" }, { status: 400 });
  }

  if (intent === "sync") {
    startSync(id);
    return data({ intent: "sync" as const, started: true });
  }

  if (intent === "delete") {
    db.delete(sources).where(eq(sources.id, id)).run();
    return data({ intent: "delete" as const, ok: true });
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function SourcesIndex({ loaderData }: Route.ComponentProps) {
  const { sources: rows } = loaderData;

  // Syncs run in the background, so poll while any source is still syncing.
  const revalidator = useRevalidator();
  const anySyncing = rows.some((s) => s.syncStatus === "syncing");
  useEffect(() => {
    if (!anySyncing) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(t);
  }, [anySyncing, revalidator]);

  // Sync every source at once.
  const syncAllFetcher = useFetcher<typeof action>();
  const startingAll = syncAllFetcher.state !== "idle";
  const handledAll = useRef<typeof syncAllFetcher.data>(undefined);
  useEffect(() => {
    if (syncAllFetcher.state !== "idle" || !syncAllFetcher.data) return;
    if (syncAllFetcher.data === handledAll.current) return;
    handledAll.current = syncAllFetcher.data;
    const res = syncAllFetcher.data;
    if ("intent" in res && res.intent === "syncAll") {
      toast(`Syncing ${res.started} source${res.started === 1 ? "" : "s"}`, {
        description: "Pulling channels in the background.",
      });
    }
  }, [syncAllFetcher.state, syncAllFetcher.data]);

  return (
    <div>
      <PageHeader
        title="Sources"
        description="IPTV providers feeding your playlists."
        actions={
          <>
            {rows.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={startingAll || anySyncing}
                onClick={() =>
                  syncAllFetcher.submit({ intent: "syncAll" }, { method: "post" })
                }
              >
                <RefreshCw
                  className={
                    startingAll || anySyncing ? "size-4 animate-spin" : "size-4"
                  }
                />
                Sync all
              </Button>
            ) : null}
            <Button asChild size="sm">
              <Link to="/sources/new">
                <Plus className="size-4" />
                Add source
              </Link>
            </Button>
          </>
        }
      />
      <div className="px-4 py-5 md:px-8 md:py-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={Radio}
            title="No sources yet"
            description="Add an Xtream Codes provider to pull in its channel catalog."
            action={
              <Button asChild size="sm">
                <Link to="/sources/new">
                  <Plus className="size-4" />
                  Add source
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <Th>Name</Th>
                  <Th>Host</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Channels</Th>
                  <Th>Last synced</Th>
                  <Th className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <SourceRow key={s.id} source={s} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

type Row = Route.ComponentProps["loaderData"]["sources"][number];

function SourceRow({ source }: { source: Row }) {
  const fetcher = useFetcher<typeof action>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submitting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "sync";
  const syncing = submitting || source.syncStatus === "syncing";

  // Report sync results once the fetcher settles.
  const handled = useRef<typeof fetcher.data>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data === handled.current) return;
    handled.current = fetcher.data;
    const res = fetcher.data;
    if (!("intent" in res)) return;
    if (res.intent === "sync") {
      toast(`Syncing ${source.name}`, {
        description: "Pulling channels in the background.",
      });
    } else if (res.intent === "delete" && res.ok) {
      toast.success(`Deleted ${source.name}`);
    }
  }, [fetcher.state, fetcher.data, source.name]);

  return (
    <TableRow className="border-white/5 hover:bg-white/[0.02]">
      <TableCell className="font-medium">
        <Link to={`/sources/${source.id}`} className="hover:text-primary">
          {source.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {source.host}
      </TableCell>
      <TableCell>
        {syncing ? <SyncStatusBadge status="syncing" /> : <SyncStatusBadge status={source.syncStatus} />}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {source.channelCount.toLocaleString()}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {relativeTime(source.lastSyncedAt)}
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => fetcher.submit({ intent: "sync", id: source.id }, { method: "post" })}
              disabled={syncing}
            >
              <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
              Sync now
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`/sources/${source.id}/edit`}>Edit</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {source.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the source and its channel catalog. Playlists lose any
                channels that came from it. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => fetcher.submit({ intent: "delete", id: source.id }, { method: "post" })}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <TableHead
      className={
        "h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground" +
        (className ? ` ${className}` : "")
      }
    >
      {children}
    </TableHead>
  );
}
