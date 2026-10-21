import { ArrowLeft, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, useActionData, useFetcher } from "react-router";
import { toast } from "sonner";
import type { PlaylistSettingsData } from "~/api/types/PlaylistSettingsData";
import { apiAction, apiLoad } from "~/lib/api";
import { CopyField } from "~/components/copy-field";
import { PageHeader } from "~/components/page-header";
import {
  DestinationDialog,
  type DestinationDTO,
} from "~/components/playlists/destination-dialog";
import { UploadStatusBadge } from "~/components/playlists/upload-status-badge";
import { RelativeTime } from "~/components/relative-time";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
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
import type { Route } from "./+types/playlists.$id.settings";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Settings · ${loaderData?.playlist.name ?? "Playlist"} · Bouquet` }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<PlaylistSettingsData>(request);
}

type ActionResult =
  | { ok: true; intent: string }
  | { ok: false; error: string; intent?: string };

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<ActionResult>(request);
}
export default function PlaylistSettings({ loaderData }: Route.ComponentProps) {
  const { playlist, m3uUrl, epgUrl, destinations } = loaderData;
  const actionData = useActionData<typeof clientAction>();

  // Keep status badges live while an upload is running in the background.
  useLiveRevalidate(destinations.some((d) => d.uploadStatus === "uploading"));

  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.ok) {
      const messages: Record<string, string> = {
        setAltTemplate: "Naming saved",
        setChannelTemplate: "Naming saved",
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
          <h2 className="text-[13px] font-medium">Channel naming</h2>
          <p className="text-[13px] text-muted-foreground">
            How every channel that isn't an alternate is named.{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{name}"}</code>{" "}
            is the channel's name,{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">{"{provider}"}</code>{" "}
            is its provider name and{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-xs">
              {"{provider_letter}"}
            </code>{" "}
            is that name's first letter. Alternates are named from the plain
            channel name, so the provider isn't repeated.
          </p>
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="setChannelTemplate" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="channel-template" className="sr-only">
                Channel naming template
              </Label>
              <Input
                id="channel-template"
                name="channelNameTemplate"
                defaultValue={playlist.channelNameTemplate}
                placeholder="{name}"
              />
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

