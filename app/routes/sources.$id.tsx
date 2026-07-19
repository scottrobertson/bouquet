import { eq } from "drizzle-orm";
import { Check, Gauge, History, Loader2, Pencil, Power, PowerOff, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useFetchers,
  useNavigation,
} from "react-router";
import { toast } from "sonner";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { PageHeader } from "~/components/page-header";
import { SyncStatusBadge } from "~/components/sources/sync-status-badge";
import {
  expiryLabel,
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
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { db } from "~/db/index.server";
import { sources } from "~/db/schema";
import { invalidateAll } from "~/services/output/cache.server";
import {
  listSourceCategories,
  setAllSourceCategories,
  setSourceCategoryEnabled,
} from "~/services/sources/categories.server";
import { startSync } from "~/services/sync/sync.server";
import { startProbe } from "~/services/probe/probe.server";
import { ProbeStatusBadge } from "~/components/sources/probe-status-badge";
import type { Route } from "./+types/sources.$id";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.source.name ?? "Source"} · Bouquet` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const source = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!source) throw new Response("Not found", { status: 404 });

  return {
    source: {
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      syncStatus: source.syncStatus,
      lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
      channelCount: source.channelCount,
      lastError: source.lastError,
      epgStale: source.epgStale,
      syncIntervalMinutes: source.syncIntervalMinutes,
      // Undefined before the first sync reads these, so the UI can say
      // "Unknown" rather than "Never"/"—".
      expiresAt: source.lastSyncedAt
        ? (source.expiresAt ? source.expiresAt.toISOString() : null)
        : undefined,
      maxConnections: source.lastSyncedAt ? source.maxConnections : undefined,
      accountStatus: source.accountStatus,
      probeEnabled: source.probeEnabled,
      probeStatus: source.probeStatus,
      probeIntervalMinutes: source.probeIntervalMinutes,
      lastProbedAt: source.lastProbedAt ? source.lastProbedAt.toISOString() : null,
      probeTotal: source.probeTotal,
      probeDone: source.probeDone,
      probeError: source.probeError,
    },
    categories: listSourceCategories(id),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "sync") {
    startSync(id);
    return data({ intent: "sync" as const, started: true });
  }

  if (intent === "probe") {
    startProbe(id);
    return data({ intent: "probe" as const, started: true });
  }

  if (intent === "setEnabled") {
    const enabled = form.get("enabled") === "true";
    db.update(sources).set({ enabled }).where(eq(sources.id, id)).run();
    invalidateAll();
    return data({ intent: "setEnabled" as const, enabled });
  }

  if (intent === "delete") {
    db.delete(sources).where(eq(sources.id, id)).run();
    return redirect("/sources");
  }

  if (intent === "toggleCategory") {
    setSourceCategoryEnabled(
      id,
      String(form.get("name") ?? ""),
      form.get("enabled") === "true",
    );
    invalidateAll();
    return data({ intent: "toggleCategory" as const, ok: true });
  }

  if (intent === "setAllCategories") {
    setAllSourceCategories(id, form.get("enabled") === "true");
    invalidateAll();
    return data({ intent: "setAllCategories" as const, ok: true });
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function SourceDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { source, categories } = loaderData;
  const onCount = categories.filter((c) => c.enabled).length;
  const offCount = categories.length - onCount;
  const offChannels = categories
    .filter((c) => !c.enabled)
    .reduce((sum, c) => sum + c.count, 0);
  const onChannels = Math.max(0, source.channelCount - offChannels);
  const navigation = useNavigation();
  const navIntent = navigation.formData?.get("intent");
  const submitting = navigation.state !== "idle" && navIntent === "sync";
  const syncing = submitting || source.syncStatus === "syncing";
  const probing =
    (navigation.state !== "idle" && navIntent === "probe") ||
    source.probeStatus === "probing";

  // Sync and probe both run in the background, so listen for live updates while
  // either is still going.
  useLiveRevalidate(
    source.syncStatus === "syncing" || source.probeStatus === "probing",
  );

  // Toast once when a background sync or probe is kicked off.
  const handled = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (!actionData || actionData === handled.current) return;
    handled.current = actionData;
    if ("intent" in actionData && actionData.intent === "sync") {
      toast("Sync started", { description: "Pulling the latest channels." });
    } else if ("intent" in actionData && actionData.intent === "probe") {
      toast("Probe started", {
        description: "Checking the quality of channels used in playlists.",
      });
    } else if ("intent" in actionData && actionData.intent === "setEnabled") {
      toast.success(actionData.enabled ? "Source enabled" : "Source disabled");
    }
  }, [actionData]);

  return (
    <div>
      <PageHeader
        border={false}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {source.name}
            {source.enabled ? null : (
              <Badge className="border-transparent bg-muted text-muted-foreground">
                Disabled
              </Badge>
            )}
            <SyncStatusBadge status={syncing ? "syncing" : source.syncStatus} />
            {probing || source.probeStatus !== "idle" ? (
              <ProbeStatusBadge
                status={probing ? "probing" : source.probeStatus}
                done={source.probeDone}
                total={source.probeTotal}
              />
            ) : null}
          </span>
        }
        actionsClassName="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center"
        actions={
          <>
            <Form method="post" className="contents">
              <Button type="submit" name="intent" value="sync" size="sm" variant="secondary" disabled={syncing} className="w-full sm:w-auto">
                <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
                {syncing ? "Syncing..." : "Sync now"}
              </Button>
            </Form>
            <Form method="post" className="contents">
              <Button type="submit" name="intent" value="probe" size="sm" variant="outline" disabled={probing} className="w-full sm:w-auto">
                <Gauge className={probing ? "size-4 animate-pulse" : "size-4"} />
                {probing ? "Probing..." : "Probe now"}
              </Button>
            </Form>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link to={`/sources/${source.id}/changes`}>
                <History className="size-4" />
                Changes
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link to={`/sources/${source.id}/edit`}>
                <Pencil className="size-4" />
                Edit
              </Link>
            </Button>
            <Form method="post" className="contents">
              <input type="hidden" name="enabled" value={String(!source.enabled)} />
              <Button type="submit" name="intent" value="setEnabled" size="sm" variant="outline" className="w-full sm:w-auto">
                {source.enabled ? (
                  <PowerOff className="size-4" />
                ) : (
                  <Power className="size-4" />
                )}
                {source.enabled ? "Disable" : "Enable"}
              </Button>
            </Form>
            <DeleteSourceButton name={source.name} />
          </>
        }
      />

      <div className="space-y-5 px-4 pb-5 pt-2 md:px-8 md:py-6">
        <div className="grid grid-cols-2 gap-2 text-[13px] sm:flex sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-2">
          <MetaCount
            label="Channels"
            total={source.channelCount}
            on={onChannels}
            off={offChannels}
          />
          <MetaCount
            label="Categories"
            total={categories.length}
            on={onCount}
            off={offCount}
          />
          <Meta label="Last synced" value={relativeTime(source.lastSyncedAt)} />
          <Meta label="Refresh" value={syncIntervalLabel(source.syncIntervalMinutes)} />
          <Meta
            label="Last probed"
            value={
              source.probeEnabled || source.lastProbedAt
                ? relativeTime(source.lastProbedAt)
                : "Off"
            }
          />
          <ExpiresMeta expiresAt={source.expiresAt} />
          <Meta label="Connections" value={connectionsLabel(source.maxConnections)} />
          {source.accountStatus ? (
            <Meta
              label="Status"
              value={source.accountStatus}
              className="hidden sm:flex"
            />
          ) : null}
        </div>

        {source.syncStatus === "error" && source.lastError ? (
          <div className="rounded-md border border-transparent bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {source.lastError}
          </div>
        ) : null}

        {source.probeStatus === "error" && source.probeError ? (
          <div className="rounded-md border border-transparent bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            Probe failed: {source.probeError}
          </div>
        ) : null}

        {source.epgStale ? (
          <div className="rounded-md border border-transparent bg-warning/10 px-3 py-2 text-[13px] text-warning">
            Categories changed since the last sync. Sync again to update the
            guide for the channels you turned on.
          </div>
        ) : null}

        <CategoriesPanel categories={categories} />
      </div>
    </div>
  );
}

function CategoriesPanel({
  categories,
}: {
  categories: { name: string; enabled: boolean; count: number }[];
}) {
  const [q, setQ] = useState("");
  const allFetcher = useFetcher();
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? categories.filter((c) => c.name.toLowerCase().includes(needle))
      : categories;
  }, [categories, q]);
  const offCount = categories.filter((c) => !c.enabled).length;

  if (categories.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-[13px] text-muted-foreground">
        No categories yet. Run a sync to pull the catalog.
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search categories..."
          className="h-9 w-full sm:h-8 sm:w-64"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-9 flex-1 sm:h-8 sm:flex-none"
            onClick={() =>
              allFetcher.submit(
                { intent: "setAllCategories", enabled: "true" },
                { method: "post" },
              )
            }
          >
            Enable all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9 flex-1 sm:h-8 sm:flex-none"
            onClick={() =>
              allFetcher.submit(
                { intent: "setAllCategories", enabled: "false" },
                { method: "post" },
              )
            }
          >
            Disable all
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 sm:ml-auto sm:justify-end">
          <SaveStatus />
          <span className="text-xs text-muted-foreground tabular-nums">
            {categories.length - offCount} of {categories.length} enabled
          </span>
        </div>
      </div>

      <div className="-mx-4 divide-y divide-white/5 border-y border-border bg-card md:mx-0 md:rounded-lg md:border">
        {filtered.map((c) => (
          <CategoryRow key={c.name} category={c} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Disabled categories are hidden from playlists and dropped from output.
      </p>
    </div>
  );
}

function CategoryRow({
  category,
}: {
  category: { name: string; enabled: boolean; count: number };
}) {
  const fetcher = useFetcher();
  const enabled =
    fetcher.formData?.get("intent") === "toggleCategory"
      ? fetcher.formData.get("enabled") === "true"
      : category.enabled;

  return (
    <label className="flex cursor-pointer items-center gap-3 px-4 py-3 sm:px-3 sm:py-2.5">
      <Switch
        checked={enabled}
        onCheckedChange={(v) =>
          fetcher.submit(
            { intent: "toggleCategory", name: category.name, enabled: String(v) },
            { method: "post" },
          )
        }
      />
      <span className={cn("text-sm sm:text-[13px]", !enabled && "text-muted-foreground")}>
        {category.name}
      </span>
      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
        {category.count.toLocaleString()}
      </span>
    </label>
  );
}

// Category toggles save through fetchers, so reflect their state.
function SaveStatus() {
  const fetchers = useFetchers();
  const saving = fetchers.some((f) => f.state !== "idle");
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {saving ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          Saving…
        </>
      ) : (
        <>
          <Check className="size-3.5 text-success" />
          Saved
        </>
      )}
    </span>
  );
}

// Cards on mobile, plain inline text from sm up.
const statCell =
  "flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:gap-2 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0";

// Label sits above the value on mobile, muted; inline from sm up.
const statLabel = "text-xs text-muted-foreground sm:text-[13px]";
// Value is prominent on the mobile card, normal inline text on desktop.
const statValue = "text-base font-semibold tabular-nums sm:text-[13px] sm:font-medium";

function Meta({
  label,
  value,
  valueClassName,
  className,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn(statCell, className)}>
      <span className={statLabel}>{label}</span>
      <span className={cn(statValue, valueClassName)}>{value}</span>
    </div>
  );
}

// Connection limit, or "—" when the provider doesn't report one. Undefined
// before the first sync.
function connectionsLabel(max: number | null | undefined): string {
  if (max === undefined) return "Unknown";
  if (max === null) return "—";
  return max.toLocaleString();
}

// Expiry date, tinted red once passed.
function ExpiresMeta({ expiresAt }: { expiresAt: string | null | undefined }) {
  const { text, expired } = expiryLabel(expiresAt);
  return (
    <Meta
      label="Expires"
      value={text}
      valueClassName={expired ? "text-destructive" : undefined}
    />
  );
}

// A total with an enabled/disabled (on/off) breakdown. The breakdown sits on
// its own line under the number so big channel counts never get cramped.
function MetaCount({
  label,
  total,
  on,
  off,
}: {
  label: string;
  total: number;
  on: number;
  off: number;
}) {
  return (
    <div className={cn(statCell, "sm:gap-2.5")}>
      <span className={statLabel}>{label}</span>
      <span className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2.5">
        <span className={statValue}>{total.toLocaleString()}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="flex items-center gap-1 whitespace-nowrap text-success">
            <span className="size-1.5 rounded-full bg-success" />
            {on.toLocaleString()} on
          </span>
          {off > 0 ? (
            <span className="flex items-center gap-1 whitespace-nowrap text-warning">
              <span className="size-1.5 rounded-full bg-warning" />
              {off.toLocaleString()} off
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

function DeleteSourceButton({ name }: { name: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="w-full border bg-background text-destructive hover:text-destructive dark:border-input dark:bg-input/30 sm:w-auto sm:border-0 sm:bg-transparent sm:shadow-none">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the source and its channel catalog. Playlists lose any
            channels that came from it. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Form method="post">
            <AlertDialogAction
              type="submit"
              name="intent"
              value="delete"
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </Form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
