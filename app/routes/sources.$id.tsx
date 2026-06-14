import { eq } from "drizzle-orm";
import { Check, History, Loader2, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useFetchers,
  useNavigation,
  useRevalidator,
} from "react-router";
import { toast } from "sonner";
import { PageHeader } from "~/components/page-header";
import { SyncStatusBadge } from "~/components/sources/sync-status-badge";
import { relativeTime } from "~/components/sources/source-shared";
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
import type { Route } from "./+types/sources.$id";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.source.name ?? "Source"} · Bouquet` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const source = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!source) throw new Response("Not found", { status: 404 });

  return {
    source: {
      id: source.id,
      name: source.name,
      syncStatus: source.syncStatus,
      lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
      channelCount: source.channelCount,
      lastError: source.lastError,
      epgStale: source.epgStale,
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
  const submitting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "sync";
  const syncing = submitting || source.syncStatus === "syncing";

  // Sync runs in the background, so poll the loader until it finishes.
  const revalidator = useRevalidator();
  useEffect(() => {
    if (source.syncStatus !== "syncing") return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(t);
  }, [source.syncStatus, revalidator]);

  // Toast once when a background sync is kicked off.
  const handled = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (!actionData || actionData === handled.current) return;
    handled.current = actionData;
    if ("intent" in actionData && actionData.intent === "sync") {
      toast("Sync started", { description: "Pulling the latest channels." });
    }
  }, [actionData]);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {source.name}
            <SyncStatusBadge status={syncing ? "syncing" : source.syncStatus} />
          </span>
        }
        actions={
          <>
            <Form method="post">
              <Button type="submit" name="intent" value="sync" size="sm" variant="secondary" disabled={syncing}>
                <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
                {syncing ? "Syncing..." : "Sync now"}
              </Button>
            </Form>
            <Button asChild size="sm" variant="outline">
              <Link to={`/sources/${source.id}/changes`}>
                <History className="size-4" />
                Changes
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`/sources/${source.id}/edit`}>
                <Pencil className="size-4" />
                Edit
              </Link>
            </Button>
            <DeleteSourceButton name={source.name} />
          </>
        }
      />

      <div className="space-y-5 px-4 py-5 md:px-8 md:py-6">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-[13px]">
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
        </div>

        {source.syncStatus === "error" && source.lastError ? (
          <div className="rounded-md border border-transparent bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {source.lastError}
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search categories..."
          className="h-8 w-64"
        />
        <Button
          size="sm"
          variant="outline"
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
          onClick={() =>
            allFetcher.submit(
              { intent: "setAllCategories", enabled: "false" },
              { method: "post" },
            )
          }
        >
          Disable all
        </Button>
        <div className="ml-auto flex items-center gap-3">
          <SaveStatus />
          <span className="text-xs text-muted-foreground tabular-nums">
            {categories.length - offCount} of {categories.length} enabled
          </span>
        </div>
      </div>

      <div className="divide-y divide-white/5 rounded-lg border border-border bg-card">
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
    <div className="flex items-center gap-3 px-3 py-2">
      <Switch
        checked={enabled}
        onCheckedChange={(v) =>
          fetcher.submit(
            { intent: "toggleCategory", name: category.name, enabled: String(v) },
            { method: "post" },
          )
        }
      />
      <span className={cn("text-[13px]", !enabled && "text-muted-foreground")}>
        {category.name}
      </span>
      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
        {category.count.toLocaleString()}
      </span>
    </div>
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

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

// A total with an enabled/disabled (on/off) breakdown.
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
    <div className="flex items-center gap-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{total.toLocaleString()}</span>
      <span className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 text-success">
          <span className="size-1.5 rounded-full bg-success" />
          {on.toLocaleString()} on
        </span>
        {off > 0 ? (
          <span className="flex items-center gap-1 text-warning">
            <span className="size-1.5 rounded-full bg-warning" />
            {off.toLocaleString()} off
          </span>
        ) : null}
      </span>
    </div>
  );
}

function DeleteSourceButton({ name }: { name: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
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
