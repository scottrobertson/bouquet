import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, data, redirect, useActionData } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "~/components/copy-field";
import { PageHeader } from "~/components/page-header";
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
import { playlists } from "~/db/schema";
import { getPlaylist } from "~/services/playlist/queries.server";
import { invalidate } from "~/services/output/cache.server";
import type { Route } from "./+types/playlists.$id.settings";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Settings · ${loaderData?.playlist.name ?? "Playlist"} · Bouquet` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });

  const origin = externalOrigin(request);
  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      altNameTemplate: playlist.altNameTemplate,
      smartSortPrefer: playlist.smartSortPrefer,
      smartSortAudio: playlist.smartSortAudio,
      smartSortAvailableFirst: playlist.smartSortAvailableFirst,
    },
    m3uUrl: `${origin}/output/m3u/${playlist.outputToken}`,
    epgUrl: `${origin}/output/epg/${playlist.outputToken}`,
  };
}

const nameSchema = z.string().trim().min(1, "Name is required");

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

  if (intent === "deletePlaylist") {
    db.delete(playlists).where(eq(playlists.id, id)).run();
    return redirect("/playlists");
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function PlaylistSettings({ loaderData }: Route.ComponentProps) {
  const { playlist, m3uUrl, epgUrl } = loaderData;
  const actionData = useActionData<typeof action>();

  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.ok) {
      const messages: Record<string, string> = {
        setAltTemplate: "Naming saved",
        setSmartSort: "Smart sort saved",
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
            is the alternate number.
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

