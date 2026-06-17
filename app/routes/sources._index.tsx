import { eq } from "drizzle-orm";
import { Gauge, MoreHorizontal, Plus, Radio, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, data, useFetcher, useRevalidator } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/page-header";
import { SyncStatusBadge } from "~/components/sources/sync-status-badge";
import { ProbeStatusBadge } from "~/components/sources/probe-status-badge";
import {
  expiryLabel,
  hostFromUrl,
  relativeTime,
  syncIntervalLabel,
} from "~/components/sources/source-shared";
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
import { sourceCategorySummaries } from "~/services/sources/categories.server";
import { startSync } from "~/services/sync/sync.server";
import { startProbe } from "~/services/probe/probe.server";
import type { Route } from "./+types/sources._index";

export function meta() {
  return [{ title: "Sources · Bouquet" }];
}

export async function loader() {
  const rows = db.select().from(sources).all();
  // Enabled/total channel and category counts for all sources in two queries,
  // rather than a pair per source.
  const summaries = sourceCategorySummaries();
  return {
    sources: rows.map((s) => {
      const summary = summaries.get(s.id);
      const offChannels = summary?.offChannels ?? 0;
      return {
        id: s.id,
        name: s.name,
        host: hostFromUrl(s.serverUrl),
        username: s.username,
        outputFormat: s.outputFormat,
        syncIntervalMinutes: s.syncIntervalMinutes,
        syncStatus: s.syncStatus,
        probeStatus: s.probeStatus,
        probeDone: s.probeDone,
        probeTotal: s.probeTotal,
        channelCount: s.channelCount,
        channelsOn: Math.max(0, s.channelCount - offChannels),
        categoriesTotal: summary?.categoriesTotal ?? 0,
        categoriesOn: summary?.categoriesOn ?? 0,
        lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
        // Undefined before the first sync reads these, so the UI can say
        // "Unknown" rather than "Never"/"—".
        expiresAt: s.lastSyncedAt
          ? (s.expiresAt ? s.expiresAt.toISOString() : null)
          : undefined,
        maxConnections: s.lastSyncedAt ? s.maxConnections : undefined,
      };
    }),
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

  if (intent === "probe") {
    startProbe(id);
    return data({ intent: "probe" as const, started: true });
  }

  if (intent === "delete") {
    db.delete(sources).where(eq(sources.id, id)).run();
    return data({ intent: "delete" as const, ok: true });
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function SourcesIndex({ loaderData }: Route.ComponentProps) {
  const { sources: rows } = loaderData;

  // Syncs and probes run in the background, so poll while either is going.
  const revalidator = useRevalidator();
  const anySyncing = rows.some((s) => s.syncStatus === "syncing");
  const anyProbing = rows.some((s) => s.probeStatus === "probing");
  useEffect(() => {
    if (!anySyncing && !anyProbing) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(t);
  }, [anySyncing, anyProbing, revalidator]);

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
        border={false}
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {rows.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
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
            <Button asChild size="sm" className="w-full sm:w-auto">
              <Link to="/sources/new">
                <Plus className="size-4" />
                Add source
              </Link>
            </Button>
          </div>
        }
      />
      <div className="px-4 pb-5 pt-2 md:px-8 md:py-6">
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
          <div className="-mx-4 border-y border-border bg-card md:mx-0 md:rounded-lg md:border">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <Th className="pl-4 md:pl-2">Name</Th>
                  <Th className="hidden md:table-cell">Host</Th>
                  <Th className="hidden md:table-cell">Username</Th>
                  <Th className="hidden md:table-cell">Format</Th>
                  <Th className="hidden md:table-cell">Refresh</Th>
                  <Th className="hidden md:table-cell">Status</Th>
                  <Th className="hidden text-right md:table-cell">Channels</Th>
                  <Th className="hidden text-right md:table-cell">Categories</Th>
                  <Th className="hidden text-right md:table-cell">Expires</Th>
                  <Th className="hidden text-right md:table-cell">Connections</Th>
                  <Th className="text-right">Last synced</Th>
                  <Th className="w-10 pr-4 md:pr-2" />
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
  const probing =
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "probe") ||
    source.probeStatus === "probing";

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
    } else if (res.intent === "probe") {
      toast(`Probing ${source.name}`, {
        description: "Checking stream quality in the background.",
      });
    } else if (res.intent === "delete" && res.ok) {
      toast.success(`Deleted ${source.name}`);
    }
  }, [fetcher.state, fetcher.data, source.name]);

  const statusBadge = (
    <div className="flex flex-wrap items-center gap-1.5">
      <SyncStatusBadge status={syncing ? "syncing" : source.syncStatus} />
      {source.probeStatus === "probing" ? (
        <ProbeStatusBadge
          status="probing"
          done={source.probeDone}
          total={source.probeTotal}
        />
      ) : null}
    </div>
  );

  return (
    <TableRow className="border-white/5 hover:bg-white/[0.02]">
      <TableCell className="pl-4 font-medium md:pl-2">
        <Link to={`/sources/${source.id}`} className="hover:text-primary">
          {source.name}
        </Link>
      </TableCell>
      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
        {source.host}
      </TableCell>
      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
        {source.username}
      </TableCell>
      <TableCell className="hidden text-muted-foreground uppercase md:table-cell">
        {source.outputFormat}
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">
        {syncIntervalLabel(source.syncIntervalMinutes)}
      </TableCell>
      <TableCell className="hidden md:table-cell">{statusBadge}</TableCell>
      <TableCell className="hidden text-right tabular-nums md:table-cell">
        <OnOfTotal on={source.channelsOn} total={source.channelCount} />
      </TableCell>
      <TableCell className="hidden text-right tabular-nums md:table-cell">
        <OnOfTotal on={source.categoriesOn} total={source.categoriesTotal} />
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground md:table-cell">
        <ExpiresCell expiresAt={source.expiresAt} />
      </TableCell>
      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
        {connectionsLabel(source.maxConnections)}
      </TableCell>
      <TableCell className="text-right text-muted-foreground">
        <div className="flex items-center justify-end gap-2">
          {/* On mobile the status column is hidden, so show the badge here next
              to the time. */}
          <span className="md:hidden">{statusBadge}</span>
          {relativeTime(source.lastSyncedAt)}
        </div>
      </TableCell>
      <TableCell className="pr-4 text-right md:pr-2">
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
            <DropdownMenuItem
              onSelect={() => fetcher.submit({ intent: "probe", id: source.id }, { method: "post" })}
              disabled={probing}
            >
              <Gauge className={probing ? "size-4 animate-pulse" : "size-4"} />
              Probe now
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

// Connection limit, or "—" when the provider doesn't report one. Undefined
// before the first sync.
function connectionsLabel(max: number | null | undefined): string {
  if (max === undefined) return "Unknown";
  if (max === null) return "—";
  return max.toLocaleString();
}

// Expiry date, tinted red once it's passed.
function ExpiresCell({ expiresAt }: { expiresAt: string | null | undefined }) {
  const { text, expired } = expiryLabel(expiresAt);
  return <span className={expired ? "text-destructive" : undefined}>{text}</span>;
}

// Enabled out of total, e.g. "1,180 / 1,500". Total is muted.
function OnOfTotal({ on, total }: { on: number; total: number }) {
  return (
    <span>
      <span className="text-foreground">{on.toLocaleString()}</span>
      <span className="text-muted-foreground"> / {total.toLocaleString()}</span>
    </span>
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
