import { and, asc, eq } from "drizzle-orm";
import { ArrowLeft, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useActionData,
  useFetcher,
} from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "~/components/copy-field";
import { PageHeader } from "~/components/page-header";
import {
  DestinationDialog,
  type DestinationDTO,
} from "~/components/playlists/destination-dialog";
import { UploadStatusBadge } from "~/components/playlists/upload-status-badge";
import { RelativeTime } from "~/components/relative-time";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { externalOrigin } from "~/lib/url.server";
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
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { db } from "~/db/index.server";
import type { S3Config } from "~/db/schema";
import { playlists, uploadDestinations } from "~/db/schema";
import { getPlaylist } from "~/services/playlist/queries.server";
import { invalidate } from "~/services/output/cache.server";
import { startUpload } from "~/services/upload/upload.server";
import type { Route } from "./+types/playlists.$id.settings";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Settings · ${loaderData?.playlist.name ?? "Playlist"} · Bouquet` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });

  const origin = externalOrigin(request);

  const destinations = db
    .select()
    .from(uploadDestinations)
    .where(eq(uploadDestinations.playlistId, id))
    .orderBy(asc(uploadDestinations.id))
    .all()
    .map((d) => {
      // Redact the secret key: it never goes to the browser. Editing leaves the
      // field blank, which means "keep the stored one".
      const raw = d.config as Record<string, unknown>;
      const config: DestinationDTO["config"] = {
        endpoint: raw.endpoint as string | undefined,
        region: raw.region as string | undefined,
        bucket: raw.bucket as string | undefined,
        accessKeyId: raw.accessKeyId as string | undefined,
        forcePathStyle: raw.forcePathStyle as boolean | undefined,
        prefix: raw.prefix as string | undefined,
        path: raw.path as string | undefined,
      };
      const publicBase = d.publicUrlBase?.replace(/\/+$/, "");
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        enabled: d.enabled,
        m3uPath: d.m3uPath,
        epgPath: d.epgPath,
        publicUrlBase: d.publicUrlBase,
        uploadStatus: d.uploadStatus,
        lastUploadedAt: d.lastUploadedAt ? d.lastUploadedAt.toISOString() : null,
        uploadError: d.uploadError,
        config,
        publicM3uUrl: publicBase
          ? `${publicBase}/${d.m3uPath.replace(/^\/+/, "")}`
          : null,
        publicEpgUrl: publicBase
          ? `${publicBase}/${d.epgPath.replace(/^\/+/, "")}`
          : null,
      };
    });

  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      altNameTemplate: playlist.altNameTemplate,
      smartSortPrefer: playlist.smartSortPrefer,
      smartSortAudio: playlist.smartSortAudio,
      smartSortAvailableFirst: playlist.smartSortAvailableFirst,
      autoDisableFailedProbesAfter: playlist.autoDisableFailedProbesAfter,
    },
    m3uUrl: `${origin}/output/m3u/${playlist.outputToken}`,
    epgUrl: `${origin}/output/epg/${playlist.outputToken}`,
    destinations,
  };
}

const nameSchema = z.string().trim().min(1, "Name is required");

const destinationFields = z.object({
  name: z.string().trim().min(1, "Name is required"),
  type: z.enum(["s3", "local"]),
  m3uPath: z.string().trim().min(1).catch("playlist.m3u"),
  epgPath: z.string().trim().min(1).catch("playlist.xml"),
  publicUrlBase: z.string().trim(),
});

/** Build a destination's config from the form, validating per type. For an S3
    edit, a blank secret means keep the existing one. */
function parseConfig(
  form: FormData,
  type: "s3" | "local",
  existing?: S3Config,
): { config: Record<string, unknown> } | { error: string } {
  if (type === "s3") {
    const region = String(form.get("region") ?? "").trim();
    const bucket = String(form.get("bucket") ?? "").trim();
    const accessKeyId = String(form.get("accessKeyId") ?? "").trim();
    const secret = String(form.get("secretAccessKey") ?? "");
    const secretAccessKey = secret || existing?.secretAccessKey || "";
    if (!region) return { error: "Region is required" };
    if (!bucket) return { error: "Bucket is required" };
    if (!accessKeyId) return { error: "Access key ID is required" };
    if (!secretAccessKey) return { error: "Secret access key is required" };
    const endpoint = String(form.get("endpoint") ?? "").trim();
    const prefix = String(form.get("prefix") ?? "").trim();
    return {
      config: {
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        endpoint: endpoint || undefined,
        prefix: prefix || undefined,
        forcePathStyle: form.get("forcePathStyle") != null,
      },
    };
  }
  const path = String(form.get("path") ?? "").trim();
  if (!path) return { error: "Folder path is required" };
  return { config: { path } };
}

// The template must keep {name} so the primary's name shows, and {n} so each
// alternate gets a different number.
const templateSchema = z
  .string()
  .trim()
  .min(1, "Template is required")
  .refine((s) => s.includes("{name}"), "Must include {name}")
  .refine((s) => s.includes("{n}"), "Must include {n}");

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "renamePlaylist") {
    const parsed = nameSchema.safeParse(form.get("name"));
    if (!parsed.success) {
      return data({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    db.update(playlists).set({ name: parsed.data }).where(eq(playlists.id, id)).run();
    return data({ ok: true, intent });
  }

  if (intent === "setAltTemplate") {
    const parsed = templateSchema.safeParse(form.get("altNameTemplate"));
    if (!parsed.success) {
      return data({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    db.update(playlists)
      .set({ altNameTemplate: parsed.data })
      .where(eq(playlists.id, id))
      .run();
    // Names in the M3U change, so drop the cached output.
    invalidate(playlist.outputToken);
    return data({ ok: true, intent });
  }

  if (intent === "setSmartSort") {
    const prefer = form.get("smartSortPrefer") === "bitrate" ? "bitrate" : "resolution";
    db.update(playlists)
      .set({
        smartSortPrefer: prefer,
        // Switches only submit a value when on, so a missing field means off.
        smartSortAudio: form.get("smartSortAudio") != null,
        smartSortAvailableFirst: form.get("smartSortAvailableFirst") != null,
      })
      .where(eq(playlists.id, id))
      .run();
    return data({ ok: true, intent });
  }

  if (intent === "setAutoDisable") {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .max(20)
      .catch(3)
      .parse(form.get("autoDisableFailedProbesAfter"));
    db.update(playlists)
      .set({ autoDisableFailedProbesAfter: after })
      .where(eq(playlists.id, id))
      .run();
    return data({ ok: true, intent });
  }

  if (intent === "deletePlaylist") {
    db.delete(playlists).where(eq(playlists.id, id)).run();
    return redirect("/playlists");
  }

  if (intent === "addDestination" || intent === "updateDestination") {
    const fields = destinationFields.safeParse({
      name: form.get("name"),
      type: form.get("type"),
      m3uPath: form.get("m3uPath"),
      epgPath: form.get("epgPath"),
      publicUrlBase: form.get("publicUrlBase") ?? "",
    });
    if (!fields.success) {
      return data(
        { ok: false, error: fields.error.issues[0].message, intent },
        { status: 400 },
      );
    }

    // Keep the stored secret when an S3 edit leaves the field blank.
    let existing: S3Config | undefined;
    let destId: number | undefined;
    if (intent === "updateDestination") {
      destId = Number(form.get("id"));
      const row = db
        .select()
        .from(uploadDestinations)
        .where(
          and(
            eq(uploadDestinations.id, destId),
            eq(uploadDestinations.playlistId, id),
          ),
        )
        .get();
      if (!row) {
        return data({ ok: false, error: "Destination not found", intent }, { status: 404 });
      }
      if (row.type === "s3") existing = row.config as S3Config;
    }

    const parsed = parseConfig(form, fields.data.type, existing);
    if ("error" in parsed) {
      return data({ ok: false, error: parsed.error, intent }, { status: 400 });
    }

    const values = {
      name: fields.data.name,
      type: fields.data.type,
      config: parsed.config as never,
      m3uPath: fields.data.m3uPath,
      epgPath: fields.data.epgPath,
      publicUrlBase: fields.data.publicUrlBase || null,
    };

    if (intent === "addDestination") {
      db.insert(uploadDestinations).values({ playlistId: id, ...values }).run();
    } else {
      db.update(uploadDestinations)
        .set(values)
        .where(eq(uploadDestinations.id, destId!))
        .run();
    }
    return data({ ok: true, intent });
  }

  if (intent === "uploadDestination") {
    const destId = Number(form.get("id"));
    const row = db
      .select({ id: uploadDestinations.id })
      .from(uploadDestinations)
      .where(
        and(
          eq(uploadDestinations.id, destId),
          eq(uploadDestinations.playlistId, id),
        ),
      )
      .get();
    if (!row) {
      return data({ ok: false, error: "Destination not found", intent }, { status: 404 });
    }
    startUpload(destId);
    return data({ ok: true, intent });
  }

  if (intent === "deleteDestination") {
    const destId = Number(form.get("id"));
    db.delete(uploadDestinations)
      .where(
        and(
          eq(uploadDestinations.id, destId),
          eq(uploadDestinations.playlistId, id),
        ),
      )
      .run();
    return data({ ok: true, intent });
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function PlaylistSettings({ loaderData }: Route.ComponentProps) {
  const { playlist, m3uUrl, epgUrl, destinations } = loaderData;
  const actionData = useActionData<typeof action>();

  // Keep status badges live while an upload is running in the background.
  useLiveRevalidate(destinations.some((d) => d.uploadStatus === "uploading"));

  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.ok) {
      const messages: Record<string, string> = {
        setAltTemplate: "Naming saved",
        setSmartSort: "Smart sort saved",
        setAutoDisable: "Auto-disable saved",
        renamePlaylist: "Playlist renamed",
      };
      toast.success(messages[actionData.intent as string] ?? "Saved");
    }
  }, [actionData]);

  return (
    <div>
      <PageHeader
        title="Playlist settings"
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to={`/playlists/${playlist.id}`}>
              <ArrowLeft className="size-4" />
              Back to editor
            </Link>
          </Button>
        }
      />

      <div className="max-w-2xl space-y-8 px-4 py-5 md:px-8 md:py-6">
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Name</h2>
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="renamePlaylist" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="playlist-name" className="sr-only">
                Name
              </Label>
              <Input id="playlist-name" name="name" defaultValue={playlist.name} />
            </div>
            <Button type="submit" size="sm">
              Save
            </Button>
          </Form>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Alternate naming</h2>
          <p className="text-[13px] text-muted-foreground">
            How a channel's alternates are named automatically.{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{name}"}</code>{" "}
            is the channel's name,{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{n}"}</code>{" "}
            is the alternate number,{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{provider}"}</code>{" "}
            is the alternate's provider name and{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">
              {"{provider_letter}"}
            </code>{" "}
            is its first letter.
          </p>
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="setAltTemplate" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="alt-template" className="sr-only">
                Alternate naming template
              </Label>
              <Input
                id="alt-template"
                name="altNameTemplate"
                defaultValue={playlist.altNameTemplate}
                placeholder="{name} (Alt {n})"
              />
            </div>
            <Button type="submit" size="sm">
              Save
            </Button>
          </Form>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Smart sort</h2>
          <p className="text-[13px] text-muted-foreground">
            How "Smart sort" in an alt group's menu orders its streams. It uses
            probe data, so probe the group first to get the most out of it.
          </p>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="setSmartSort" />
            <div className="space-y-2">
              <Label htmlFor="smart-prefer">Rank by</Label>
              <Select
                name="smartSortPrefer"
                defaultValue={playlist.smartSortPrefer}
              >
                <SelectTrigger id="smart-prefer" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="resolution">
                    Resolution first, then bitrate
                  </SelectItem>
                  <SelectItem value="bitrate">
                    Bitrate first, then resolution
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Bitrate is compared per codec, so HEVC isn't punished for needing
                fewer bits.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="smart-audio">Use audio to break ties</Label>
                <p className="text-xs text-muted-foreground">
                  Prefer surround audio (E-AC-3, AC-3) over stereo when streams
                  are otherwise equal.
                </p>
              </div>
              <Switch
                id="smart-audio"
                name="smartSortAudio"
                defaultChecked={playlist.smartSortAudio}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="smart-available">Working streams first</Label>
                <p className="text-xs text-muted-foreground">
                  Sink streams that are unavailable or failed their last probe
                  below ones that work.
                </p>
              </div>
              <Switch
                id="smart-available"
                name="smartSortAvailableFirst"
                defaultChecked={playlist.smartSortAvailableFirst}
              />
            </div>
            <Button type="submit" size="sm">
              Save
            </Button>
          </Form>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Auto-disable failing channels</h2>
          <p className="text-[13px] text-muted-foreground">
            Turn a channel off automatically once its stream fails this many
            probes in a row. Set to 0 to never auto-disable. If a primary fails,
            a working alternate is promoted first so the group keeps playing.
          </p>
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="setAutoDisable" />
            <div className="space-y-2">
              <Label htmlFor="auto-disable">Failed probes in a row</Label>
              <Input
                id="auto-disable"
                name="autoDisableFailedProbesAfter"
                type="number"
                min={0}
                max={20}
                className="w-28"
                defaultValue={playlist.autoDisableFailedProbesAfter}
              />
            </div>
            <Button type="submit" size="sm">
              Save
            </Button>
          </Form>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Output URLs</h2>
          <p className="text-[13px] text-muted-foreground">
            Put these URLs into your IPTV player. The M3U is the channel list, the EPG is the guide.
          </p>
          <div className="space-y-3">
            <CopyField label="M3U" url={m3uUrl} />
            <CopyField label="EPG (XMLTV)" url={epgUrl} />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-medium">Upload destinations</h2>
            <DestinationDialog
              trigger={
                <Button size="sm" variant="outline">
                  Add destination
                </Button>
              }
            />
          </div>
          <p className="text-[13px] text-muted-foreground">
            Push this playlist's M3U and EPG to external storage so a player can point
            at those files instead of at Bouquet. Uploads run when you click Upload and
            automatically after a source syncs.
          </p>
          {destinations.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
              No destinations yet.
            </p>
          ) : (
            <div className="space-y-3">
              {destinations.map((d) => (
                <DestinationRow key={d.id} destination={d} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-destructive">Danger zone</h2>
          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
            <div className="space-y-0.5">
              <p className="text-[13px] font-medium">Delete this playlist</p>
              <p className="text-xs text-muted-foreground">
                Removes all categories and channel selections. The output URLs stop working.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Form method="post">
                    <AlertDialogAction
                      type="submit"
                      name="intent"
                      value="deletePlaylist"
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </Form>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </section>
      </div>
    </div>
  );
}

type DestinationRowData = DestinationDTO & {
  uploadStatus: "idle" | "uploading" | "ok" | "error";
  lastUploadedAt: string | null;
  uploadError: string | null;
  publicM3uUrl: string | null;
  publicEpgUrl: string | null;
};

function DestinationRow({ destination }: { destination: DestinationRowData }) {
  const upload = useFetcher();
  const del = useFetcher();
  const uploading =
    destination.uploadStatus === "uploading" ||
    upload.state !== "idle";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{destination.name}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {destination.type}
          </span>
          <UploadStatusBadge status={uploading ? "uploading" : destination.uploadStatus} />
        </div>
        <div className="flex items-center gap-1.5">
          <upload.Form method="post">
            <input type="hidden" name="intent" value="uploadDestination" />
            <input type="hidden" name="id" value={destination.id} />
            <Button type="submit" size="sm" variant="secondary" disabled={uploading}>
              <Upload className={uploading ? "size-4 animate-pulse" : "size-4"} />
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </upload.Form>
          <DestinationDialog
            destination={destination}
            trigger={
              <Button size="sm" variant="ghost">
                <Pencil className="size-4" />
              </Button>
            }
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                <Trash2 className="size-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {destination.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Bouquet stops uploading here. Files already uploaded are left in place.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    del.submit(
                      { intent: "deleteDestination", id: destination.id },
                      { method: "post" },
                    )
                  }
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {destination.uploadError ? (
        <p className="text-xs text-destructive">{destination.uploadError}</p>
      ) : destination.lastUploadedAt ? (
        <p className="text-xs text-muted-foreground">
          Last uploaded <RelativeTime date={destination.lastUploadedAt} />
        </p>
      ) : null}

      {destination.publicM3uUrl && destination.publicEpgUrl ? (
        <div className="space-y-3">
          <CopyField label="Public M3U" url={destination.publicM3uUrl} />
          <CopyField label="Public EPG" url={destination.publicEpgUrl} />
        </div>
      ) : null}
    </div>
  );
}

